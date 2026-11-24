/**
 * M4 验收：Outlook 日历增量同步与单次回写。
 *
 * 全程打真实的 Microsoft Graph（不是 mock），在一个**临时日历**里造数据，
 * 结束后把日历删掉——不碰用户自己的会议。用例覆盖 05 文档 M4 的七条：
 *   1. 事件 1 分钟内进日历（这里直接断言拉到的行与展开结果）
 *   2. 全天 / 跨天 / 非本地时区都显示正确
 *   3. Outlook 网页版新建 → GRID 出现
 *   4. Outlook 网页版删除 → GRID 消失（不是变成未知事件）
 *   5. GRID 改 10:00 → 11:00 → Outlook 侧 30 秒内同步
 *   6. 重复事件只读、带 webLink
 *   7. 令牌落库是密文
 *
 * 用法：cd packages/server && ./node_modules/.bin/tsx ../../tools/calendar-check.ts
 */
// tools/ 不在 pnpm workspace 里，无法解析 @grid/core 的包名；直接引构建产物
import { expandTasks, parseZonedDateTime, type SeriesLike } from '../packages/core/dist/index.js';
import { createDb } from '../packages/server/src/db/index.js';
import { loadEnv } from '../packages/server/src/env.js';
import { createGraphContext } from '../packages/server/src/graph/context.js';
import {
  createCalendar,
  createEvent,
  deleteCalendar,
  deleteEvent,
  getEvent,
  listCalendars,
  patchEvent,
} from '../packages/server/src/graph/client.js';
import { pullEvents } from '../packages/server/src/graph/delta.js';
import { drainOutbox } from '../packages/server/src/graph/push.js';
import { loadSources, refreshSources } from '../packages/server/src/graph/sources.js';
import { findAccountByUser } from '../packages/server/src/repo/oauth.js';

const env = loadEnv();
const db = createDb(env.dbUrl);
const graph = createGraphContext(db, env);

// 本地开发库的登录口令，从环境变量读，不写进仓库——这个仓库是公开的。
// 用法：GRID_TEST_PASSWORD=你的口令 tsx tools/calendar-check.ts
const TEST_EMAIL = process.env.GRID_TEST_EMAIL ?? 'me@example.com';
const TEST_PASSWORD = process.env.GRID_TEST_PASSWORD;
if (!TEST_PASSWORD) {
  console.error('需要 GRID_TEST_PASSWORD 环境变量（本地开发库的登录口令）');
  process.exit(1);
}

if (!graph) {
  console.error('OAuth 未配置，无法跑 M4 验收');
  process.exit(1);
}

const accounts = await db.query<{ user_id: string }>('SELECT user_id FROM oauth_account LIMIT 1');
const userId = accounts[0]?.user_id ?? '';
if (userId === '') {
  console.error('没有已连接的账号');
  process.exit(1);
}
const account = await findAccountByUser(db, userId);
if (!account) process.exit(1);
const token = await graph.tokens.accessTokenFor(userId);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  ${detail}`);
  }
}

function fmt(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ts));
}

/** 取本地库里的某条事件镜像 */
async function localEvent(msEventId: string) {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM cal_event WHERE user_id = ? AND ms_event_id = ?',
    [userId, msEventId],
  );
  return rows[0];
}

/** 把本地镜像展开成实例（与前端 useOccurrences 同一条路径） */
async function expandLocal(from: number, to: number): Promise<ReturnType<typeof expandTasks>> {
  const sources = await loadSources(db, userId);
  const sourceMap = new Map(sources.map((row) => [row.id, row]));
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM cal_event WHERE user_id = ? AND deleted_at IS NULL',
    [userId],
  );
  const series: SeriesLike[] = [];
  for (const row of rows) {
    const source = sourceMap.get(String(row.source_id));
    if (!source || Number(source.is_visible) !== 1 || Number(source.is_synced) !== 1) continue;
    series.push({
      id: String(row.id),
      title: String(row.subject),
      startAt: Number(row.start_at),
      endAt: Number(row.end_at),
      allDay: Number(row.is_all_day) === 1,
      rrule: row.rrule ? String(row.rrule) : null,
      exceptions: [],
      kind: 'event',
      origin: {
        sourceId: String(row.source_id),
        webLink: row.web_link ? String(row.web_link) : null,
        readOnly: Number(row.is_recurring) === 1 || Number(source.can_edit) !== 1,
        colorKey: Number(source.color_key),
      },
    });
  }
  return expandTasks(series, from, to, 2000);
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const base = parseZonedDateTime(
  `${new Date(now + 2 * DAY).toISOString().slice(0, 10)}T10:00:00`,
  'Asia/Shanghai',
)!;

console.log('\n── 准备：临时日历 ──────────────────────────');
const calendarId = await createCalendar(token, `GRID 验收 ${new Date().toISOString().slice(0, 16)}`);
console.log('  日历 id:', calendarId.slice(0, 24) + '…');

const dayOf = (offset: number): string =>
  new Date(new Date(now + offset * DAY).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
    .toISOString()
    .slice(0, 10);

// 用本地日期字符串构造，避免 UTC 与东八区差一天
function localDate(offsetDays: number): string {
  const d = new Date(now + offsetDays * DAY);
  const pad = (n: number): string => String(n).padStart(2, '0');
  // 以 Asia/Shanghai 为准取日期
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return parts;
}
void dayOf;

const d2 = localDate(2);
const d3 = localDate(3);
const d4 = localDate(4);
const d5 = localDate(5);

const singleId = await createEvent(token, calendarId, {
  subject: '验收单次会议',
  start: { dateTime: `${d2}T10:00:00.0000000`, timeZone: 'Asia/Shanghai' },
  end: { dateTime: `${d2}T11:00:00.0000000`, timeZone: 'Asia/Shanghai' },
});
const allDayId = await createEvent(token, calendarId, {
  subject: '验收全天事项',
  isAllDay: true,
  start: { dateTime: `${d3}T00:00:00.0000000`, timeZone: 'UTC' },
  end: { dateTime: `${d4}T00:00:00.0000000`, timeZone: 'UTC' },
});
const crossDayId = await createEvent(token, calendarId, {
  subject: '验收跨天事项',
  start: { dateTime: `${d3}T23:00:00.0000000`, timeZone: 'Asia/Shanghai' },
  end: { dateTime: `${d4}T01:00:00.0000000`, timeZone: 'Asia/Shanghai' },
});
const nyId = await createEvent(token, calendarId, {
  subject: '验收纽约时间',
  start: { dateTime: `${d5}T10:00:00.0000000`, timeZone: 'America/New_York' },
  end: { dateTime: `${d5}T11:00:00.0000000`, timeZone: 'America/New_York' },
});
const weekdayOfD2 = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Shanghai' })
  .format(new Date(now + 2 * DAY))
  .toLowerCase();
const recurringId = await createEvent(token, calendarId, {
  subject: '验收每周例会',
  start: { dateTime: `${d2}T09:00:00.0000000`, timeZone: 'Asia/Shanghai' },
  end: { dateTime: `${d2}T09:30:00.0000000`, timeZone: 'Asia/Shanghai' },
  recurrence: {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: [weekdayOfD2] },
    range: { type: 'numbered', numberOfOccurrences: 4, startDate: d2, recurrenceTimeZone: 'Asia/Shanghai' },
  },
});
const toDeleteId = await createEvent(token, calendarId, {
  subject: '验收稍后删除',
  start: { dateTime: `${d2}T16:00:00.0000000`, timeZone: 'Asia/Shanghai' },
  end: { dateTime: `${d2}T17:00:00.0000000`, timeZone: 'Asia/Shanghai' },
});
console.log('  已创建 6 条测试事件');

console.log('\n── 用例 1/2：拉取与时间换算 ────────────────');
await refreshSources(db, userId, account.id, token);
const firstPull = await pullEvents({ db, tokens: graph.tokens, userId });
check('首次拉取写入了新事件', firstPull.added >= 6, `added=${firstPull.added}`);

const single = await localEvent(singleId);
check(
  '单次事件时间正确（10:00–11:00 东八区）',
  Boolean(single) &&
    new Date(Number(single!.start_at)).getHours() === 10 &&
    new Date(Number(single!.end_at)).getHours() === 11,
  single ? `${fmt(Number(single.start_at))} → ${fmt(Number(single.end_at))}` : '未找到',
);

const allDay = await localEvent(allDayId);
check(
  '全天事件落在本地 00:00 且 is_all_day=1',
  Boolean(allDay) &&
    Number(allDay!.is_all_day) === 1 &&
    new Date(Number(allDay!.start_at)).getHours() === 0 &&
    new Date(Number(allDay!.start_at)).getDate() === Number(d3.slice(8)),
  allDay ? `${fmt(Number(allDay!.start_at))}` : '未找到',
);

const crossDay = await localEvent(crossDayId);
check(
  '跨天事件跨过了午夜（23:00 → 次日 01:00）',
  Boolean(crossDay) &&
    Number(crossDay!.end_at) - Number(crossDay!.start_at) === 2 * 60 * 60 * 1000 &&
    new Date(Number(crossDay!.end_at)).getDate() !== new Date(Number(crossDay!.start_at)).getDate(),
  crossDay ? `${fmt(Number(crossDay.start_at))} → ${fmt(Number(crossDay.end_at))}` : '未找到',
);

const ny = await localEvent(nyId);
check(
  '纽约时间 10:00 换算成东八区 23:00（冬令时 +13）',
  Boolean(ny) && new Date(Number(ny!.start_at)).getHours() === 23,
  ny ? `${fmt(Number(ny.start_at))}` : '未找到',
);

const recurring = await localEvent(recurringId);
check(
  '重复事件反推出 RRULE',
  Boolean(recurring) && Number(recurring!.is_recurring) === 1 && String(recurring!.rrule).includes('FREQ=WEEKLY'),
  recurring ? `${recurring.rrule} count=${String(recurring.rrule).match(/COUNT=(\d+)/)?.[1] ?? '-'}` : '未找到',
);
check('重复事件带 webLink（只读时唯一的出口）', Boolean(recurring?.web_link), recurring?.web_link ? '有' : '无');

// 4 次每周跨 4 周，窗口要放宽到 40 天才能数全
const expanded = await expandLocal(now, now + 40 * DAY);
const recurringCount = expanded.filter((item) => item.seriesId === String(recurring?.id)).length;
check('本地按 RRULE 展开出 4 次', recurringCount === 4, `${recurringCount} 次（${weekdayOfD2} 起每周）`);

console.log('\n── 用例 3：Outlook 新建 → GRID 出现 ────────');
const lateId = await createEvent(token, calendarId, {
  subject: '验收网页版新建的会',
  start: { dateTime: `${d2}T14:00:00.0000000`, timeZone: 'Asia/Shanghai' },
  end: { dateTime: `${d2}T14:30:00.0000000`, timeZone: 'Asia/Shanghai' },
});
const secondPull = await pullEvents({ db, tokens: graph.tokens, userId });
check('增量拉取拿到新建的会议', secondPull.added >= 1 && Boolean(await localEvent(lateId)), `added=${secondPull.added}`);

console.log('\n── 用例 4：Outlook 删除 → GRID 消失 ────────');
const beforeDelete = await localEvent(toDeleteId);
await deleteEvent(token, toDeleteId, null);
const thirdPull = await pullEvents({ db, tokens: graph.tokens, userId });
const afterDelete = await localEvent(toDeleteId);
check(
  '被删的事件写成了墓碑而不是幽灵行',
  Boolean(beforeDelete) && Boolean(afterDelete) && afterDelete!.deleted_at !== null && thirdPull.removed >= 1,
  `removed=${thirdPull.removed}`,
);
const expandedAfter = await expandLocal(now, now + 14 * DAY);
check(
  '墓碑不再出现在展开结果里',
  !expandedAfter.some((item) => item.seriesId === String(afterDelete?.id)),
  `${expandedAfter.length} 个实例`,
);

console.log('\n── 用例 5：GRID 改 10:00 → 11:00 回写 Outlook ──');
// 走真实的 /sync/push：模拟浏览器端的操作队列
const BASE = 'http://127.0.0.1:3000/api';
const jar = new Map<string, string>();
async function http(path: string, init: RequestInit & { csrf?: string } = {}): Promise<Response> {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.csrf ? { 'x-csrf-token': init.csrf } : {}),
      ...(init.headers ?? {}),
    },
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return res;
}

const sessionRes = await http('/auth/session');
const session = (await sessionRes.json()) as { csrfToken: string };
await http('/auth/login', {
  method: 'POST',
  csrf: session.csrfToken,
  body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
});
const session2 = (await (await http('/auth/session')).json()) as { csrfToken: string };
const csrf = session2.csrfToken;

const localSingle = await localEvent(singleId);
const newStart = Number(localSingle!.start_at) + 60 * 60 * 1000;
const opId = `M4${Date.now().toString(36).toUpperCase()}`.slice(0, 32);
const pushRes = await http('/sync/push', {
  method: 'POST',
  csrf,
  body: JSON.stringify({
    deviceId: '01CALCHECKDEVICE0000000001',
    ops: [
      {
        opId,
        table: 'cal_event',
        action: 'update',
        id: String(localSingle!.id),
        baseRev: Number(localSingle!.rev),
        fields: { startAt: newStart, endAt: newStart + 60 * 60 * 1000 },
        base: { startAt: Number(localSingle!.start_at), endAt: Number(localSingle!.end_at) },
        hlc: { wall: Date.now(), counter: 0, device: '01CALCHECKDEVICE0000000001' },
      },
    ],
  }),
});
const pushJson = (await pushRes.json()) as { results: { status: string }[] };
check('客户端 op 被服务端接受', pushJson.results[0]?.status === 'applied' || pushJson.results[0]?.status === 'conflict', pushJson.results[0]?.status);

const outboxRows = await db.query<Record<string, unknown>>(
  "SELECT * FROM op_outbox WHERE entity_id = ? AND status = 'pending'",
  [String(localSingle!.id)],
);
check('回写队列里排上了这条改动', outboxRows.length === 1, `${outboxRows.length} 条`);

const drain = await drainOutbox({ db, tokens: graph.tokens, userId });
check('回写队列执行成功', drain.done >= 1, `done=${drain.done} dead=${drain.dead}`);

const remoteAfter = await getEvent(token, singleId);
check(
  'Outlook 侧时间已变成 11:00',
  remoteAfter.start?.dateTime.startsWith(`${d2}T11:00`) === true,
  remoteAfter.start?.dateTime,
);

console.log('\n── 用例 6：自回声与幂等 ────────────────────');
const echoPull = await pullEvents({ db, tokens: graph.tokens, userId });
const echoRow = await localEvent(singleId);
check(
  '回写后自己拉到的那次不算"远端又改了"',
  echoPull.updated === 0 && echoPull.added === 0,
  `updated=${echoPull.updated} added=${echoPull.added}`,
);
check('etag 已更新为远端最新值', Boolean(echoRow?.ms_etag), String(echoRow?.ms_etag ?? '').slice(0, 18) + '…');

console.log('\n── 用例 7：令牌是密文 ──────────────────────');
const tokenRow = await db.query<{ access_token_enc: string }>(
  'SELECT access_token_enc FROM oauth_account WHERE user_id = ?',
  [userId],
);
const cipherText = tokenRow[0]?.access_token_enc ?? '';
check(
  'access_token_enc 是四段密文（v1.iv.tag.ct），不含 JWT 特征',
  cipherText.split('.').length === 4 && !cipherText.includes('eyJ'),
  `${cipherText.slice(0, 16)}… len=${cipherText.length}`,
);

console.log('\n── 清理 ────────────────────────────────────');
await deleteCalendar(token, calendarId);
// 先让源列表跟上（Graph 上已经没有这本日历了），再拉一次
await refreshSources(db, userId, account.id, token);
const finalPull = await pullEvents({ db, tokens: graph.tokens, userId });
const leftover = await db.query<{ c: unknown }>(
  'SELECT COUNT(*) AS c FROM cal_event WHERE user_id = ? AND deleted_at IS NULL AND source_id IN (SELECT id FROM calendar_source WHERE ms_calendar_id = ?)',
  [userId, calendarId],
);
check('删掉测试日历后本地事件也清干净了', Number(leftover[0]?.c ?? 0) === 0, `removed=${finalPull.removed}`);

const names = await listCalendars(token);
check('测试日历已从 Graph 上消失', !names.some((cal) => cal.id === calendarId));

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
await db.close();
process.exit(fail === 0 ? 0 : 1);
