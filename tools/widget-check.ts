/**
 * 桌面小组件读接口的验收脚本（docs/11 §5）。
 *
 * 不需要浏览器、不需要密码：直接在本地库里给第一个用户签一枚 widget 只读令牌，
 * 然后用 Fastify 的 inject 打真实路由。跑完不留下任何数据？
 * 会留下一条 scope='widget' 的 device_token —— 它是这条路正常工作的证据，
 * 下次跑脚本会先把旧的吊销掉（issueWidgetToken 的行为）。
 *
 * 用法：cd packages/server && ./node_modules/.bin/tsx ../../tools/widget-check.ts
 */
// tools/ 不在 pnpm workspace 里，无法解析 @grid/core 的包名；需要时引构建产物
import { buildApp } from '../packages/server/src/app.js';
import { issueWidgetToken } from '../packages/server/src/auth/device-token.js';
import { createDb } from '../packages/server/src/db/index.js';
import { loadEnv } from '../packages/server/src/env.js';

const pad = (n: number): string => String(n).padStart(2, '0');

function localToday(now: Date): { today: string; dayStart: number; dayEnd: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return {
    today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    dayStart: start,
    dayEnd: start + 86_400_000,
  };
}

const env = loadEnv();
const db = createDb(env.dbUrl);
const app = await buildApp({ env, db, startedAt: Date.now(), tokens: null });

const users = await db.query<{ id: string; email: string }>('SELECT id, email FROM app_user LIMIT 1');
const user = users[0];
if (!user) {
  console.error('本地库里没有用户。先跑：pnpm seed:user --email me@example.com --password "至少12位口令"');
  await app.close();
  process.exit(1);
}

const issued = await issueWidgetToken(db, user.id);
const auth = { authorization: `Bearer ${issued.token}` };
const { today, dayStart, dayEnd } = localToday(new Date());

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// 1. 正常读
const res = await app.inject({
  method: 'GET',
  url: `/api/widget/summary?today=${today}&dayStart=${dayStart}&dayEnd=${dayEnd}`,
  headers: auth,
});
check('widget 令牌能读摘要', res.statusCode === 200, `HTTP ${res.statusCode}`);

let summary: Record<string, unknown> | null = null;
try {
  summary = JSON.parse(res.body) as Record<string, unknown>;
} catch {
  summary = null;
}

if (summary) {
  const tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
  const habits = Array.isArray(summary.habits) ? summary.habits : [];
  check('返回 openCount 是数字', typeof summary.openCount === 'number', `openCount=${String(summary.openCount)}`);
  check('tasks 不超过 4 条', tasks.length <= 4, `${tasks.length} 条`);
  check('habits 不超过 4 个', habits.length <= 4, `${habits.length} 个`);
  check('today 原样回显', summary.today === today, `${String(summary.today)}`);
  console.log('\n摘要内容：');
  console.log(JSON.stringify(summary, null, 2));
}

// 2. 反向断言：只读令牌不能碰同步
const denied = await app.inject({
  method: 'POST',
  url: '/api/sync/pull',
  headers: auth,
  payload: { cursor: 0, limit: 10 },
});
check('widget 令牌被 sync/pull 拒绝', denied.statusCode === 403, `HTTP ${denied.statusCode} ${denied.body.slice(0, 120)}`);

// 3. 反向断言：只读令牌不能轮换出全权令牌（提权路径）
const escalate = await app.inject({ method: 'POST', url: '/api/devices/rotate', headers: auth });
check('widget 令牌不能轮换主令牌', escalate.statusCode === 403, `HTTP ${escalate.statusCode}`);

// 4. 反向断言：只读令牌不能签发新令牌
const mint = await app.inject({ method: 'POST', url: '/api/devices/widget-token', headers: auth });
check('widget 令牌不能签发新令牌', mint.statusCode === 403, `HTTP ${mint.statusCode}`);

// 5. 缺参数要 400，而不是拿服务端自己的"今天"凑合
const bad = await app.inject({ method: 'GET', url: '/api/widget/summary', headers: auth });
check('缺 today/dayStart/dayEnd 返回 400', bad.statusCode === 400, `HTTP ${bad.statusCode}`);

await app.close();
console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
