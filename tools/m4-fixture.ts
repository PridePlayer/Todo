/**
 * M4 UI 验收的夹具：在真实 Outlook 里造两场会，跑完检查再删掉。
 *
 * 为什么不把夹具塞进本地库：GRID 改事件之后要回写 Graph，
 * 而一条假的 ms_event_id 会让 PATCH 直接 404（然后被当成"会议已被取消"清掉），
 * 那样测出来的只是自己的假数据，测不出真实链路。
 *
 * 用法（在 packages/server 下）：
 *   ./node_modules/.bin/tsx ../../tools/m4-fixture.ts create
 *   ./node_modules/.bin/tsx ../../tools/m4-fixture.ts verify
 *   ./node_modules/.bin/tsx ../../tools/m4-fixture.ts cleanup
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCalendar, createEvent, deleteCalendar, getEvent } from '../packages/server/src/graph/client.js';
import { pullEvents } from '../packages/server/src/graph/delta.js';
import { refreshSources } from '../packages/server/src/graph/sources.js';
import { createDb } from '../packages/server/src/db/index.js';
import { loadEnv } from '../packages/server/src/env.js';
import { createGraphContext } from '../packages/server/src/graph/context.js';
import { findAccountByUser } from '../packages/server/src/repo/oauth.js';

// 用脚本自身位置定位仓库根，避免"在哪个目录执行"决定文件写到哪里
const FIXTURE = fileURLToPath(new URL('../.data/m4-fixture.json', import.meta.url));
const env = loadEnv();
const db = createDb(env.dbUrl);
const graph = createGraphContext(db, env);
if (!graph) {
  console.error('OAuth 未配置');
  process.exit(1);
}

const accounts = await db.query<{ user_id: string }>('SELECT user_id FROM oauth_account LIMIT 1');
const userId = accounts[0]?.user_id ?? '';
const account = await findAccountByUser(db, userId);
if (!account) {
  console.error('没有已连接的账号');
  process.exit(1);
}
const token = await graph.tokens.accessTokenFor(userId);

function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const command = process.argv[2] ?? 'create';

if (command === 'create') {
  const day = todayInShanghai();
  const calendarId = await createCalendar(token, `M4 UI ${Date.now().toString(36)}`);

  const singleId = await createEvent(token, calendarId, {
    subject: 'M4 单次会议',
    start: { dateTime: `${day}T16:00:00.0000000`, timeZone: 'Asia/Shanghai' },
    end: { dateTime: `${day}T17:00:00.0000000`, timeZone: 'Asia/Shanghai' },
  });
  const recurringId = await createEvent(token, calendarId, {
    subject: 'M4 每周例会',
    start: { dateTime: `${day}T15:00:00.0000000`, timeZone: 'Asia/Shanghai' },
    end: { dateTime: `${day}T15:30:00.0000000`, timeZone: 'Asia/Shanghai' },
    recurrence: {
      pattern: {
        type: 'weekly',
        interval: 1,
        daysOfWeek: [
          new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Shanghai' })
            .format(new Date())
            .toLowerCase(),
        ],
      },
      range: { type: 'numbered', numberOfOccurrences: 3, startDate: day, recurrenceTimeZone: 'Asia/Shanghai' },
    },
  });

  await refreshSources(db, userId, account.id, token);
  const pull = await pullEvents({ db, tokens: graph.tokens, userId });
  fs.writeFileSync(
    FIXTURE,
    JSON.stringify({ calendarId, singleId, recurringId, day, createdAt: Date.now() }, null, 2),
  );
  console.log(`夹具已就绪：${day} 16:00 单次会议 / 15:00 每周例会（新增 ${pull.added} 条）`);
} else if (command === 'verify') {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { singleId: string; day: string };
  const remote = await getEvent(token, fixture.singleId);
  const rows = await db.query<Record<string, unknown>>(
    'SELECT id, start_at, sync_state, rev FROM cal_event WHERE ms_event_id = ?',
    [fixture.singleId],
  );
  const ops = await db.query<Record<string, unknown>>(
    'SELECT status, action FROM op_outbox WHERE entity_id = ?',
    [rows[0]?.id ?? ''],
  );
  const localTime = new Date(Number(rows[0]?.start_at ?? 0)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const remoteTime = remote.start?.dateTime.slice(11, 16) ?? '?';
  const moved = remoteTime !== '16:00';

  console.log(`本地 ${localTime} / Outlook ${remoteTime} / sync_state=${String(rows[0]?.sync_state)}`);
  console.log(`回写队列：${ops.map((op) => `${String(op.action)}:${String(op.status)}`).join(', ') || '无'}`);
  if (!moved) {
    console.error('✗ Outlook 侧时间没有变化：回写没有落到 Graph');
    process.exitCode = 1;
  } else if (remoteTime !== localTime.replace(/^24:/, '00:')) {
    console.error('✗ 本地与 Outlook 时间不一致');
    process.exitCode = 1;
  } else {
    console.log('✓ 拖动后的时间已经回写到 Outlook，且两边一致');
  }
} else {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { calendarId: string };
  await deleteCalendar(token, fixture.calendarId);
  await refreshSources(db, userId, account.id, token);
  const pull = await pullEvents({ db, tokens: graph.tokens, userId });
  fs.rmSync(FIXTURE, { force: true });
  console.log(`夹具已清理（removed=${pull.removed}）`);
}

await db.close();
