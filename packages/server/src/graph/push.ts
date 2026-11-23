import { formatZonedDateTime } from '@grid/core';
import type { Db, Row, SqlExecutor } from '../db/types.js';
import { GraphError } from '../oauth/microsoft.js';
import { CAL_TIME_ZONE, deleteEvent, getEvent, patchEvent, type EventPatchBody } from './client.js';
import type { GraphTokens } from './token.js';

/**
 * 回写队列。
 *
 * 为什么要有队列而不是"点保存就 PATCH"：
 *   1. 用户拖一下事件就发一次请求，连续拖五次会打出一串 PATCH，
 *      而 Graph 的限流是**按应用**算的（10k/10min），一次失控的拖拽就可能把整个应用拉黑。
 *   2. 断网、令牌过期、429 都需要重试；把重试塞进 HTTP 请求里，用户就得盯着转圈。
 *   3. 队列是幂等的落点：同一条 op 重放两次，结果一样。
 */

const MAX_ATTEMPTS = 5;
const CLAIM_LIMIT = 5;

export interface DrainResult {
  done: number;
  retried: number;
  dead: number;
  skipped: number;
}

export async function drainOutbox(
  deps: { db: Db; tokens: GraphTokens; userId: string },
  opts: { limit?: number } = {},
): Promise<DrainResult> {
  const { db, tokens, userId } = deps;
  const now = Date.now();
  const limit = opts.limit ?? CLAIM_LIMIT;

  const rows = await db.query<Row>(
    "SELECT * FROM op_outbox WHERE user_id = ? AND status = 'pending' AND next_run_at <= ? ORDER BY created_at ASC LIMIT ?",
    [userId, now, limit],
  );
  const result: DrainResult = { done: 0, retried: 0, dead: 0, skipped: 0 };
  if (rows.length === 0) return result;

  const accessToken = await tokens.accessTokenFor(userId);

  for (const row of rows) {
    const event = await db.query<Row>('SELECT * FROM cal_event WHERE id = ?', [row.entity_id]);
    const target = event[0];
    if (!target) {
      // 事件在本地已经没了：这条 op 没有意义，直接落地避免永远重试
      await db.query("UPDATE op_outbox SET status = 'done' WHERE id = ?", [row.id]);
      result.skipped += 1;
      continue;
    }

    try {
      await tokens.translate(userId, () => pushOne(accessToken, db, row, target));
      await db.query("UPDATE op_outbox SET status = 'done', last_error = NULL WHERE id = ?", [row.id]);
      result.done += 1;
    } catch (err) {
      const outcome = await handleFailure(db, row, err);
      if (outcome === 'dead') result.dead += 1;
      else result.retried += 1;
    }
  }

  return result;
}

async function pushOne(accessToken: string, db: Db, op: Row, target: Row): Promise<void> {
  const action = String(op.action);
  const msEventId = String(target.ms_event_id);
  const baseEtag = typeof op.base_etag === 'string' && op.base_etag !== '' ? op.base_etag : null;
  const now = Date.now();

  if (action === 'delete') {
    await deleteEvent(accessToken, msEventId, baseEtag);
    await db.query(
      "UPDATE cal_event SET sync_state = 'synced', last_pushed_at = ?, push_attempts = 0 WHERE id = ?",
      [now, target.id],
    );
    return;
  }

  const payload = parsePayload(op.payload);
  const body: EventPatchBody = {};
  if (typeof payload.subject === 'string' && payload.subject !== '') body.subject = payload.subject;
  if (typeof payload.allDay === 'boolean') body.isAllDay = payload.allDay;

  if (typeof payload.startAt === 'number' && typeof payload.endAt === 'number') {
    const allDay = payload.allDay === true || Number(target.is_all_day) === 1;
    // Graph 的 start/end 是"该时区的墙上时间"，不是 epoch。
    // 直接传 epoch 会被解析成 1970 年——这类错误在日历上表现为事件消失。
    if (allDay) {
      const startDate = formatZonedDateTime(payload.startAt, CAL_TIME_ZONE).slice(0, 10);
      const endDate = formatZonedDateTime(payload.endAt, CAL_TIME_ZONE).slice(0, 10);
      body.start = { dateTime: `${startDate}T00:00:00.0000000`, timeZone: CAL_TIME_ZONE };
      body.end = { dateTime: `${endDate}T00:00:00.0000000`, timeZone: CAL_TIME_ZONE };
    } else {
      body.start = { dateTime: `${formatZonedDateTime(payload.startAt, CAL_TIME_ZONE)}.0000000`, timeZone: CAL_TIME_ZONE };
      body.end = { dateTime: `${formatZonedDateTime(payload.endAt, CAL_TIME_ZONE)}.0000000`, timeZone: CAL_TIME_ZONE };
    }
  }

  if (Object.keys(body).length === 0) {
    // 只改了本地不参与回写的字段（比如颜色档位）：标记为已同步即可
    await db.query("UPDATE cal_event SET sync_state = 'synced', last_pushed_at = ? WHERE id = ?", [now, target.id]);
    return;
  }

  await patchEvent(accessToken, msEventId, body, baseEtag);

  // PATCH 之后本地要立刻记下"已推送"：delta 会很快把这次改动回送一遍，
  // 认出 etag 才能判成自回声而不是"远端又改了一次"。
  const refreshed = await getEvent(accessToken, msEventId);
  await db.query(
    "UPDATE cal_event SET sync_state = 'synced', last_pushed_at = ?, push_attempts = 0, ms_etag = ? WHERE id = ?",
    [now, refreshed['@odata.etag'] ?? target.ms_etag ?? null, target.id],
  );
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function handleFailure(db: Db, op: Row, err: unknown): Promise<'dead' | 'retry'> {
  const attempts = Number(op.attempts ?? 0) + 1;
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof GraphError ? err.status : 0;
  const now = Date.now();

  // 412：远端在我们读与写之间被改过（多半是用户同时在 Outlook 网页版上动了它）。
  // 重新取一次 etag 再试——但不能无限重试，三次之后交给人处理。
  if (err instanceof GraphError && err.status === 412 && attempts <= 3) {
    await db.query(
      "UPDATE op_outbox SET status = 'pending', attempts = ?, next_run_at = ?, last_error = ? WHERE id = ?",
      [attempts, now, '远端已变更，正在重新对齐', op.id],
    );
    return 'retry';
  }

  if (err instanceof GraphError && err.status === 404) {
    // 事件在 Outlook 侧已经不在了：本地也应该消失（不是留着一条"未知事件"）
    const targetRows = await db.query<Row>('SELECT id, deleted_at FROM cal_event WHERE id = ?', [op.entity_id]);
    const target = targetRows[0];
    if (target && target.deleted_at === null) {
      await db.transaction(async (tx) => {
        const seq = await db.nextSeq(tx);
        await tx.query(
          'UPDATE cal_event SET deleted_at = ?, rev = rev + 1, change_seq = ?, updated_at = ? WHERE id = ?',
          [now, seq, now, target.id],
        );
      });
    }
    await db.query("UPDATE op_outbox SET status = 'done', last_error = ? WHERE id = ?", ['事件已不存在', op.id]);
    return 'dead';
  }

  const retryable = status === 0 || status === 429 || status >= 500;
  if (retryable && attempts < MAX_ATTEMPTS) {
    const backoff = Math.min(60_000, 1000 * 2 ** attempts);
    await db.query(
      "UPDATE op_outbox SET status = 'pending', attempts = ?, next_run_at = ?, last_error = ? WHERE id = ?",
      [attempts, now + backoff, message.slice(0, 500), op.id],
    );
    await db.query('UPDATE cal_event SET push_attempts = ? WHERE id = ?', [attempts, op.entity_id]);
    return 'retry';
  }

  await db.query(
    "UPDATE op_outbox SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?",
    [attempts, message.slice(0, 500), op.id],
  );
  await db.query("UPDATE cal_event SET sync_state = 'failed', push_attempts = ? WHERE id = ?", [
    attempts,
    op.entity_id,
  ]);
  return 'dead';
}

/** 客户端同步 op 落到 cal_event 之后调用：排一条回写 */
export async function enqueueGraphOp(
  tx: SqlExecutor,
  userId: string,
  action: 'create' | 'update' | 'delete',
  eventId: string,
  payload: Record<string, unknown>,
  baseEtag: string | null,
  now: number,
): Promise<void> {
  if (action === 'create') return; // GRID 不创建 Outlook 事件（P0）
  const id = `${now.toString(32)}${Math.random().toString(32).slice(2, 12)}`.slice(0, 26).toUpperCase();
  const opId = `G${id}`.slice(0, 32);
  await tx.query(
    'INSERT INTO op_outbox (id, user_id, op_id, entity, entity_id, action, payload, base_etag, status, attempts, ' +
      "next_run_at, last_error, created_at) VALUES (?, ?, ?, 'event', ?, ?, ?, ?, 'pending', 0, ?, NULL, ?)",
    [id, userId, opId, eventId, action, JSON.stringify(payload), baseEtag, now, now],
  );
}
