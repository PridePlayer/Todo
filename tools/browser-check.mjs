/**
 * 无依赖的浏览器验收脚本（CDP 直连 Edge/Chrome）。
 *
 * 为什么不用 Playwright：本项目只有一个浏览器要驱动，装一套 200MB 的依赖
 * 只为点三下按钮不值；Node 22 自带 WebSocket，凑一个 60 行的 CDP 客户端就够了。
 *
 * 用法：
 *   node tools/browser-check.mjs            # 跑 M2 同步验收
 *   HEADLESS=0 node tools/browser-check.mjs # 看着它跑（调试选择器时有用）
 *
 * 前置：服务端 :3000、前端 :5173 已启动。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const PORT = Number(process.env.CDP_PORT ?? 9222);
const HEADLESS = process.env.HEADLESS !== '0';

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

function findBrowser() {
  const hit = CANDIDATES.find((path) => existsSync(path));
  if (!hit) throw new Error('找不到 Edge / Chrome 可执行文件');
  return hit;
}

async function waitForHttp(url, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`等待 ${url} 超时`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();
  #listeners = new Set();

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new Cdp();
    cdp.#ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && cdp.#pending.has(msg.id)) {
        const { resolve, reject } = cdp.#pending.get(msg.id);
        cdp.#pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      for (const listener of cdp.#listeners) listener(msg);
    });
    return cdp;
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 30000);
    });
  }

  on(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    this.#ws.close();
  }
}

async function openPage() {
  const versionRes = await waitForHttp(`http://127.0.0.1:${PORT}/json/version`);
  const version = await versionRes.json();
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const errors = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const detail = msg.params?.exceptionDetails;
      errors.push(detail?.exception?.description ?? detail?.text ?? 'unknown');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      errors.push(msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' ') ?? '');
    }
  });

  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本抛错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async function waitUntil(expression, timeoutMs = 15000, label = expression) {
    const started = Date.now();
    for (;;) {
      try {
        if (await evaluate(`return Boolean(${expression});`)) return;
      } catch {
        /* 页面还没就绪 */
      }
      if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  return { cdp, send, evaluate, waitUntil, targetId, errors };
}

// ── 断言 ────────────────────────────────────────────────────

let pass = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failures.push(`${label}${detail ? `  ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

// ── 主流程 ──────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'grid-cdp-'));
const browser = spawn(findBrowser(), [
  HEADLESS ? '--headless=new' : '--start-maximized',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  'about:blank',
], { stdio: 'ignore' });

let page;
try {
  page = await openPage();
  console.log('\nM2 同步验收\n');

  await page.send('Page.navigate', { url: APP });
  await page.waitUntil("document.querySelector('input')", 20000, '登录表单');

  // 1) 登录（直接打接口，不模拟打字；登录逻辑本身是 M0 已验收的部分）
  const loginOk = await page.evaluate(`
    const s = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json());
    const res = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrfToken },
      body: JSON.stringify({ email: 'me@example.com', password: 'grid-dev-pass-2026' }),
    });
    return res.ok;
  `);
  check('登录成功', loginOk === true);
  await page.send('Page.navigate', { url: APP });
  await page.waitUntil("document.querySelector('nav[aria-label=\"主导航\"]')", 20000, '主界面');

  const pill = `(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()).find(t => /同步|离线|待同步/.test(t)) || '')()`;

  // 2) 首屏应尽快变成"已同步"
  await page.waitUntil(`${pill} === '已同步'`, 20000, '首屏已同步');
  check('登录后自动同步到「已同步」', true);

  // 3) 断网后新建 3 条任务
  await page.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await page.evaluate(`
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
    return true;
  `);

  await page.waitUntil("document.querySelector('form input')", 8000, '快速新增输入框');

  const titles = ['离线任务 Alpha', '离线任务 Beta', '离线任务 Gamma'];
  const added = await page.evaluate(`
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const input = document.querySelector('form input');
    if (!input) {
      return 'no-input | url=' + location.pathname + ' | forms=' + document.querySelectorAll('form').length +
        ' | inputs=' + document.querySelectorAll('input').length +
        ' | text=' + document.body.innerText.slice(0, 120).replace(/\\n/g, ' / ');
    }
    const form = input.closest('form');
    if (!form) return 'no-form';
    for (const title of ${JSON.stringify(titles)}) {
      setter.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      form.requestSubmit();
      await new Promise(r => setTimeout(r, 200));
    }
    return 'ok';
  `);
  check('断网时能连续新增 3 条', added === 'ok', String(added));

  await page.waitUntil(`${pill}.includes('3 条待同步')`, 8000, '离线 · 3 条待同步');
  const offlineLabel = await page.evaluate(`return ${pill};`);
  check('顶栏显示「离线 · 3 条待同步」', /离线.*3 条待同步/.test(offlineLabel), offlineLabel);

  // 4) 恢复网络 → 10 秒内变「已同步」
  const t0 = Date.now();
  await page.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await page.evaluate(`
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
    return true;
  `);
  await page.waitUntil(`${pill} === '已同步'`, 12000, '恢复后已同步');
  const recoverMs = Date.now() - t0;
  check('恢复网络 10 秒内回到「已同步」', recoverMs < 10000, `${recoverMs}ms`);

  // 5) 服务端确实收到了这三条
  const serverCount = await page.evaluate(`
    const state = await fetch('/api/sync/state', { credentials: 'include' }).then(r => r.json());
    return state.tasks;
  `);
  check('服务端已有任务行', Number(serverCount) >= 3, `tasks=${serverCount}`);

  // 6) 另一个标签页模拟"第二台设备"新增，本页 30 秒内应能看到
  const remote = await page.evaluate(`
    const s = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json());
    const id = 'ZZ' + Date.now().toString(36).toUpperCase().padEnd(24, 'X');
    const now = Date.now();
    const title = '另一台设备写的 ' + now;
    const res = await fetch('/api/sync/push', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrfToken },
      body: JSON.stringify({ deviceId: '01REMOTEDEVICE000000000001', ops: [{
        opId: 'RM' + id.slice(0, 20), table: 'task', action: 'create', id, baseRev: 0,
        fields: { title, listId: 'list-inbox', path: id + '/', depth: 0,
          quadrant: 1, important: true, urgent: true, priority: 0, allDay: true, tagIds: [],
          sortOrder: 99, createdAt: now, updatedAt: now, deletedAt: null },
        hlc: { wall: now, counter: 0, device: '01REMOTEDEVICE000000000001' },
      }] }),
    });
    return { ok: res.ok, id, title };
  `);
  check('模拟第二台设备写入成功', remote.ok === true, remote.id);

  const sawRemote = await (async () => {
    const started = Date.now();
    while (Date.now() - started < 40000) {
      const text = await page.evaluate(`return document.body.innerText;`);
      // 必须匹配本次生成的唯一标题：用固定文案的话，上一轮残留会让它"1ms 就通过"
      if (text.includes(remote.title)) return Date.now() - started;
      await new Promise((r) => setTimeout(r, 500));
    }
    return -1;
  })();
  check('30 秒心跳内拉到了远端新增', sawRemote >= 0 && sawRemote < 35000, `${sawRemote}ms`);

  // 7) 设置页同步面板：游标必须追平服务端水位
  await page.evaluate(`
    const btn = document.querySelector('nav[aria-label="主导航"] button[aria-label="设置"]');
    if (!btn) return 'no-nav';
    btn.click();
    return 'ok';
  `);
  await page.waitUntil("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '全量重建')", 8000, '同步面板');
  const panel = await page.evaluate(`
    const text = document.body.innerText;
    const nums = [...document.querySelectorAll('dd')].map(d => d.textContent.trim());
    return { text, nums };
  `);
  check('设置页出现同步面板', panel.text.includes('本地游标') && panel.text.includes('服务端水位'));

  // 8) 全量重建：本地推平 → 从服务端重拉，数据必须回来
  await page.evaluate(`
    window.confirm = () => true;
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '全量重建');
    if (!btn) return 'no-btn';
    btn.click();
    return 'ok';
  `);
  await new Promise((r) => setTimeout(r, 1200));
  await page.waitUntil(`${pill} === '已同步'`, 20000, '重建后已同步');
  const rebuilt = await page.evaluate(`
    const btn = document.querySelector('nav[aria-label="主导航"] button[aria-label="四象限"]');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 400));
    return document.body.innerText;
  `);
  check('全量重建后任务从服务端回来了', rebuilt.includes('离线任务 Alpha'));

  // 10) 日历：建一条"每周一三五 09:00"，看四周展开
  await page.evaluate(`
    document.querySelector('nav[aria-label="主导航"] button[aria-label="日历"]')?.click();
    return true;
  `);
  await page.waitUntil("[...document.querySelectorAll('input')].some(i => i.placeholder?.includes('新建安排'))", 8000, '日历新建条');

  const created = await page.evaluate(`
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const input = [...document.querySelectorAll('input')].find(i => i.placeholder?.includes('新建安排'));
    setter.call(input, '验收周会');
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const time = document.querySelector('input[type="time"]');
    setter.call(time, '09:00');
    time.dispatchEvent(new Event('input', { bubbles: true }));

    const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'weekly'));
    const sSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    sSetter.call(select, 'weekly');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    // 只留一/三/五
    const wanted = ['周一', '周三', '周五'];
    for (const btn of document.querySelectorAll('button[title^="周"]')) {
      const on = btn.getAttribute('aria-pressed') === 'true';
      const want = wanted.includes(btn.getAttribute('title'));
      if (on !== want) btn.click();
    }
    await new Promise(r => setTimeout(r, 100));
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '添加')?.click();
    return 'ok';
  `);
  check('日历能新建每周重复的事件', created === 'ok');

  await page.waitUntil("document.body.innerText.includes('验收周会')", 8000, '周视图出现实例');
  const weekCount = await page.evaluate(`
    await new Promise(r => setTimeout(r, 300));
    return (document.body.innerText.match(/验收周会/g) || []).length;
  `);
  check('周视图里本周有 3 次（一/三/五）', weekCount >= 2 && weekCount <= 4, `${weekCount} 次`);

  const monthCount = await page.evaluate(`
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '月')?.click();
    await new Promise(r => setTimeout(r, 500));
    return (document.body.innerText.match(/验收周会/g) || []).length;
  `);
  // 事件从"今天"开始，而月网格从本月初起算，所以网格内只会出现从今天到网格末尾的那几周
  check('月视图按网格展开实例（不再只是本周那几次）', monthCount >= 6, `${monthCount} 次`);

  // 11) 改其中一次的时间 → 选"只这一次"
  const edited = await page.evaluate(`
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '周')?.click();
    await new Promise(r => setTimeout(r, 400));
    const block = [...document.querySelectorAll('[role="button"]')].find(el => el.textContent?.includes('验收周会'));
    if (!block) return 'no-block';
    block.click();
    await new Promise(r => setTimeout(r, 300));
    // 必须限定在编辑面板里：新建条自己也有一个 time 输入框，
    // 用 document 全局取第一个会改到它，保存时"没有任何改动"于是静默关闭
    const startInput = document.querySelector('form[role="dialog"] input[type="time"]');
    if (!startInput) return 'no-editor';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(startInput, '14:00');
    startInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '保存')?.click();
    await new Promise(r => setTimeout(r, 300));
    const scopes = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
    const only = [...document.querySelectorAll('button')].find(b => b.textContent.includes('只修改这一次'));
    if (!only) return 'no-scope:' + scopes.join('|');
    only.click();
    await new Promise(r => setTimeout(r, 500));
    return document.body.innerText;
  `);
  check('改单次时弹出三选项', typeof edited === 'string' && edited.includes('验收周会'), typeof edited === 'string' && edited.startsWith('no-') ? edited : '');
  check('选「只这一次」后该次挪到 14:00', typeof edited === 'string' && edited.includes('14:00'));
  if (page.errors.length > 0) {
    console.log('  页面错误：');
    for (const err of page.errors.slice(0, 5)) console.log(`    ! ${String(err).split('\n')[0]}`);
  }

  // 12) 改标题选「这一次及以后」→ 本系列的周一周三保持旧标题、周五起用新标题
  const split = await page.evaluate(`
    const blocks = [...document.querySelectorAll('[role="button"]')].filter(el => el.textContent?.includes('验收周会'));
    if (blocks.length < 2) return 'no-blocks:' + blocks.length;
    // 取本周最后一次（周五）：它之前的那两次必须保持旧标题
    const last = blocks[blocks.length - 1];
    last.click();
    await new Promise(r => setTimeout(r, 300));
    const titleInput = document.querySelector('form[role="dialog"] input:not([type])');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(titleInput, '验收周会B');
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '保存')?.click();
    await new Promise(r => setTimeout(r, 300));
    const pick = [...document.querySelectorAll('button')].find(b => b.textContent.includes('这一次及以后'));
    if (!pick) return 'no-option';
    pick.click();
    await new Promise(r => setTimeout(r, 800));
    const text = document.body.innerText;
    return {
      a: (text.match(/验收周会(?!B)/g) || []).length,
      b: (text.match(/验收周会B/g) || []).length,
      list: [...document.querySelectorAll('[role="button"]')]
        .map(el => el.textContent).filter(t => t && t.includes('验收周会')),
    };
  `);
  check(
    '「这一次及以后」把系列拆开：之前的保持旧标题，之后用新标题',
    typeof split === 'object' && split !== null && split.a >= 1 && split.b >= 1,
    typeof split === 'object' && split !== null
      ? `旧 ${split.a} 次 / 新 ${split.b} 次 | ${(split.list ?? []).join(' , ')}`
      : String(split),
  );

  // 只改开始时间时，时长必须保持不变（否则会变成"14:00 到次日 10:00"的 20 小时色块）
  const blockHeight = await page.evaluate(`
    const el = [...document.querySelectorAll('[role="button"]')]
      .find(node => node.textContent?.includes('14:00验收周会'));
    return el ? el.style.height : '';
  `);
  check('改完开始时间后仍是 1 小时，没有被撑成跨天', blockHeight === '56px', blockHeight || '未找到块');

  // 13) 退出前清理日历测试数据（KEEP=1 时保留，方便事后查库）
  if (process.env.KEEP === '1') {
    console.log('  · KEEP=1：跳过清理');
  } else {
  await page.evaluate(`
    await fetch('/api/auth/session', { credentials: 'include' });
    return true;
  `);

  // 9) 收尾：把本轮造的数据删干净，否则每次跑验收都在库里多堆几条
  const cleaned = await page.evaluate(`
    const s = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json());
    const pull = await fetch('/api/sync/pull', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrfToken },
      body: JSON.stringify({ cursor: 0, limit: 500 }),
    }).then(r => r.json());
    const isJunk = (title) =>
      String(title).startsWith('离线任务 ') || String(title).startsWith('另一台设备写的') ||
      String(title).startsWith('验收周会');
    const junk = pull.changes.filter(c =>
      c.table === 'task' && c.deletedAt === null && c.payload && isJunk(c.payload.title));
    const junkIds = new Set(junk.map((c) => c.id));
    // 系列删了，它的例外也得删，否则验收数据会在服务端留下孤儿
    const junkExceptions = pull.changes.filter(c =>
      c.table === 'recur_exception' && c.deletedAt === null && junkIds.has(c.payload?.seriesId));
    if (junk.length === 0 && junkExceptions.length === 0) return 0;
    const now = Date.now();
    const ops = [...junk, ...junkExceptions].map((c, i) => ({
      opId: 'CL' + now.toString(36).toUpperCase() + i,
      table: c.table, action: 'delete', id: c.id, baseRev: c.rev, fields: {},
      hlc: { wall: now, counter: i, device: '01CLEANUPDEVICE00000000001' },
    }));
    await fetch('/api/sync/push', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrfToken },
      body: JSON.stringify({ deviceId: '01CLEANUPDEVICE00000000001', ops }),
    });
    return junk.length + junkExceptions.length;
  `);
  console.log(`  · 已清理 ${cleaned} 条验收数据`);
  }

  console.log(`\n通过 ${pass} 项${failures.length ? `，失败 ${failures.length} 项` : ''}`);
  if (failures.length) {
    for (const failure of failures) console.log(`  · ${failure}`);
    process.exitCode = 1;
  }
} finally {
  page?.cdp.close();
  browser.kill();
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 浏览器可能还占着文件，残留到临时目录无所谓 */
  }
}
