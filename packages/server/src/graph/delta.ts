import { toIanaTimeZone, parseZonedDateTime } from '@grid/core';
import type { Db, Row } from '../db/types.js';
import { GraphError } from '../oauth/microsoft.js';
import { num } from '../repo/oauth.js';
import { CAL_TIME_ZONE, deltaEventsPage, deltaStartUrl, type GraphEvent } from './client.js';
import { rruleFromGraph } from './recurrence.js';
import { newRowId, refreshSources, loadSources, retireSource, type SourceRow } from './sources.js';
import type { GraphTokens } from './token.js';

/**
 * 增量拉取：**按日历**拉 `/me/calendars/{id}/events/delta` → cal_event。
 *
 * 三条不能让步的设计（见 docs/07 ADR-021/022）：
 *   1. 只镜像"母体 + 单次事件"，把 `type=exception` 的单次改写丢掉。
 *      P0 的重复事件是只读的，镜像例外需要一套"Outlook 例外"的独立合并语义；
 *      漏掉的那一次若在 Outlook 里改了时间，GRID 上仍显示原时间——这个偏差已写进文档。
 *   2. 不用 `calendarView/delta`：它把重复事件展开成实例，每个实例有自己的 id，
 *      窗口一滑动就"新增一堆、消失一堆"，本地再也无法用 RRULE 展开。
 *   3. 不用 `/me/events/delta` 一把抓：事件对象里没有 calendarId，
 *      `$select=parentFolderId` 会被 Graph 直接拒绝，于是无法判断归属日历，
 *      "节假日不同步""只读日历不能拖"就都实现不了。
 */

const PAGES_MAX = 60;
const DAY = 24 * 60 * 60 * 1000;

export interface PullResult {
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  pages: number;
  /** 有游标被重置（410 / resyncRequired）时为 true */
  resynced: boolean;
}

export interface PullDeps {
  db: Db;
  tokens: GraphTokens;
  userId: string;
}

export async function pullEvents(deps: PullDeps, opts: { forceFull?: boolean } = {}): Promise<PullResult> {
  const { db, tokens, userId } = deps;
  const account = await tokens.accountFor(userId);
  const accessToken = await tokens.accessTokenFor(userId);

  // 源列表空着就没法给事件归属日历：先发现一次
  let sources = await loadSources(db, userId);
  if (sources.length === 0) {
    sources = await refreshSources(db, userId, account.id, accessToken);
  }

  const total: PullResult = { added: 0, updated: 0, removed: 0, skipped: 0, pages: 0, resynced: false };

  // 一个源失败不该拖垮其它源：某本日历被删、权限被收回都会让那一路一直 4xx，
  // 若直接抛出去，其它日历就永远同步不了（而且错误看起来像"整个同步挂了"）
  let firstError: unknown = null;
  let succeeded = 0;

  for (const source of sources) {
    // 用户关掉的日历一条都不拉：既省请求，也避免"关了还在涨"的困惑
    if (Number(source.is_synced) !== 1) continue;
    try {
      const one = await pullSource(db, tokens, userId, accessToken, source, opts.forceFull === true);
      total.added += one.added;
      total.updated += one.updated;
      total.removed += one.removed;
      total.skipped += one.skipped;
      total.pages += one.pages;
      total.resynced = total.resynced || one.resynced;
      succeeded += 1;
    } catch (err) {
      // 授权失效是全局问题：必须立刻上抛，让 UI 出红色通栏
      if (err instanceof GraphError && (err.status === 401 || err.status === 403)) throw err;
      firstError = firstError ?? err;
    }
  }

  if (succeeded === 0 && firstError) throw firstError;

  const now = Date.now();
  await db.query('UPDATE oauth_account SET last_sync_at = ?, window_start = ?, window_end = ? WHERE id = ?', [
    now,
    now - 180 * DAY,
    now + 180 * DAY,
    account.id,
  ]);
  return total;
}

async function pullSource(
  db: Db,
  tokens: GraphTokens,
  userId: string,
  accessToken: string,
  source: SourceRow,
  forceFull: boolean,
): Promise<PullResult> {
  const result: PullResult = { added: 0, updated: 0, removed: 0, skipped: 0, pages: 0, resynced: false };
  let url = !forceFull && source.delta_link ? source.delta_link : deltaStartUrl(source.ms_calendar_id);

  for (let page = 0; page < PAGES_MAX; page += 1) {
    let response;
    try {
      response = await tokens.translate(userId, () => deltaEventsPage(accessToken, url));
    } catch (err) {
      // 日历本身没了（用户在 Outlook 里删了它）：退休这个源，别让它拖住整个同步
      if (isSourceGone(err)) {
        result.removed += await retireSource(db, userId, source.id);
        return result;
      }
      // 游标过期：清空后从头再来一次（只重来一次，不是无限重试）
      if (!result.resynced && isCursorGone(err)) {
        result.resynced = true;
        await db.query('UPDATE calendar_source SET delta_link = NULL WHERE id = ?', [source.id]);
        url = deltaStartUrl(source.ms_calendar_id);
        continue;
      }
      throw err;
    }

    result.pages += 1;
    for (const event of response.events) {
      const outcome = await applyEvent(db, userId, source.id, event);
      if (outcome !== 'skipped') result[outcome] += 1;
      else result.skipped += 1;
    }

    if (response.nextLink) {
      url = response.nextLink;
      continue;
    }

    // 只有 deltaLink 才代表"这一轮全部拿完了"。
    // 把 nextLink 当 deltaLink 存的话，分页没走完就重置，中间的事件会永久丢失。
    if (response.deltaLink) {
      await db.query('UPDATE calendar_source SET delta_link = ? WHERE id = ?', [response.deltaLink, source.id]);
    }
    return result;
  }

  // 翻到上限还没拿到 deltaLink：不写游标，下一轮从旧游标重来（重放幂等）
  return result;
}

function isSourceGone(err: unknown): boolean {
  if (!(err instanceof GraphError)) return false;
  const code = err.graphCode.toLowerCase();
  return err.status === 404 || code === 'erroritemnotfound';
}

function isCursorGone(err: unknown): boolean {
  if (!(err instanceof GraphError)) return false;
  if (err.status === 410) return true;
  const code = err.graphCode.toLowerCase();
  return code === 'resyncrequired' || code === 'syncstatetokenexpired' || code === 'syncstatemissing';
}

type Outcome = 'added' | 'updated' | 'removed' | 'skipped';

async function applyEvent(db: Db, userId: string, sourceId: string, event: GraphEvent): Promise<Outcome> {
  const msEventId = typeof event.id === 'string' ? event.id : '';
  if (msEventId === '') return 'skipped';

  const existingRows = await db.query<Row>(
    'SELECT * FROM cal_event WHERE user_id = ? AND ms_event_id = ? LIMIT 1',
    [userId, msEventId],
  );
  const existing = existingRows[0];
  const now = Date.now();

  if (event['@removed'] || event.isCancelled === true) {
    if (!existing || existing.deleted_at !== null) return 'skipped';
    const id = String(existing.id);
    await db.transaction(async (tx) => {
      const seq = await db.nextSeq(tx);
      await tx.query('UPDATE cal_event SET deleted_at = ?, rev = rev + 1, change_seq = ?, updated_at = ? WHERE id = ?', [
        now,
        seq,
        now,
        id,
      ]);
    });
    return 'removed';
  }

  // 单次改写（type=exception）：P0 不镜像
  if (event.type === 'exception') return 'skipped';

  const times = eventTimes(event);
  if (!times) return 'skipped';

  const recurrence = event.recurrence ? rruleFromGraph(event.recurrence, times.tzid) : null;
  const etag = event['@odata.etag'] ?? null;

  const desired: Record<string, unknown> = {
    source_id: sourceId,
    ms_event_id: msEventId,
    ms_ical_uid: event.iCalUId ?? null,
    ms_series_master_id: event.seriesMasterId ?? null,
    subject: (event.subject ?? '(无标题)').slice(0, 512),
    body_preview: trim(event.bodyPreview, 1024),
    location: trim(event.location?.displayName ?? null, 256),
    start_at: times.startAt,
    end_at: times.endAt,
    is_all_day: event.isAllDay === true ? 1 : 0,
    tzid: times.tzid,
    is_organizer: event.isOrganizer === true ? 1 : 0,
    response_status: trim(event.responseStatus?.response ?? null, 24),
    is_recurring: recurrence ? 1 : event.type === 'seriesMaster' ? 1 : 0,
    rrule: recurrence?.rrule ?? null,
    recurrence_raw: event.recurrence ? JSON.stringify(event.recurrence).slice(0, 4000) : null,
    web_link: trim(event.webLink ?? null, 1024),
    ms_etag: etag,
  };

  if (!existing) {
    const id = newRowId();
    await db.transaction(async (tx) => {
      const seq = await db.nextSeq(tx);
      const keys = Object.keys(desired);
      const columns = ['id', 'user_id', 'created_at', 'rev', 'change_seq', 'updated_at', 'deleted_at', 'sync_state', ...keys];
      const values = [id, userId, now, 1, seq, now, null, 'synced', ...keys.map((key) => desired[key])];
      await tx.query(
        `INSERT INTO cal_event (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        values,
      );
    });
    return 'added';
  }

  const id = String(existing.id);

  // 自回声：etag 与我们刚写上去的一模一样 → 就是自己那次 PATCH 回来了
  if (etag && existing.ms_etag === etag) return 'skipped';

  // 本地有改动正在回写：等队列处理完，别让远端旧值把本地刚拖的那一下吃掉
  if (existing.sync_state === 'pending_push') return 'skipped';

  const contentKeys = Object.keys(desired).filter((key) => key !== 'ms_etag');
  const contentSame = contentKeys.every((key) => sameValue(existing[key], desired[key]));
  if (contentSame) {
    // 内容没变、只有 etag 变了：只更新 etag，不动 rev/seq，
    // 否则用户什么都没做，日历每 30 秒重绘一次
    if (etag !== existing.ms_etag) {
      await db.query('UPDATE cal_event SET ms_etag = ? WHERE id = ?', [etag, id]);
    }
    return 'skipped';
  }

  await db.transaction(async (tx) => {
    const seq = await db.nextSeq(tx);
    const keys = Object.keys(desired);
    await tx.query(
      `UPDATE cal_event SET ${keys.map((key) => `${key} = ?`).join(', ')}, rev = rev + 1, change_seq = ?, ` +
        "updated_at = ?, deleted_at = NULL, sync_state = 'synced', push_attempts = 0 WHERE id = ?",
      [...keys.map((key) => desired[key]), seq, now, id],
    );
  });
  return 'updated';
}

function trim(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.length > max ? value.slice(0, max) : value;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  return String(a) === String(b);
}

/** Graph 的日期时间都是"墙上时间 + 时区"，必须显式换算，不能交给 Date 的默认解析 */
export function eventTimes(event: GraphEvent): { startAt: number; endAt: number; tzid: string } | null {
  const start = event.start;
  const end = event.end;
  if (!start?.dateTime || !end?.dateTime) return null;

  if (event.isAllDay === true) {
    // 全天事件：只看日期部分，落在本地时区的 00:00
    const startDate = /^(\d{4}-\d{2}-\d{2})/.exec(start.dateTime)?.[1];
    const endDate = /^(\d{4}-\d{2}-\d{2})/.exec(end.dateTime)?.[1];
    if (!startDate) return null;
    const startAt = parseZonedDateTime(`${startDate}T00:00:00`, CAL_TIME_ZONE);
    if (startAt === null) return null;
    const rawEnd = endDate ? parseZonedDateTime(`${endDate}T00:00:00`, CAL_TIME_ZONE) : null;
    const endAt = rawEnd !== null && rawEnd > startAt ? rawEnd : startAt + DAY;
    return { startAt, endAt, tzid: CAL_TIME_ZONE };
  }

  const tzid = toIanaTimeZone(start.timeZone, CAL_TIME_ZONE);
  const startAt = parseZonedDateTime(start.dateTime, tzid);
  if (startAt === null) return null;
  const endAt = parseZonedDateTime(end.dateTime, toIanaTimeZone(end.timeZone, tzid));
  return { startAt, endAt: endAt !== null && endAt > startAt ? endAt : startAt + 60 * 60 * 1000, tzid };
}

/** 供 /calendar/status 用：最近一次同步的账户状态 */
export async function readSyncState(
  db: Db,
  userId: string,
): Promise<{
  lastSyncAt: number | null;
  lastError: string | null;
  status: string;
  pendingOutbox: number;
  deadOutbox: number;
  events: number;
}> {
  const rows = await db.query<Row>(
    'SELECT status, last_error, last_sync_at FROM oauth_account WHERE user_id = ? AND provider = ?',
    [userId, 'microsoft'],
  );
  const row = rows[0];
  const pending = await db.query<{ c: unknown }>(
    "SELECT COUNT(*) AS c FROM op_outbox WHERE user_id = ? AND status IN ('pending', 'running')",
    [userId],
  );
  const dead = await db.query<{ c: unknown }>(
    "SELECT COUNT(*) AS c FROM op_outbox WHERE user_id = ? AND status = 'dead'",
    [userId],
  );
  const events = await db.query<{ c: unknown }>(
    'SELECT COUNT(*) AS c FROM cal_event WHERE user_id = ? AND deleted_at IS NULL',
    [userId],
  );
  return {
    lastSyncAt: row ? num(row.last_sync_at) : null,
    lastError: row ? (typeof row.last_error === 'string' ? row.last_error : null) : null,
    status: row ? (typeof row.status === 'string' ? row.status : 'active') : 'active',
    pendingOutbox: Number(pending[0]?.c ?? 0),
    deadOutbox: Number(dead[0]?.c ?? 0),
    events: Number(events[0]?.c ?? 0),
  };
}
