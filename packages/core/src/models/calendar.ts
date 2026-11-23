import { z } from 'zod';

/**
 * Outlook 事件的本地镜像 与 日历源。
 *
 * 纪律：这两个模型**只描述客户端看到的形状**，不含 ms_etag / delta 游标这类
 * 纯服务端的同步细节——那些留在服务端，不参与 change_seq 增量，
 * 否则每 30 秒轮询一次就会把所有事件的 rev 都推高，客户端会一直重绘日历。
 */

export const CAL_SYNC_STATES = ['synced', 'pending_push', 'failed', 'readonly'] as const;
export type CalSyncState = (typeof CAL_SYNC_STATES)[number];

export const calEventSchema = z.object({
  id: z.string(),
  /** 所属日历源（calendar_source.id） */
  sourceId: z.string(),
  /** Graph 的事件 id。移动日历后会变，不能当身份用 */
  msEventId: z.string(),
  subject: z.string(),
  bodyPreview: z.string().nullable(),
  location: z.string().nullable(),
  startAt: z.number().int(),
  endAt: z.number().int(),
  allDay: z.boolean(),
  /** 事件原始时区（IANA）。仅用于排查"时间差 8 小时"这类问题 */
  tzid: z.string(),
  isOrganizer: z.boolean(),
  responseStatus: z.string().nullable(),
  /** 重复事件的母体为 true；P0 阶段这类事件只读 */
  isRecurring: z.boolean(),
  rrule: z.string().nullable(),
  /** 在 Outlook 网页版打开这条事件的地址（Graph 给的 webLink） */
  webLink: z.string().nullable(),
  syncState: z.enum(CAL_SYNC_STATES),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
  rev: z.number().int(),
});

export type CalEvent = z.infer<typeof calEventSchema>;

export const calendarSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 用户是否在日历里看到它（纯 UI 开关，不影响同步） */
  isVisible: z.boolean(),
  /** 是否拉取（节假日/生日日历默认关掉，否则日历会被塞满） */
  isSynced: z.boolean(),
  /** Graph 的 canEdit。只读日历（节假日、生日）上的事件不能拖动 */
  canEdit: z.boolean(),
  isDefault: z.boolean(),
  /** 灰阶档位 0..5，由服务端按日历顺序分配，不直接用 Graph 的十六进制色 */
  colorKey: z.number().int(),
  sortOrder: z.number().int(),
  updatedAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
  rev: z.number().int(),
});

export type CalendarSource = z.infer<typeof calendarSourceSchema>;

/** 设置页里"哪些日历要显示"的一条选项。比 calendarSourceSchema 轻：不带同步元数据 */
export const calendarSourceOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  isVisible: z.boolean(),
  isSynced: z.boolean(),
  canEdit: z.boolean(),
  isDefault: z.boolean(),
  colorKey: z.number().int(),
  sortOrder: z.number().int(),
});

export type CalendarSourceOption = z.infer<typeof calendarSourceOptionSchema>;

/** 设置页/日历页顶部胶囊用的一次性快照 */
export const calendarStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  email: z.string().nullable(),
  accountStatus: z.string().nullable(),
  lastSyncAt: z.number().nullable(),
  lastError: z.string().nullable(),
  /** 令牌失效时为 true：界面必须出红色通栏，而不是只在设置页角落写一行小字 */
  reauthRequired: z.boolean(),
  pendingWrites: z.number().int(),
  deadWrites: z.number().int(),
  events: z.number().int(),
  tokenExpiresAt: z.number().nullable(),
  sources: z.array(calendarSourceOptionSchema),
});

export type CalendarStatus = z.infer<typeof calendarStatusSchema>;

export const calendarSyncResultSchema = z.object({
  ok: z.boolean(),
  reauthRequired: z.boolean(),
  error: z.string().nullable(),
  added: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
  pushed: z.number().int(),
  deadWrites: z.number().int(),
});

export type CalendarSyncResult = z.infer<typeof calendarSyncResultSchema>;
