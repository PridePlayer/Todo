import {
  compareHlc,
  syncPullRequestSchema,
  syncPushRequestSchema,
  type Hlc,
  type SyncConflict,
  type SyncOp,
  type SyncOpResult,
} from '@grid/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { resolveSession } from '../auth/session.js';
import type { Db, Row, SqlExecutor } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { HttpError } from '../http/errors.js';
import { mergeFields, normalizeHlc } from '../sync/merge.js';
import { fieldsToColumns, isKnownField, rowToPayload, type SyncTableName } from '../sync/task-map.js';

interface Deps {
  db: Db;
  env: AppEnv;
}

const TABLES: SyncTableName[] = ['task', 'tag', 'list', 'recur_exception'];

const DEFAULTS: Record<SyncTableName, Record<string, unknown>> = {
  task: {
    list_id: 'list-inbox',
    parent_id: null,
    depth: 0,
    note: null,
    quadrant: 1,
    important: 0,
    urgent: 0,
    priority: 0,
    due_date: null,
    start_at: null,
    end_at: null,
    all_day: 1,
    location: null,
    tag_ids: null,
    completed_at: null,
    archived_at: null,
    sort_order: 0,
    rrule: null,
    remind_at: null,
  },
  tag: { color_key: 0 },
  list: { sort_order: 0 },
  recur_exception: {
    kind: 'override',
    override_start: null,
    override_end: null,
    override_title: null,
    override_payload: null,
  },
};

const REQUIRED: Record<SyncTableName, string | null> = {
  task: 'title',
  tag: 'name',
  list: 'name',
  recur_exception: 'seriesId',
};

/** 表名只来自白名单，绝不能从请求里拼 */
function assertTable(name: string): SyncTableName {
  if (!TABLES.includes(name as SyncTableName)) throw new HttpError(400, 'bad_table', `不支持的同步表：${name}`);
  return name as SyncTableName;
}

function buildInsert(table: SyncTableName, columns: Record<string, unknown>): { sql: string; params: unknown[] } {
  const keys = Object.keys(columns);
  const placeholders = keys.map(() => '?').join(', ');
  return {
    sql: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
    params: keys.map((key) => columns[key]),
  };
}

function buildUpdate(table: SyncTableName, columns: Record<string, unknown>): { sql: string; params: unknown[] } {
  const keys = Object.keys(columns).filter((key) => key !== 'id' && key !== 'user_id');
  return {
    sql: `UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
    params: [...keys.map((key) => columns[key]), columns.id, columns.user_id],
  };
}

export async function syncRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { db, env } = deps;

  async function requireUser(req: FastifyRequest): Promise<string> {
    const raw = req.cookies[env.cookieName];
    const userId = typeof raw === 'string' ? await resolveSession(db, raw, env.sessionTtlMs) : null;
    if (!userId) throw new HttpError(401, 'unauthenticated', '请先登录');
    return userId;
  }

  async function currentSeq(tx: SqlExecutor = db): Promise<number> {
    const rows = await tx.query<{ seq: unknown }>('SELECT seq FROM change_seq WHERE id = 1');
    return Number(rows[0]?.seq ?? 0);
  }

  // ── 拉取：单个 cursor 跨表增量 ─────────────────────────────
  app.post('/sync/pull', async (req) => {
    const userId = await requireUser(req);
    const body = syncPullRequestSchema.parse(req.body ?? {});
    const limit = body.limit;

    // 每表各取 limit+1 条后在内存归并排序：比 UNION ALL 更可移植（SQLite/MySQL 的类型转换不一致）
    const gathered: { table: SyncTableName; row: Row }[] = [];
    for (const table of TABLES) {
      const rows = await db.query<Row>(
        `SELECT * FROM ${table} WHERE user_id = ? AND change_seq > ? ORDER BY change_seq ASC LIMIT ${limit + 1}`,
        [userId, body.cursor],
      );
      for (const row of rows) gathered.push({ table, row });
    }
    gathered.sort((a, b) => Number(a.row.change_seq) - Number(b.row.change_seq));

    const page = gathered.slice(0, limit);
    const changes = page.map(({ table, row }) => {
      const deletedAt = row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at);
      return {
        table,
        id: String(row.id),
        rev: Number(row.rev),
        seq: Number(row.change_seq),
        deletedAt,
        payload: deletedAt === null ? rowToPayload(table, row) : null,
      };
    });

    const nextCursor = page.length > 0 ? Number(page[page.length - 1]!.row.change_seq) : body.cursor;

    return {
      changes,
      nextCursor,
      hasMore: gathered.length > limit,
      // tombstone 清理任务尚未实现（M6），因此不存在"游标太老"的情况
      resyncRequired: false,
      serverCursor: await currentSeq(),
    };
  });

  // ── 推送：一个 op 一个事务 ────────────────────────────────
  app.post('/sync/push', async (req) => {
    const userId = await requireUser(req);
    const body = syncPushRequestSchema.parse(req.body ?? {});
    const results: SyncOpResult[] = [];

    for (const op of body.ops) {
      const table = assertTable(op.table);
      try {
        const result = await db.transaction((tx) => applyOp(tx, userId, table, op));
        results.push(result);
      } catch (error) {
        req.log.error({ err: error, opId: op.opId }, 'sync op failed');
        results.push({
          opId: op.opId,
          status: 'rejected',
          reason: error instanceof Error ? error.message.slice(0, 120) : 'internal_error',
        });
      }
    }

    return { results, serverCursor: await currentSeq() };
  });

  app.get('/sync/state', async (req) => {
    const userId = await requireUser(req);
    const tasks = await db.query<{ c: unknown }>('SELECT COUNT(*) AS c FROM task WHERE user_id = ?', [userId]);
    const tags = await db.query<{ c: unknown }>('SELECT COUNT(*) AS c FROM tag WHERE user_id = ?', [userId]);
    const conflicts = await db.query<{ c: unknown }>(
      'SELECT COUNT(*) AS c FROM conflict_log WHERE user_id = ? AND resolved_at IS NULL',
      [userId],
    );
    return {
      serverCursor: await currentSeq(),
      tasks: Number(tasks[0]?.c ?? 0),
      tags: Number(tags[0]?.c ?? 0),
      conflicts: Number(conflicts[0]?.c ?? 0),
    };
  });

  async function applyOp(
    tx: SqlExecutor,
    userId: string,
    table: SyncTableName,
    op: SyncOp,
  ): Promise<SyncOpResult> {
    // 1) 幂等：同一个 opId 重放直接返回 duplicate
    const seen = await tx.query<Row>('SELECT status FROM op_applied WHERE op_id = ?', [op.opId]);
    if (seen.length > 0) return { opId: op.opId, status: 'duplicate' };

    const now = Date.now();
    const hlc = normalizeHlc(op.hlc, now);

    const existing = await tx.query<Row>(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`, [op.id, userId]);
    const row = existing[0];

    if (op.action === 'delete') {
      if (!row) {
        // 已经是删除态（或从没存在过）→ 幂等成功，不制造墓碑
        return { opId: op.opId, status: 'applied', rev: 0, seq: await currentSeq(tx) };
      }
      const seq = await db.nextSeq(tx);
      const rev = Number(row.rev) + 1;
      await tx.query(
        `UPDATE ${table} SET deleted_at = ?, updated_at = ?, rev = ?, change_seq = ?, hlc_wall = ?, hlc_counter = ?, hlc_device = ? WHERE id = ? AND user_id = ?`,
        [now, now, rev, seq, hlc.wall, hlc.counter, hlc.device, op.id, userId],
      );
      await recordOp(tx, userId, table, op, 'applied', rev, seq, now);
      return { opId: op.opId, status: 'applied', rev, seq };
    }

    // 2) 新建
    if (!row) {
      const missing = REQUIRED[table];
      if (missing && (op.fields[missing] === undefined || op.fields[missing] === null || op.fields[missing] === '')) {
        return { opId: op.opId, status: 'rejected', reason: `missing_${missing}` };
      }
      const seq = await db.nextSeq(tx);
      const columns: Record<string, unknown> = {
        id: op.id,
        user_id: userId,
        rev: 1,
        change_seq: seq,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        hlc_wall: hlc.wall,
        hlc_counter: hlc.counter,
        hlc_device: hlc.device,
        ...DEFAULTS[table],
        ...fieldsToColumns(table, op.fields),
      };
      // 物化路径由服务端兜底：客户端没带就退化成 "id/"，绝不存空串（空串会让子树前缀查询失效）
      if (table === 'task' && (columns.path === undefined || columns.path === '')) {
        columns.path = `${op.id}/`;
      }
      const { sql, params } = buildInsert(table, columns);
      await tx.query(sql, params);
      await recordOp(tx, userId, table, op, 'applied', 1, seq, now);
      const inserted = await tx.query<Row>(`SELECT * FROM ${table} WHERE id = ?`, [op.id]);
      return {
        opId: op.opId,
        status: 'applied',
        rev: 1,
        seq,
        serverPayload: inserted[0] ? rowToPayload(table, inserted[0]) : null,
      };
    }

    // 3) 更新：字段级合并
    const current = rowToPayload(table, row);
    const currentHlc: Hlc = {
      wall: Number(row.hlc_wall ?? 0),
      counter: Number(row.hlc_counter ?? 0),
      device: String(row.hlc_device ?? ''),
    };
    const localNewer = compareHlc(hlc, currentHlc) > 0;

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(op.fields)) {
      if (key !== 'id' && isKnownField(table, key)) sanitized[key] = value;
    }

    const merge = mergeFields(table, {
      base: op.base,
      incoming: sanitized,
      current,
      localNewer,
    });

    const appliedKeys = Object.keys(merge.applied);

    if (appliedKeys.length === 0) {
      // 没有字段需要写，但仍要把冲突记下来——用户要知道"另一边也有一个版本"
      await logConflicts(tx, userId, table, op.id, merge.conflicts, 'remote', now);
      await recordOp(tx, userId, table, op, merge.conflicts.length > 0 ? 'conflict' : 'applied', Number(row.rev), Number(row.change_seq), now);
      return {
        opId: op.opId,
        status: merge.conflicts.length > 0 ? 'conflict' : 'applied',
        rev: Number(row.rev),
        seq: Number(row.change_seq),
        conflicts: merge.conflicts,
        serverPayload: current,
      };
    }

    const seq = await db.nextSeq(tx);
    const rev = Number(row.rev) + 1;
    const columns: Record<string, unknown> = {
      ...fieldsToColumns(table, merge.applied),
      rev,
      change_seq: seq,
      updated_at: now,
      hlc_wall: hlc.wall,
      hlc_counter: hlc.counter,
      hlc_device: hlc.device,
      id: op.id,
      user_id: userId,
    };
    const { sql, params } = buildUpdate(table, columns);
    await tx.query(sql, params);

    await logConflicts(tx, userId, table, op.id, merge.conflicts, 'local', now);
    await recordOp(tx, userId, table, op, merge.conflicts.length > 0 ? 'conflict' : 'applied', rev, seq, now);

    const after = await tx.query<Row>(`SELECT * FROM ${table} WHERE id = ?`, [op.id]);
    return {
      opId: op.opId,
      status: merge.conflicts.length > 0 ? 'conflict' : 'applied',
      rev,
      seq,
      conflicts: merge.conflicts,
      serverPayload: after[0] ? rowToPayload(table, after[0]) : null,
    };
  }

  async function recordOp(
    tx: SqlExecutor,
    userId: string,
    table: SyncTableName,
    op: SyncOp,
    status: string,
    rev: number,
    seq: number,
    now: number,
  ): Promise<void> {
    await tx.query(
      'INSERT INTO op_applied (op_id, user_id, table_name, row_id, status, rev, seq, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [op.opId, userId, table, op.id, status, rev, seq, now],
    );
  }

  async function logConflicts(
    tx: SqlExecutor,
    userId: string,
    table: SyncTableName,
    rowId: string,
    conflicts: SyncConflict[],
    winner: 'local' | 'remote',
    now: number,
  ): Promise<void> {
    for (const conflict of conflicts) {
      const id = `${now.toString(32)}${Math.random().toString(32).slice(2, 10)}`.slice(0, 26).toUpperCase();
      await tx.query(
        'INSERT INTO conflict_log (id, user_id, table_name, row_id, field, local_value, remote_value, winner, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          userId,
          table,
          rowId,
          conflict.field,
          JSON.stringify(conflict.local ?? null),
          JSON.stringify(conflict.remote ?? null),
          winner,
          null,
          now,
        ],
      );
    }
  }
}
