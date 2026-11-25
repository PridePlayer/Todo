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
import { requireUser as authenticateRequest } from '../auth/require.js';
import type { Db, Row, SqlExecutor } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { HttpError } from '../http/errors.js';
import { enqueueGraphOp } from '../graph/push.js';
import { checkLogIdentity, clampLogValue, sanitizeHabitFields } from '../sync/habit.js';
import { mergeFields, normalizeHlc } from '../sync/merge.js';
import { fieldsToColumns, isKnownField, rowToPayload, type SyncTableName } from '../sync/task-map.js';

interface Deps {
  db: Db;
  env: AppEnv;
}

const TABLES: SyncTableName[] = [
  'task',
  'tag',
  'list',
  'recur_exception',
  'calendar_source',
  'cal_event',
  'habit',
  'habit_log',
];

/**
 * 由服务端 Side 独占写入的表。
 * 客户端可以拉、可以改其中某些字段，但**不能新建**——
 * cal_event 的 ms_event_id / source_id 只有从 Graph 拉回来时才有意义，
 * 让客户端建一条就等于在本地凭空造一个"不存在的会议"。
 */
const SERVER_OWNED: ReadonlySet<SyncTableName> = new Set<SyncTableName>(['cal_event', 'calendar_source']);

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
    remind_lead_minutes: null,
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
  calendar_source: { color_key: 0, sort_order: 0, is_default: 0, is_visible: 1, is_synced: 1, can_edit: 1 },
  cal_event: {
    ms_event_id: '',
    ms_ical_uid: null,
    ms_series_master_id: null,
    subject: '',
    body_preview: null,
    location: null,
    start_at: 0,
    end_at: 0,
    is_all_day: 0,
    tzid: 'Asia/Shanghai',
    is_organizer: 0,
    response_status: null,
    is_recurring: 0,
    rrule: null,
    recurrence_raw: null,
    web_link: null,
    ms_etag: null,
    sync_state: 'synced',
    push_attempts: 0,
    last_pushed_at: null,
  },
  habit: {
    type: 'check',
    target: 1,
    unit: null,
    days_of_week: null,
    color_key: 0,
    sort_order: 0,
    remind_minute: null,
    archived_at: null,
  },
  habit_log: {
    value: 0,
    backfilled: 0,
    note: null,
  },
};

const REQUIRED: Record<SyncTableName, string | null> = {
  task: 'title',
  tag: 'name',
  list: 'name',
  recur_exception: 'seriesId',
  // 服务端独占的表不允许新建，这两个值用不到
  calendar_source: null,
  cal_event: null,
  habit: 'name',
  habit_log: 'habitId',
};

/** 表名只来自白名单，绝不能从请求里拼 */
function assertTable(name: string): SyncTableName {
  if (!TABLES.includes(name as SyncTableName)) throw new HttpError(400, 'bad_table', `不支持的同步表：${name}`);
  return name as SyncTableName;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
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

  // 统一鉴权：Cookie 会话（Web）与 Bearer 设备令牌（Android）都从这里进
  const requireUser = (req: FastifyRequest): Promise<string> => authenticateRequest(db, env, req);

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
      if (table === 'cal_event') {
        // 在 Outlook 里删掉这条会议。客户端已经软删了本地行，这里只负责把意图排进队列
        await enqueueGraphOp(tx, userId, 'delete', op.id, {}, strOrNull(row.ms_etag), now);
      }
      return { opId: op.opId, status: 'applied', rev, seq };
    }

    // 2) 新建
    if (!row) {
      if (SERVER_OWNED.has(table)) {
        return { opId: op.opId, status: 'rejected', reason: 'server_owned_table' };
      }
      const missing = REQUIRED[table];
      if (missing && (op.fields[missing] === undefined || op.fields[missing] === null || op.fields[missing] === '')) {
        return { opId: op.opId, status: 'rejected', reason: `missing_${missing}` };
      }

      // 打卡的两条硬规则，在建行之前收口（见 sync/habit.ts）
      let createFields = op.fields;
      if (table === 'habit') {
        const clean = sanitizeHabitFields(op.fields);
        if (!clean.ok) return { opId: op.opId, status: 'rejected', reason: clean.reason };
        createFields = clean.fields;
      }
      if (table === 'habit_log') {
        const identity = checkLogIdentity(op.id, op.fields.habitId, op.fields.logDate);
        if (!identity.ok) return { opId: op.opId, status: 'rejected', reason: identity.reason };
        // 习惯不存在 → 这条记录在 UI 里永远不会显示（孤儿）。宁可拒掉，让它出现在
        // "被拒操作"里被人看见，也不要静默存一条谁也读不到的行
        const owner = await tx.query<Row>('SELECT id FROM habit WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
          identity.habitId,
          userId,
        ]);
        if (owner.length === 0) return { opId: op.opId, status: 'rejected', reason: 'habit_missing' };
        createFields = {
          ...op.fields,
          habitId: identity.habitId,
          logDate: identity.logDate,
          value: clampLogValue(op.fields.value),
        };
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
        ...fieldsToColumns(table, createFields),
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
      if (key === 'id' || !isKnownField(table, key)) continue;
      // syncState 是回写队列的状态位，客户端把它设成 'synced' 就等于"骗"服务端跳过回写
      if (table === 'cal_event' && key === 'syncState') continue;
      // 打卡记录的身份字段不可改：改了要么撞唯一索引，要么让这条记录"跑到另一个习惯名下"，
      // 而后者不会报错，只会在另一个习惯的统计里凭空多出一天
      if (table === 'habit_log' && (key === 'habitId' || key === 'logDate')) continue;
      sanitized[key] = value;
    }

    if (table === 'habit') {
      const clean = sanitizeHabitFields(sanitized);
      if (!clean.ok) return { opId: op.opId, status: 'rejected', reason: clean.reason };
      for (const key of Object.keys(sanitized)) delete sanitized[key];
      Object.assign(sanitized, clean.fields);
    }
    if (table === 'habit_log' && sanitized.value !== undefined) {
      sanitized.value = clampLogValue(sanitized.value);
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

    if (table === 'cal_event' && after[0]) {
      await enqueueCalendarPush(tx, userId, op.id, after[0], now);
    }

    return {
      opId: op.opId,
      status: merge.conflicts.length > 0 ? 'conflict' : 'applied',
      rev,
      seq,
      conflicts: merge.conflicts,
      serverPayload: after[0] ? rowToPayload(table, after[0]) : null,
    };
  }

  /** 本地改了 cal_event → 标记 pending_push 并排一条 Graph 回写 */
  async function enqueueCalendarPush(
    tx: SqlExecutor,
    userId: string,
    id: string,
    row: Row,
    now: number,
  ): Promise<void> {
    await tx.query("UPDATE cal_event SET sync_state = 'pending_push', push_attempts = 0 WHERE id = ?", [id]);
    // 整组时间一起送：只送 startAt 的话 Graph 会把 end 留在原地，
    // 拖拽一次就变成"14:00 到原来的 10:00"，服务端还会拒绝（end <= start）
    await enqueueGraphOp(
      tx,
      userId,
      'update',
      id,
      {
        subject: row.subject,
        startAt: Number(row.start_at),
        endAt: Number(row.end_at),
        allDay: Number(row.is_all_day) === 1,
      },
      strOrNull(row.ms_etag),
      now,
    );
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
