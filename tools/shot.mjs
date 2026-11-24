/**
 * 单点截图 + 布局测量（调试视觉问题专用）。
 *
 * 用法：
 *   node tools/shot.mjs calendar      # 日历视图
 *   node tools/shot.mjs editor        # 打开事件编辑器并量它的盒模型
 *   node tools/shot.mjs habits        # 打卡列表
 *   VIEW=375 node tools/shot.mjs editor   # 窄视口（手机宽度）
 *
 * 前置：服务端 :3000、前端 :5173 已启动。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const VIEW = process.env.VIEW ? Number(process.env.VIEW) : 0;

// 本地开发库的登录口令，从环境变量读，不写进仓库——这个仓库是公开的。
// 用法：GRID_TEST_PASSWORD=你的口令 node tools/shot.mjs calendar
const TEST_EMAIL = process.env.GRID_TEST_EMAIL ?? 'me@example.com';
const TEST_PASSWORD = process.env.GRID_TEST_PASSWORD;
if (!TEST_PASSWORD) {
  console.error('[shot] 需要 GRID_TEST_PASSWORD 环境变量（本地开发库的登录口令）');
  process.exit(1);
}
const WHAT = process.argv[2] ?? 'calendar';

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();

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
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        console.error('[页面异常]', d?.exception?.description ?? d?.text ?? 'unknown');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        console.error('[console.error]', msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.id && cdp.#pending.has(msg.id)) {
        const { resolve, reject } = cdp.#pending.get(msg.id);
        cdp.#pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
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

  close() {
    this.#ws.close();
  }
}

const profile = mkdtempSync(join(tmpdir(), 'grid-shot-'));
const browser = spawn(
  CANDIDATES.find((p) => existsSync(p)),
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 等调试端口
  let version = null;
  for (let i = 0; i < 60 && version === null; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) version = await res.json();
    } catch {
      /* 还没起来 */
    }
    if (version === null) await sleep(200);
  }
  if (version === null) throw new Error('浏览器调试端口没起来');

  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEW || 1280,
    height: 860,
    deviceScaleFactor: 2,
    mobile: false,
  });

  const evaluate = async (body) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.navigate', { url: APP });
  for (let i = 0; i < 100; i += 1) {
    if (await evaluate("return Boolean(document.querySelector('input'));").catch(() => false)) break;
    await sleep(200);
  }

  // 直接打接口登录，省掉模拟打字
  const login = await evaluate(`
    const s = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json());
    const res = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrfToken },
      body: JSON.stringify({ email: ${JSON.stringify(TEST_EMAIL)}, password: ${JSON.stringify(TEST_PASSWORD)} }),
    });
    const text = await res.text();
    return res.status + ' ' + text.slice(0, 200);
  `);
  console.log('登录:', login);
  await send('Page.navigate', { url: APP });
  await sleep(2000);
  const stillLogin = await evaluate("return Boolean(document.querySelector('input[type=\\\"password\\\"]'));");
  console.log('仍是登录页:', stillLogin);

  // 切视图
  const navLabel = { calendar: '日历', habits: '打卡', editor: '日历' }[WHAT];
  if (navLabel) {
    const ok = await evaluate(`
      const btn = document.querySelector('nav[aria-label="主导航"] button[aria-label="${navLabel}"]');
      if (!btn) return false;
      btn.click();
      return true;
    `);
    console.log('切换导航:', navLabel, ok);
    await sleep(1500);
  }

  if (WHAT === 'editor') {
    // 点第一个事件块把它打开
    const clicked = await evaluate(`
      const blocks = [...document.querySelectorAll('[data-kind]')];
      const el = blocks.find(b => b.dataset.kind === 'event') ?? blocks[0];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }));
      el.click();
      return el.dataset.kind;
    `);
    console.log('点到的块:', clicked);
    await sleep(800);
  }

  // 横向溢出扫描：截图看不出来的"被挤压/被裁"都在这里
  const overflow = await evaluate(`
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el instanceof SVGElement) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const scrollable = ['auto', 'scroll'].includes(cs.overflowX);
      // 已经用省略号收口的（标题单行截断）scrollWidth 必然大于 clientWidth，不算问题
      if (cs.textOverflow === 'ellipsis' && cs.overflowX === 'hidden') continue;
      const spill = !scrollable && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0;
      const outside = r.right > vw + 1 || r.left < -1;
      if (!spill && !outside) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className?.baseVal ?? el.className ?? '').toString().slice(0, 48),
        text: (el.textContent ?? '').trim().slice(0, 28),
        clientW: el.clientWidth, scrollW: el.scrollWidth,
        left: Math.round(r.left), right: Math.round(r.right),
        kind: spill ? '内容溢出容器' : '超出视口',
      });
    }
    return { vw, count: out.length, items: out.slice(0, 18) };
  `);
  console.log('\n横向溢出:', overflow.count, '处（视口宽', overflow.vw, '）');
  for (const it of overflow.items) {
    console.log(`  ${it.kind}  <${it.tag}> ${it.cls}  x:[${it.left},${it.right}]  w:${it.clientW}/${it.scrollW}  "${it.text}"`);
  }

  // 量一下弹层盒模型
  const metrics = await evaluate(`
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { dialog: null };
    const cs = getComputedStyle(dlg);
    const r = dlg.getBoundingClientRect();
    const first = dlg.firstElementChild;
    const fr = first?.getBoundingClientRect();
    return {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      padding: cs.padding,
      border: cs.borderWidth,
      firstChild: first?.className,
      firstChildRect: fr ? { x: Math.round(fr.x), y: Math.round(fr.y) } : null,
      insetFromPanel: fr ? { left: Math.round(fr.x - r.x), top: Math.round(fr.y - r.y) } : null,
      overlayPad: getComputedStyle(dlg.parentElement).padding,
    };
  `);
  console.log(JSON.stringify(metrics, null, 2));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = `.data/shot-${WHAT}${VIEW ? `-${VIEW}` : ''}.png`;
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('截图:', out);
  cdp.close();
} finally {
  browser.kill();
}
