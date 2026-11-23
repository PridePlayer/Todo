/**
 * M5 验收：打卡。
 *
 * 分两段，因为打卡的正确性有两类来源：
 *
 *   A 段 —— 纯函数（streak / 完成率 / 热力图 / 日期算术 / 确定性主键）。
 *     这些不需要数据库，但它们是"统计数字对不对"的全部来源，所以逐条按
 *     docs/05 的**出口条件**验：跨月、闰年 2 月 29、时区切换、删除记录后回退。
 *     时区那一条真的起了三个子进程（TZ=UTC / Asia/Shanghai / America/New_York），
 *     而不是在同一个进程里假装切时区——Node 会缓存时区，同进程改 TZ 是假验。
 *
 *   B 段 —— 真实 HTTP（Fastify inject）打在**内存数据库**上，跑的是和线上同一份
 *     routes/sync.ts / sync/merge.ts。重点验 docs/05 M5 验收第 7 条：
 *     两台设备同一天各点一次计数型，同步后数字是**较大值而不是相加**。
 *
 * 用法：cd packages/server && ./node_modules/.bin/tsx ../../tools/habit-check.ts
 */
// 必须在 loadEnv 之前设：内存库让这次验收不碰用户真实数据，也就不会污染 .data/grid.db
process.env.DB_URL = 'sqlite::memory:';

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  addDaysKey,
  completionRate,
  computeStreak,
  dayNumber,
  dateKeyInZone,
  habitLogId,
  heatmapWeeks,
  isScheduled,
  levelOf,
  weekdayOfKey,
} from '../packages/core/dist/index.js';
import { createDb } from '../packages/server/src/db/index.js';
import { runMigrations } from '../packages/server/src/db/migrate.js';
import { loadEnv } from '../packages/server/src/env.js';
import { buildApp } from '../packages/server/src/app.js';
import { createSession } from '../packages/server/src/auth/session.js';
import { createUser } from '../packages/server/src/repo/users.js';

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

function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? `= ${JSON.stringify(actual)}` : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ── A 段：纯函数 ────────────────────────────────────────────
console.log('\nM5 验收 A：统计与日期算术（纯函数）\n');

// A1 跨月 / 跨年：靠日序号加减，不看月份长度表
eq('跨月 1-31 +1 = 2-01', addDaysKey('2026-01-31', 1), '2026-02-01');
eq('跨年 12-31 +1 = 次年 1-01', addDaysKey('2026-12-31', 1), '2027-01-01');
eq('跨月回退 3-01 -1 = 2-28（非闰年）', addDaysKey('2026-03-01', -1), '2026-02-28');

// A2 闰年 2 月 29
eq('闰年 2-28 +1 = 2-29', addDaysKey('2024-02-28', 1), '2024-02-29');
eq('闰年 2-29 +1 = 3-01', addDaysKey('2024-02-29', 1), '2024-03-01');
eq('闰日与 3-01 相差 1 天', dayNumber('2024-03-01') - dayNumber('2024-02-29'), 1);

// A3 星期几：0=周一。1970-01-01 是周四，用这个已知事实锚定整个表
eq('1970-01-01 是周四（0=周一）', weekdayOfKey('1970-01-01'), 3);
eq('排期判定：周三在 [一三五] 内', isScheduled('2024-02-28', [0, 2, 4]), true);

// A4 streak：今天还没打不算断
{
  const today = '2026-03-10';
  const days = new Set(['2026-03-08', '2026-03-09']);
  const s = computeStreak(days, today);
  eq('今天未打卡：连续天数从昨天往回数为 2', s.current, 2);
  eq('今天未打卡：doneToday=false', s.doneToday, false);
  const s2 = computeStreak(new Set([...days, today]), today);
  eq('今天打卡后连续天数为 3', s2.current, 3);
}

// A5 streak：跨月
{
  const s = computeStreak(new Set(['2026-01-30', '2026-01-31', '2026-02-01']), '2026-02-01');
  eq('跨月连续 3 天（1-30 → 2-01）', s.current, 3);
}

// A6 streak：闰年 2 月 29
{
  const s = computeStreak(new Set(['2024-02-28', '2024-02-29', '2024-03-01']), '2024-03-01');
  eq('闰年 2-28 → 2-29 → 3-01 连续 3 天', s.current, 3);
  eq('闰年这一段的 longest 也是 3', s.longest, 3);
}

// A7 streak：删除记录后回退（纯函数，每次都从集合重算）
{
  const today = '2026-03-10';
  const days = ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'];
  const before = computeStreak(new Set(days), today);
  const after = computeStreak(new Set(days.filter((d) => d !== '2026-03-08')), today);
  eq('删掉中间一天前：连续 5 天', before.current, 5);
  eq('删掉 3-08 后：连续天数回退到 2（3-09、3-10）', after.current, 2);
  eq('删掉后 longest 变为 2', after.longest, 2);
}

// A8 streak：缺口与最长段
{
  const s = computeStreak(
    new Set(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-07', '2026-03-08']),
    '2026-03-09',
  );
  eq('有缺口时 longest 取最长那段（3 天）', s.longest, 3);
  eq('当前连续 = 2（3-07、3-08）', s.current, 2);
  eq('lastDone 是最近一次达标日', s.lastDone, '2026-03-08');
}

// A9 完成率：分母是"该做的天数"
{
  const base = { doneDays: new Set<string>(), createdKey: '2000-01-01', to: '2026-03-10' };
  // 任意连续 7 天里，周一恰好出现一次
  const week1 = completionRate({ ...base, daysOfWeek: [0], from: '2026-03-04' });
  eq('7 天窗口 + 只排周一 → 该做 1 次', week1.expected, 1);
  const week3 = completionRate({ ...base, daysOfWeek: [0, 2, 4], from: '2026-03-04' });
  eq('7 天窗口 + 排一三五 → 该做 3 次', week3.expected, 3);
  const weekEvery = completionRate({ ...base, daysOfWeek: [], from: '2026-03-04' });
  eq('7 天窗口 + 每天 → 该做 7 次', weekEvery.expected, 7);

  const done = completionRate({
    ...base,
    daysOfWeek: [0, 2, 4],
    from: '2026-03-04',
    doneDays: new Set(['2026-03-04']),
  });
  eq('达成 1 / 应做 3 → 33%', Math.round(done.rate * 100), 33);
}

// A10 完成率：起点与创建日取较晚者
{
  const late = completionRate({
    doneDays: new Set<string>(),
    daysOfWeek: [],
    from: '2026-01-01',
    to: '2026-03-10',
    createdKey: '2026-03-08',
  });
  eq('习惯 3-08 才创建 → 分母只算 3-08..3-10（3 天）', late.expected, 3);
}

// A11 热力图：12 周 84 格，今天只出现一次，未来格单独标记
{
  const today = '2026-03-10';
  const weeks = heatmapWeeks({
    today,
    weeks: 12,
    target: 8,
    daysOfWeek: [],
    logs: new Map([['2026-03-09', { value: 4, backfilled: true }]]),
  });
  const flat = weeks.flat();
  eq('12 周 × 7 = 84 格', flat.length, 84);
  eq('今天恰好出现一次', flat.filter((c) => c.date === today).length, 1);
  eq('今天之后的都是 future', flat.filter((c) => c.future).every((c) => c.date > today), true);
  const cell = flat.find((c) => c.date === '2026-03-09');
  eq('4/8 落在第 2 档', cell?.level, 2);
  eq('补记被标出来', cell?.backfilled, true);
}

// A12 五档边界
eq('0 → 第 0 档', levelOf(0, 8), 0);
eq('3/8 → 第 1 档', levelOf(3, 8), 1);
eq('4/8（50%）→ 第 2 档', levelOf(4, 8), 2);
eq('8/8 → 第 3 档', levelOf(8, 8), 3);
eq('9/8（超额）→ 第 4 档', levelOf(9, 8), 4);

// A13 确定性主键
{
  const id1 = habitLogId('01HABITCHECKHABIT000000001', '2026-03-10');
  const id2 = habitLogId('01HABITCHECKHABIT000000001', '2026-03-10');
  const id3 = habitLogId('01HABITCHECKHABIT000000001', '2026-03-11');
  const id4 = habitLogId('01HABITCHECKHABIT000000002', '2026-03-10');
  eq('同 habit + 同日期 → 同一个 id', id1, id2);
  eq('id 长度 26（服务端列是 VARCHAR(26)）', id1.length, 26);
  check('换日期会换 id', id1 !== id3, `${id1} vs ${id3}`);
  check('换习惯会换 id', id1 !== id4, `${id1} vs ${id4}`);
  check('字符集是 Crockford base32', /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id1), id1);
}

// A14 时区切换：真的起三个子进程
{
  const coreUrl = pathToFileURL(
    fileURLToPath(new URL('../packages/core/dist/index.js', import.meta.url)),
  ).href;
  const probe = `
    const core = await import(${JSON.stringify(coreUrl)});
    process.stdout.write(JSON.stringify({
      day: core.dayNumber('2024-02-29'),
      add: core.addDaysKey('2024-02-28', 1),
      week: core.weekdayOfKey('2024-02-29'),
      streak: core.computeStreak(['2024-02-28','2024-02-29','2024-03-01'], '2024-03-01').current,
      id: core.habitLogId('01HABITCHECKHABIT000000001', '2024-02-29'),
      // 这一项**应该**随 TZ 变化，用来证明三个进程真的在不同时区
      localDay: core.dateKeyInZone(1700000000000),
    }));
  `;
  const run = (tz: string): Record<string, string | number> => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    return JSON.parse(out) as Record<string, string | number>;
  };

  const utc = run('UTC');
  const shanghai = run('Asia/Shanghai');
  const newYork = run('America/New_York');

  check(
    '三个子进程的"本地日"确实不同（证明时区真的切了）',
    new Set([utc.localDay, shanghai.localDay, newYork.localDay]).size >= 2,
    `UTC=${utc.localDay} 上海=${shanghai.localDay} 纽约=${newYork.localDay}`,
  );

  const keys = ['day', 'add', 'week', 'streak', 'id'];
  const stable = keys.every((key) => utc[key] === shanghai[key] && shanghai[key] === newYork[key]);
  check(
    '日期算术 / streak / 主键在 UTC→上海→纽约切换后完全一致',
    stable,
    keys.map((key) => `${key}=${utc[key]}`).join(' '),
  );
  eq('切到 UTC 后闰日序号不变', utc.day, shanghai.day);
}

// ── B 段：真实 HTTP（内存库）─────────────────────────────────
console.log('\nM5 验收 B：同步合并与服务端校验（真实 HTTP + 内存库）\n');

const env = loadEnv();
if (!env.dbUrl.startsWith('sqlite:')) {
  console.error(`期望内存 sqlite，实际 ${env.dbUrl}：拒绝在真实库上跑验收`);
  process.exit(1);
}

const db = createDb(env.dbUrl);
await runMigrations(db);
const app = await buildApp({ env, db, startedAt: Date.now(), tokens: null });

const user = await createUser(db, 'habit-check@example.invalid', 'not-a-real-hash');
const session = await createSession(db, user.id, env.sessionTtlMs);
const cookie = { [env.cookieName]: session.token };

const HABIT_ID = '01HABITCHECKHABIT000000001';
const DEVICE_A = '01HABITCHECKDEVICEA0000001';
const DEVICE_B = '01HABITCHECKDEVICEB0000001';

let opSeq = 0;
interface WireOp {
  opId: string;
  table: string;
  action: string;
  id: string;
  baseRev: number;
  fields: Record<string, unknown>;
  base?: Record<string, unknown>;
  hlc: { wall: number; counter: number; device: string };
}

function wire(params: {
  table: string;
  action: 'create' | 'update' | 'delete';
  id: string;
  fields?: Record<string, unknown>;
  base?: Record<string, unknown>;
  baseRev?: number;
  wall?: number;
  counter?: number;
  device?: string;
}): WireOp {
  opSeq += 1;
  const op: WireOp = {
    opId: `HC${opSeq.toString(36).toUpperCase()}${Date.now().toString(36).toUpperCase()}`.slice(0, 32),
    table: params.table,
    action: params.action,
    id: params.id,
    baseRev: params.baseRev ?? 0,
    fields: params.fields ?? {},
    hlc: { wall: params.wall ?? Date.now(), counter: params.counter ?? 0, device: params.device ?? DEVICE_A },
  };
  if (params.base) op.base = params.base;
  return op;
}

interface OpResult {
  opId: string;
  status: string;
  rev?: number;
  reason?: string;
}

async function push(ops: WireOp[]): Promise<OpResult[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    cookies: cookie,
    payload: { deviceId: DEVICE_A, ops },
  });
  if (res.statusCode !== 200) throw new Error(`push 失败 ${res.statusCode}：${res.body}`);
  return (res.json() as { results: OpResult[] }).results;
}

interface Change {
  table: string;
  id: string;
  rev: number;
  deletedAt: number | null;
  payload: Record<string, unknown> | null;
}

async function pull(): Promise<Change[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sync/pull',
    cookies: cookie,
    payload: { cursor: 0, limit: 500 },
  });
  if (res.statusCode !== 200) throw new Error(`pull 失败 ${res.statusCode}：${res.body}`);
  return (res.json() as { changes: Change[] }).changes;
}

async function row(sql: string, params: unknown[] = []): Promise<Record<string, unknown> | undefined> {
  const rows = await db.query<Record<string, unknown>>(sql, params);
  return rows[0];
}

const today = dateKeyInZone(Date.now());
const backfillDate = addDaysKey(today, -3);
const logId = habitLogId(HABIT_ID, backfillDate);

// B1 建习惯：daysOfWeek 的脏数据被规范化
{
  const results = await push([
    wire({
      table: 'habit',
      action: 'create',
      id: HABIT_ID,
      fields: {
        name: '喝水',
        type: 'count',
        target: 8,
        unit: '杯',
        // 4 重复、9 越界：服务端应去重排序并丢掉越界值
        daysOfWeek: [4, 0, 4, 9],
        colorKey: 0,
        sortOrder: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
      },
    }),
  ]);
  eq('建习惯被接受', results[0]?.status, 'applied');
  const stored = await row('SELECT * FROM habit WHERE id = ?', [HABIT_ID]);
  eq('daysOfWeek 存成 [0,4]（去重 + 丢越界 + 排序）', JSON.parse(String(stored?.days_of_week)), [0, 4]);
  eq('target 落库为 8', Number(stored?.target), 8);
}

// B2 非法目标被拒
{
  const bad = await push([
    wire({
      table: 'habit',
      action: 'create',
      id: '01HABITCHECKHABIT000000009',
      fields: { name: '坏习惯', type: 'count', target: 0, daysOfWeek: [], createdAt: Date.now(), updatedAt: Date.now() },
    }),
  ]);
  eq('target=0 被拒绝（否则完成率分母为 0）', bad[0]?.reason, 'bad_target');
}

// B3 乱造 id 的打卡记录被拒
{
  const bad = await push([
    wire({
      table: 'habit_log',
      action: 'create',
      id: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      fields: {
        habitId: HABIT_ID,
        logDate: backfillDate,
        value: 3,
        backfilled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }),
  ]);
  eq('非确定性 id 被拒绝（否则同一天会两行、数字翻倍）', bad[0]?.reason, 'nondeterministic_log_id');
}

// B4 非法日期被拒
{
  const bad = await push([
    wire({
      table: 'habit_log',
      action: 'create',
      id: habitLogId(HABIT_ID, '2026-02-30'),
      fields: { habitId: HABIT_ID, logDate: '2026-02-30', value: 1, createdAt: Date.now(), updatedAt: Date.now() },
    }),
  ]);
  eq('2026-02-30 被拒绝', bad[0]?.reason, 'bad_log_date');
}

// B5 习惯不存在 → 拒（不留孤儿）
{
  const missingHabit = '01HABITCHECKHABIT000000002';
  const bad = await push([
    wire({
      table: 'habit_log',
      action: 'create',
      id: habitLogId(missingHabit, backfillDate),
      fields: {
        habitId: missingHabit,
        logDate: backfillDate,
        value: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }),
  ]);
  eq('给不存在的习惯写记录被拒绝（不留孤儿行）', bad[0]?.reason, 'habit_missing');
}

// B6 设备 A 写入 3
{
  const results = await push([
    wire({
      table: 'habit_log',
      action: 'create',
      id: logId,
      fields: {
        habitId: HABIT_ID,
        logDate: backfillDate,
        value: 3,
        backfilled: true,
        note: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
      },
    }),
  ]);
  eq('设备 A 建记录 value=3', results[0]?.status, 'applied');
}

// B7 设备 B 同一天打到 5（它离线时也看到了 3，所以 base=3）
{
  const results = await push([
    wire({
      table: 'habit_log',
      action: 'update',
      id: logId,
      baseRev: 1,
      fields: { value: 5, updatedAt: Date.now() },
      base: { value: 3 },
      device: DEVICE_B,
      wall: Date.now() + 1,
    }),
  ]);
  eq('设备 B 的 value=5 被接受', results[0]?.status, 'applied');
}

// B8 设备 A 用更早的 HLC 再写 2（模拟先点的那个 op 后到）
{
  await push([
    wire({
      table: 'habit_log',
      action: 'update',
      id: logId,
      baseRev: 2,
      fields: { value: 2 },
      base: { value: 3 },
      wall: Date.now() - 1000,
    }),
  ]);
  const stored = await row('SELECT value FROM habit_log WHERE id = ?', [logId]);
  eq('迟到的 value=2 不会把 5 拉低（取较大值）', Number(stored?.value), 5);
}

// B9 关键一条：同步后是 5，不是 3+5=8
{
  const changes = await pull();
  const log = changes.find((c) => c.table === 'habit_log' && c.id === logId);
  eq('同步后 value=5，不是相加得到的 8', Number(log?.payload?.value), 5);
  check('记录仍在（没被删成墓碑）', log?.deletedAt === null, String(log?.deletedAt));
}

// B10 离线各建一条：base 为空时也不能覆盖成较小值
{
  const date2 = addDaysKey(today, -4);
  const id2 = habitLogId(HABIT_ID, date2);
  await push([
    wire({
      table: 'habit_log',
      action: 'create',
      id: id2,
      fields: { habitId: HABIT_ID, logDate: date2, value: 6, createdAt: Date.now(), updatedAt: Date.now() },
    }),
  ]);
  // 另一台设备离线时也 create 了同一天（base 为空），但它只打到 2
  await push([
    wire({
      table: 'habit_log',
      action: 'create',
      id: id2,
      fields: { habitId: HABIT_ID, logDate: date2, value: 2, createdAt: Date.now(), updatedAt: Date.now() },
      device: DEVICE_B,
      wall: Date.now() + 5,
    }),
  ]);
  const stored = await row('SELECT value FROM habit_log WHERE id = ?', [id2]);
  eq('两台设备各自 create 同一天：取较大值 6，不被后来的 2 覆盖', Number(stored?.value), 6);
}

// B11 habitId / logDate 不可改
{
  await push([
    wire({
      table: 'habit_log',
      action: 'update',
      id: logId,
      baseRev: 3,
      fields: { habitId: '01HABITCHECKHABIT000000009', logDate: '2020-01-01' },
    }),
  ]);
  const stored = await row('SELECT habit_id, log_date FROM habit_log WHERE id = ?', [logId]);
  eq('habitId 改不动', String(stored?.habit_id), HABIT_ID);
  eq('logDate 改不动', String(stored?.log_date), backfillDate);
}

// B12 summary 接口
{
  const res = await app.inject({
    method: 'GET',
    url: `/api/habits/summary?today=${today}&days=30`,
    cookies: cookie,
  });
  eq('GET /api/habits/summary 返回 200', res.statusCode, 200);
  const body = res.json() as { habits: { id: string }[]; logs: { value: number }[]; from: string };
  eq('summary 里有 1 个习惯', body.habits.length, 1);
  check('summary 里带了记录', body.logs.length >= 1, `${body.logs.length} 条`);
  check('summary 的 from 早于 today', body.from < today, `${body.from} → ${today}`);
}

// B13 删除记录 → 墓碑，且不再出现在 summary
{
  await push([wire({ table: 'habit_log', action: 'delete', id: logId, baseRev: 4 })]);
  const changes = await pull();
  const log = changes.find((c) => c.table === 'habit_log' && c.id === logId);
  check('删除后 pull 里是墓碑（payload 为 null）', log?.deletedAt !== null && log?.payload === null);

  const res = await app.inject({
    method: 'GET',
    url: `/api/habits/summary?today=${today}&days=30`,
    cookies: cookie,
  });
  const body = res.json() as { logs: { id: string }[] };
  check(
    'summary 不再返回已删除的记录',
    !body.logs.some((l) => l.id === logId),
    `${body.logs.length} 条`,
  );
}

// B14 删除习惯 → 不影响已写的记录（客户端负责级联，服务端不做隐式删除）
{
  await push([wire({ table: 'habit', action: 'delete', id: HABIT_ID, baseRev: 1 })]);
  const stored = await row('SELECT deleted_at FROM habit WHERE id = ?', [HABIT_ID]);
  check('删除习惯后 habit 是墓碑', stored?.deleted_at !== null && stored?.deleted_at !== undefined);
  const res = await app.inject({
    method: 'GET',
    url: `/api/habits/summary?today=${today}&days=30`,
    cookies: cookie,
  });
  eq('summary 不再返回已删除的习惯', (res.json() as { habits: unknown[] }).habits.length, 0);
}

await app.close();

console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}\n`);
if (fail > 0) process.exitCode = 1;
