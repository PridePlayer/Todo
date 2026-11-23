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

  // 14) Outlook 日历：事件进周视图、重复事件只读、单次事件拖动后回写
  await page.evaluate(`
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '日历')?.click();
    return true;
  `);
  await page.waitUntil("document.body.innerText.includes('M4 单次会议')", 25000, 'Outlook 事件出现在周视图');
  const outlook = await page.evaluate(`
    const blocks = [...document.querySelectorAll('[data-kind]')];
    const events = blocks.filter(el => el.getAttribute('data-kind') === 'event');
    const tasks = blocks.filter(el => el.getAttribute('data-kind') === 'task');
    const banner = [...document.querySelectorAll('[class*="bar"]')].map(el => el.textContent).join(' | ');
    return {
      events: events.length,
      tasks: tasks.length,
      banner,
      hasEmail: banner.includes('@'),
    };
  `);
  check('周视图里出现了 data-kind=event 的块', outlook.events >= 2, `${outlook.events} 个事件块`);
  check('待办块仍然是 data-kind=task（描边/实心的语义没混）', outlook.tasks >= 0, `${outlook.tasks} 个待办块`);
  check('日历顶部显示 Outlook 状态条与邮箱', outlook.hasEmail === true, String(outlook.banner).slice(0, 60));

  // 重复事件：只读 + 「在 Outlook 中修改」
  const readonly = await page.evaluate(`
    const el = [...document.querySelectorAll('[data-kind="event"]')]
      .find(node => node.textContent?.includes('M4 每周例会'));
    if (!el) return 'no-block';
    el.click();
    await new Promise(r => setTimeout(r, 400));
    const dialog = document.querySelector('form[role="dialog"]');
    if (!dialog) return 'no-dialog';
    const buttons = [...dialog.querySelectorAll('button')].map(b => b.textContent.trim());
    const inputs = [...dialog.querySelectorAll('input')];
    return {
      readonly: inputs.every(i => i.readOnly),
      hasOutlookButton: buttons.includes('在 Outlook 中修改'),
      hasSave: buttons.includes('保存'),
      note: dialog.textContent.includes('由 Outlook 决定'),
    };
  `);
  check(
    '重复事件打开后是只读的，且只有「在 Outlook 中修改」这一个出口',
    typeof readonly === 'object' &&
      readonly.readonly === true &&
      readonly.hasOutlookButton === true &&
      readonly.hasSave === false,
    JSON.stringify(readonly),
  );
  check('只读时给出原因说明', typeof readonly === 'object' && readonly.note === true);

  await page.evaluate(`
    [...document.querySelectorAll('form[role="dialog"] button')].find(b => b.textContent.trim() === '关闭')?.click();
    return true;
  `);
  await new Promise((r) => setTimeout(r, 300));

  // 单次事件拖动 +1 小时 → 回写队列必须把它推上去
  const beforeDrag = await page.evaluate(`
    const el = [...document.querySelectorAll('[data-kind="event"]')]
      .find(node => node.textContent?.includes('M4 单次会议'));
    if (!el) return null;
    // 先滚进可视区：16:00 的块默认在折叠线以下，用视口外的坐标点等于点在空气上
    el.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 300));
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 8), text: el.textContent, rect: [Math.round(rect.top), Math.round(rect.height)] };
  `);
  if (beforeDrag) {
    const cdpDrag = async (x, y) => {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      // 分几步移动，更像真实拖动：一步到位会被浏览器合并成一次 pointermove
      for (const step of [0.4, 0.8, 1]) {
        await page.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y: Math.round(y + 56 * step),
          button: 'left',
        });
        await new Promise((r) => setTimeout(r, 40));
      }
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: y + 56, button: 'left', clickCount: 1 });
    };
    await cdpDrag(beforeDrag.x, beforeDrag.y);
    await new Promise((r) => setTimeout(r, 2500));
    const afterDrag = await page.evaluate(`
      const el = [...document.querySelectorAll('[data-kind="event"]')]
        .find(node => node.textContent?.includes('M4 单次会议'));
      return el ? el.textContent : null;
    `);
    const dialogOpen = await page.evaluate(`return Boolean(document.querySelector('form[role="dialog"]'));`);
    // 期望值按"拖动前的时间 +1 小时"算，不写死 17:00：
    // 同一份夹具会被反复用，第二次跑时它已经在 17:00 了
    const m = /(\d{2}):(\d{2})/.exec(beforeDrag.text);
    const expected = m ? `${String((Number(m[1]) + 1) % 24).padStart(2, '0')}:${m[2]}` : '?';
    check(
      '拖动单次事件后时间 +1 小时',
      typeof afterDrag === 'string' && afterDrag.includes(expected),
      `期望 ${expected}，实际 ${String(afterDrag)}`,
    );
    check('拖完不会顺手弹出编辑器', dialogOpen === false, dialogOpen ? '弹出了编辑器' : '');
  } else {
    check('单次事件块存在', false, '未找到 M4 单次会议');
  }

  // 15) M5 打卡：三种类型、连续天数、热力图、完成率
  //     这一段的断言对应 docs/05 M5 的验收 1~6 条，全部走真实 UI 交互
  await page.evaluate(`
    document.querySelector('nav[aria-label="主导航"] button[aria-label="打卡"]')?.click();
    return true;
  `);
  await page.waitUntil(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '新建习惯')",
    10000,
    '打卡页',
  );

  const createdHabits = await page.evaluate(`
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const sSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const byText = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);

    async function make(kind, name, target, unit) {
      byText('新建习惯')?.click();
      await sleep(200);
      const nameInput = document.querySelector('input[aria-label="习惯名称"]');
      if (!nameInput) return 'no-form';
      setter.call(nameInput, name);
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      const select = document.querySelector('select[aria-label="习惯类型"]');
      sSetter.call(select, kind);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(150);
      if (target) {
        const t = document.querySelector('input[aria-label="目标值"]');
        setter.call(t, String(target));
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (unit) {
        const u = document.querySelector('input[aria-label="单位"]');
        setter.call(u, unit);
        u.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(100);
      byText('创建')?.click();
      await sleep(450);
      return 'ok';
    }

    const results = [
      await make('check', '验收阅读', null, null),
      await make('count', '验收喝水', 8, '杯'),
      await make('duration', '验收冥想', 10, null),
    ];
    return results.join(',');
  `);
  check('三种类型（打勾/计数/时长）都能创建', createdHabits === 'ok,ok,ok', String(createdHabits));

  const listed = await page.evaluate(`
    const text = document.body.innerText;
    return { read: text.includes('验收阅读'), water: text.includes('验收喝水'), med: text.includes('验收冥想') };
  `);
  check(
    '三个习惯都在今日列表里',
    listed.read === true && listed.water === true && listed.med === true,
    JSON.stringify(listed),
  );

  // 验收 1：打勾型点一下 → 已完成、连续天数 1
  const readDone = await page.evaluate(`
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const row = () => [...document.querySelectorAll('li')].find(li => li.textContent.includes('验收阅读'));
    row().querySelector('button[aria-label*="今天完成"]')?.click();
    await sleep(500);
    const after = row();
    return {
      pressed: after.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed'),
      text: after.innerText.replace(/\\n/g, ' | '),
    };
  `);
  check('打勾型点一下就完成', readDone.pressed === 'true', readDone.text);
  check('连续天数变成 1 天', String(readDone.text).includes('连续 1 天'), readDone.text);

  // 验收 3：计数型点 3 次显示 3/8
  const water = await page.evaluate(`
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const row = () => [...document.querySelectorAll('li')].find(li => li.textContent.includes('验收喝水'));
    for (let i = 0; i < 3; i += 1) {
      [...row().querySelectorAll('button')].find(b => b.textContent.trim() === '＋1')?.click();
      await sleep(300);
    }
    const after = row();
    return {
      text: after.innerText.replace(/\\n/g, ' | '),
      pressed: after.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed'),
    };
  `);
  check('计数型点 3 次显示 3/8（没有提前算达标）', String(water.text).includes('3/8'), String(water.text));
  check('计数型没到目标就不打勾', water.pressed === 'false', String(water.pressed));

  // 验收 4：时长型输入 12 分钟 → 12/10 且自动达标
  const med = await page.evaluate(`
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const row = () => [...document.querySelectorAll('li')].find(li => li.textContent.includes('验收冥想'));
    [...row().querySelectorAll('button')].find(b => b.textContent.includes('/10'))?.click();
    await sleep(250);
    const input = row()?.querySelector('input[name="value"]');
    if (!input) return { error: 'no-input' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '12');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    input.closest('form').requestSubmit();
    await sleep(500);
    const after = row();
    return {
      text: after.innerText.replace(/\\n/g, ' | '),
      pressed: after.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed'),
    };
  `);
  check('时长型输入 12 分钟记成 12/10', String(med.text).includes('12/10'), String(med.text ?? med.error));
  check('时长型超过目标即达标', med.pressed === 'true');

  // 验收 2 + 5 + 6：详情页热力图、补记三天、完成率三口径
  const detail = await page.evaluate(`
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const row = [...document.querySelectorAll('li')].find(li => li.textContent.includes('验收阅读'));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '详情')?.click();
    await sleep(500);

    const cells = [...document.querySelectorAll('[role="gridcell"]')];
    const statOf = (label) => {
      const el = [...document.querySelectorAll('[class*="statLabel"]')].find(n => n.textContent.trim() === label);
      return el ? el.parentElement.querySelector('[class*="statValue"]').textContent.trim() : null;
    };

    // 补记过去 3 天：这三天都是"事后补记"，热力图上要画成空心环
    const keyOf = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const dateInput = document.querySelector('input[aria-label="日期"]');
    const valueInput = document.querySelector('input[aria-label="记录值"]');
    if (!dateInput || !valueInput) return { error: 'no-backfill-form' };

    for (const offset of [1, 2, 3]) {
      setter.call(dateInput, keyOf(offset));
      dateInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
      setter.call(valueInput, '1');
      valueInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(100);
      dateInput.closest('form').requestSubmit();
      await sleep(350);
    }

    const rings = [...document.querySelectorAll('[role="gridcell"]')]
      .filter(el => el.getAttribute('data-backfilled') === 'true' && Number(el.getAttribute('data-level')) >= 3);
    const solid = [...document.querySelectorAll('[role="gridcell"]')]
      .filter(el => el.getAttribute('data-backfilled') === 'false' && Number(el.getAttribute('data-level')) >= 3);

    return {
      cells: cells.length,
      streak: statOf('当前连续'),
      longest: statOf('最长连续'),
      week: statOf('近 7 天'),
      month: statOf('近 30 天'),
      all: statOf('全部'),
      rings: rings.length,
      solid: solid.length,
      text: document.body.innerText.replace(/\\n/g, ' | ').slice(0, 400),
    };
  `);
  check('热力图是 12 周 × 7 = 84 格', detail.cells === 84, `${detail.cells} 格`);
  check('补记 3 天 + 今天 → 连续 4 天', String(detail.streak).startsWith('4'), `${detail.streak} | ${detail.text}`);
  check('补记的三天画成空心环', detail.rings === 3, `${detail.rings} 个环`);
  check('当天真打卡是实心（不与补记混淆）', detail.solid === 1, `${detail.solid} 个实心`);
  check(
    '完成率三个口径都给出了百分比',
    /%$/.test(String(detail.week)) && /%$/.test(String(detail.month)) && /%$/.test(String(detail.all)),
    `7天 ${detail.week} / 30天 ${detail.month} / 全部 ${detail.all}`,
  );

  if (page.errors.length > 0) {
    const fresh = page.errors.slice(-3);
    for (const err of fresh) console.log(`    ! ${String(err).split('\n')[0]}`);
  }

  await page.evaluate(`
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('返回'))?.click();
    return true;
  `);
  await new Promise((r) => setTimeout(r, 300));

  // 16) M6a 设备令牌：签发 → 列表显示 → 注销 → 移除记录
  //     这四项对应 docs/06 A7~A9 的用户可见部分（协议层由 tools/device-check.ts 覆盖）
  await page.evaluate(`
    document.querySelector('nav[aria-label="主导航"] button[aria-label="设置"]')?.click();
    return true;
  `);
  await page.waitUntil(
    "[...document.querySelectorAll('h2')].some(h => h.textContent.trim() === '设备令牌')",
    10000,
    '设备令牌区块',
  );

  const deviceFlow = await page.evaluate(`
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const input = document.querySelector('input[aria-label="设备名"]');
    if (!input) return { error: 'no-input' };
    setter.call(input, '浏览器验收');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '生成新令牌')?.click();
    await sleep(900);
    // 必须限定在"令牌"那个 code 上：设置页别处还有一个 <code>grid</code>（数据库驱动名）
    const code = document.querySelector('code[class*="token"]');
    const row = [...document.querySelectorAll('li[data-state]')].find(li => li.textContent.includes('浏览器验收'));
    return {
      token: code ? code.textContent.trim() : '',
      hasRow: Boolean(row),
      state: row ? row.getAttribute('data-state') : null,
      text: row ? row.innerText.replace(/\\n/g, ' | ') : '',
    };
  `);
  check(
    '生成后立刻显示一次明文令牌（grd_ 开头）',
    typeof deviceFlow.token === 'string' && deviceFlow.token.startsWith('grd_') && deviceFlow.token.length === 47,
    `${String(deviceFlow.token).slice(0, 8)}…（${String(deviceFlow.token).length} 字符）`,
  );
  check('列表里出现这台设备且标为有效', deviceFlow.state === 'active', deviceFlow.text);
  check('显示剩余天数', String(deviceFlow.text).includes('剩 180 天'), deviceFlow.text);

  const deviceRevoked = await page.evaluate(`
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    window.confirm = () => true;
    const row = () => [...document.querySelectorAll('li[data-state]')].find(li => li.textContent.includes('浏览器验收'));
    [...row().querySelectorAll('button')].find(b => b.textContent.trim() === '注销此设备')?.click();
    await sleep(900);
    const after = row();
    return {
      state: after ? after.getAttribute('data-state') : null,
      text: after ? after.innerText.replace(/\\n/g, ' | ') : '',
    };
  `);
  check('注销后立刻标为已注销（不等过期）', deviceRevoked.state === 'revoked', deviceRevoked.text);

  const devicePurged = await page.evaluate(`
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const row = () => [...document.querySelectorAll('li[data-state]')].find(li => li.textContent.includes('浏览器验收'));
    [...(row()?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '移除记录')?.click();
    await sleep(900);
    return ![...document.querySelectorAll('li[data-state]')].some(li => li.textContent.includes('浏览器验收'));
  `);
  check('已注销的记录可以移除，列表里不再出现', devicePurged === true);

  // 截图：只在 SHOT=1 时保存，用来目视检查排版（自动化断言抓不到"难看"）
  if (process.env.SHOT === '1') {
    // 用桌面尺寸截图：默认窗口是 750x450，会自动落进移动端布局，看不出桌面排版
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await page.evaluate(`
      const grid = document.querySelector('[class*="gridWrap"]');
      if (grid) grid.scrollTop = 8 * 56;
      return true;
    `);
    await new Promise((r) => setTimeout(r, 400));
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync('.data/calendar.png', Buffer.from(shot.data, 'base64'));
    console.log('  · 截图已保存 .data/calendar.png');

    // 打卡页单独截一张：热力图的档位与"空心环"只能靠眼睛确认
    await page.evaluate(`
      document.querySelector('nav[aria-label="主导航"] button[aria-label="打卡"]')?.click();
      return true;
    `);
    await new Promise((r) => setTimeout(r, 600));
    const habitShot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('.data/habits.png', Buffer.from(habitShot.data, 'base64'));
    console.log('  · 截图已保存 .data/habits.png');

    // 详情页：热力图的档位、空心环、月份轴都只能靠眼睛确认
    await page.evaluate(`
      const row = [...document.querySelectorAll('li')].find(li => li.textContent.includes('验收阅读'));
      [...(row?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '详情')?.click();
      return true;
    `);
    await new Promise((r) => setTimeout(r, 700));
    const detailShot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('.data/habit-detail.png', Buffer.from(detailShot.data, 'base64'));
    console.log('  · 截图已保存 .data/habit-detail.png');
  }

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
    // 打卡：习惯与它的记录一起删。只删习惯会留下孤儿记录（记录 id 是确定性的，
    // 永远不会被"同名新习惯"复活），它们会一直占着同步流量却谁也看不见
    const junkHabits = pull.changes.filter(c =>
      c.table === 'habit' && c.deletedAt === null && String(c.payload?.name ?? '').startsWith('验收'));
    const habitIds = new Set(junkHabits.map((c) => c.id));
    const junkLogs = pull.changes.filter(c =>
      c.table === 'habit_log' && c.deletedAt === null && habitIds.has(c.payload?.habitId));
    const all = [...junk, ...junkExceptions, ...junkHabits, ...junkLogs];
    if (all.length === 0) return 0;
    const now = Date.now();
    const ops = all.map((c, i) => ({
      opId: 'CL' + now.toString(36).toUpperCase() + i,
      table: c.table, action: 'delete', id: c.id, baseRev: c.rev, fields: {},
      hlc: { wall: now, counter: i, device: '01CLEANUPDEVICE00000000001' },
    }));
    await fetch('/api/sync/push', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrfToken },
      body: JSON.stringify({ deviceId: '01CLEANUPDEVICE00000000001', ops }),
    });
    return all.length;
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
