/**
 * Graph 字段探针（一次性诊断脚本，不是测试）。
 *
 * 用来确认三件不能靠猜的事：
 *   1. `/me/events/delta` 是否带 @odata.etag（自回声判定全靠它）
 *   2. parentFolderId 是否等于 /me/calendars 的 id（事件归属哪个日历）
 *   3. recurrence 结构与 rruleFromGraph 的映射是否对得上
 *
 * 用法：在 packages/server 下 `./node_modules/.bin/tsx ../../tools/graph-probe.ts`
 */
import { createDb } from '../packages/server/src/db/index.js';
import { loadEnv } from '../packages/server/src/env.js';
import { createGraphContext } from '../packages/server/src/graph/context.js';
import { deltaEventsPage, deltaStartUrl, listCalendars } from '../packages/server/src/graph/client.js';
import { rruleFromGraph } from '../packages/server/src/graph/recurrence.js';
import { findAccountByUser } from '../packages/server/src/repo/oauth.js';

const env = loadEnv();
const db = createDb(env.dbUrl);
const graph = createGraphContext(db, env);
if (!graph) {
  console.error('OAuth 未配置');
  process.exit(1);
}

const accounts = await db.query<{ user_id: string }>('SELECT user_id FROM oauth_account LIMIT 1');
const userId = accounts[0]?.user_id;
if (!userId) {
  console.error('没有已连接的账号');
  process.exit(1);
}

const account = await findAccountByUser(db, userId);
console.log('账户:', account?.email, '状态:', account?.status);
const token = await graph.tokens.accessTokenFor(userId);
console.log('拿到令牌:', token.slice(0, 6) + '…', '长度', token.length);

const calendars = await listCalendars(token);
console.log('\n日历列表:');
for (const cal of calendars) {
  console.log(`  ${cal.canEdit ? '可写' : '只读'}  ${cal.id.slice(0, 24)}…  ${cal.name}`);
}

// 先探一个关键问题：能不能按日历拉 delta（决定 source 归属怎么算）
const editable = calendars.find((cal) => cal.canEdit);
if (editable) {
  for (const path of [
    `/me/calendars/${encodeURIComponent(editable.id)}/events/delta?$select=${encodeURIComponent('id,subject,type,recurrence,iCalUId,start,end,isAllDay,webLink,isCancelled')}`,
  ]) {
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          prefer: 'outlook.timezone="Asia/Shanghai", odata.maxpagesize=3',
        },
      });
      const text = await res.text();
      console.log(`\n[按日历 delta] ${path.slice(0, 60)}… → ${res.status}`);
      console.log(text.slice(0, 300));
    } catch (err) {
      console.log('[按日历 delta] 请求失败', err);
    }
  }
}

const page = await deltaEventsPage(token, deltaStartUrl(editable?.id ?? calendars[0]!.id));
console.log('\ndelta 第一页:', page.events.length, '条, nextLink:', Boolean(page.nextLink), 'deltaLink:', Boolean(page.deltaLink));

const keys = new Set<string>();
for (const event of page.events) for (const key of Object.keys(event)) keys.add(key);
console.log('事件字段:', [...keys].sort().join(', '));

const sample = page.events.find((event) => event.recurrence) ?? page.events[0];
if (sample) {
  console.log('\n样例事件:');
  console.log(JSON.stringify(
    {
      id: sample.id?.slice(0, 30),
      subject: sample.subject,
      type: sample.type,
      etag: sample['@odata.etag'],
      start: sample.start,
      end: sample.end,
      isAllDay: sample.isAllDay,
      webLink: sample.webLink ? 'yes' : null,
      seriesMasterId: sample.seriesMasterId ? 'yes' : null,
    },
    null,
    1,
  ));
}

const recurring = page.events.find((event) => event.recurrence);
if (recurring) {
  console.log('\n重复事件 recurrence:', JSON.stringify(recurring.recurrence));
  console.log('映射结果:', JSON.stringify(rruleFromGraph(recurring.recurrence, 'Asia/Shanghai')));
} else {
  console.log('\n（账号里没有重复事件，无法验证 recurrence 映射）');
}

await db.close();
