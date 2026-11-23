import { z } from 'zod';

/**
 * 同步协议的线上格式（wire format）。
 *
 * 刻意让 `fields` 里的键**就是客户端 Task 模型的 camelCase 字段名**：
 * 文档 03 §6.2 的例子写的是 snake_case，但那会在客户端多出一层命名翻译，
 * 而翻译层是 bug 的温床（少写一个字段就是"这个字段永远不同步"）。
 * 服务端在 task-map.ts 里做一次 snake_case 映射，仅此一处。
 */

/** Hybrid Logical Clock：墙钟 + 计数器 + 设备号，三者字典序定"谁更晚" */
export const hlcSchema = z.object({
  wall: z.number().int().nonnegative(),
  counter: z.number().int().nonnegative(),
  device: z.string().min(1).max(26),
});

export type Hlc = z.infer<typeof hlcSchema>;

export const SYNC_TABLES = ['task', 'tag', 'list'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export const SYNC_ACTIONS = ['create', 'update', 'delete'] as const;
export type SyncAction = (typeof SYNC_ACTIONS)[number];

export const syncOpSchema = z.object({
  opId: z.string().min(1).max(32),
  table: z.enum(SYNC_TABLES),
  action: z.enum(SYNC_ACTIONS),
  id: z.string().min(1).max(26),
  /** 客户端认为的服务端版本；0 表示"新建" */
  baseRev: z.number().int().min(0),
  /** 只带真正改动的字段（字段掩码），没带的字段服务端一个字都不动 */
  fields: z.record(z.unknown()).default({}),
  /**
   * 这些字段在本设备**改动之前**的值。
   * 服务端用它判断"远端到底有没有动过这个字段"——
   * 只有 `当前值 !== base` 才算真冲突，否则会把"两边改不同字段"误报成冲突。
   */
  base: z.record(z.unknown()).optional(),
  hlc: hlcSchema,
});

export type SyncOp = z.infer<typeof syncOpSchema>;

export const syncPushRequestSchema = z.object({
  deviceId: z.string().min(1).max(26),
  ops: z.array(syncOpSchema).max(200),
});

export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;

export const syncConflictSchema = z.object({
  field: z.string(),
  /** 本次推送的值（胜者或请求方值） */
  local: z.unknown(),
  /** 服务端原有值（败者） */
  remote: z.unknown(),
});

export type SyncConflict = z.infer<typeof syncConflictSchema>;

export const SYNC_OP_STATUS = ['applied', 'conflict', 'duplicate', 'rejected'] as const;
export type SyncOpStatus = (typeof SYNC_OP_STATUS)[number];

export const syncOpResultSchema = z.object({
  opId: z.string(),
  status: z.enum(SYNC_OP_STATUS),
  rev: z.number().int().optional(),
  seq: z.number().int().optional(),
  conflicts: z.array(syncConflictSchema).optional(),
  serverPayload: z.record(z.unknown()).nullable().optional(),
  reason: z.string().optional(),
});

export type SyncOpResult = z.infer<typeof syncOpResultSchema>;

export const syncPushResponseSchema = z.object({
  results: z.array(syncOpResultSchema),
  serverCursor: z.number().int(),
});

export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;

export const syncChangeSchema = z.object({
  table: z.enum(SYNC_TABLES),
  id: z.string(),
  rev: z.number().int(),
  seq: z.number().int(),
  deletedAt: z.number().int().nullable(),
  /** 删除行不带 payload（tombstone 只需 id + deletedAt） */
  payload: z.record(z.unknown()).nullable(),
});

export type SyncChange = z.infer<typeof syncChangeSchema>;

export const syncPullRequestSchema = z.object({
  cursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(200),
});

export const syncPullResponseSchema = z.object({
  changes: z.array(syncChangeSchema),
  nextCursor: z.number().int(),
  hasMore: z.boolean(),
  /** 游标早于最早可用 tombstone 时为 true，客户端必须全量重建 */
  resyncRequired: z.boolean(),
  serverCursor: z.number().int(),
});

export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;

/** 服务端时间与客户端 HLC 的最大允许偏差：超过 5 分钟就以服务器时间为准（防"时钟错乱的设备永远赢"） */
export const HLC_MAX_SKEW_MS = 5 * 60 * 1000;

/** HLC 比较：先墙钟，再计数，最后设备号（字典序） */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.wall !== b.wall) return a.wall - b.wall;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.device < b.device ? -1 : a.device > b.device ? 1 : 0;
}
