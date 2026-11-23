import { z } from 'zod';

/**
 * 待办的单一事实源。
 *
 * 字段与 docs/03-数据模型与同步策略.md §4.3 `task` 表一一对应，只有命名风格不同
 * （库里 snake_case，这里 camelCase；M2 同步层负责映射，别的地方不许再写一套）。
 *
 * 三条刻意的取舍：
 * 1. `quadrant` 既存又不存：`important` / `urgent` 是唯一真源，`quadrant` 是派生值。
 *    之所以还落库，是因为四象限是最高频查询，IndexedDB 需要它能被索引
 *    （服务端同理，那边用的是 GENERATED STORED 列）。写入统一走 repo，保证两者不漂。
 * 2. 时间用 epoch 毫秒而不是 Date 对象：IndexedDB 的结构化克隆对 Date 支持不统一，
 *    而且 M2 要和服务端的 DATETIME(3) 对齐，数字最不容易出错。
 * 3. `path` 是物化路径（'根/父/...' 以 / 结尾），让「取某任务全部子孙」变成前缀查询，
 *    不依赖递归——这条在 M0 降级到 MySQL 5.7 时救过一次场。
 */

export const MAX_DEPTH = 3;

export const QUADRANTS = [1, 2, 3, 4] as const;
export type Quadrant = (typeof QUADRANTS)[number];

const idLike = z.string().min(1).max(26);
const epochMs = z.number().int().nonnegative();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须是 YYYY-MM-DD');

export const taskSchema = z.object({
  id: idLike,
  listId: idLike,
  parentId: idLike.nullable(),
  /** 物化路径，根任务为 'id/'，子任务为 '父路径 + id/' */
  path: z.string().max(160),
  depth: z.number().int().min(0).max(MAX_DEPTH - 1),

  title: z.string().min(1, '标题不能为空').max(512),
  note: z.string().max(10_000).nullable(),

  /** 派生自 important/urgent，落库仅为可索引 */
  quadrant: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  important: z.boolean(),
  urgent: z.boolean(),
  priority: z.number().int().min(0).max(3),

  /** 全天任务只用 dueDate；有具体时间用 startAt / endAt */
  dueDate: dateOnly.nullable(),
  startAt: epochMs.nullable(),
  endAt: epochMs.nullable(),
  allDay: z.boolean(),

  location: z.string().max(256).nullable(),
  tagIds: z.array(idLike).max(20),

  completedAt: epochMs.nullable(),
  archivedAt: epochMs.nullable(),
  sortOrder: z.number(),

  /** 重复规则（iCal RRULE）。M1 只存不用，M3 才解析 */
  rrule: z.string().max(512).nullable(),
  remindAt: epochMs.nullable(),

  createdAt: epochMs,
  updatedAt: epochMs,
  deletedAt: epochMs.nullable(),
  rev: z.number().int().min(1),
});

export type Task = z.infer<typeof taskSchema>;

/** 新建时的入参：只有 title 必填，其余给默认值 */
export const newTaskSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(512),
  note: z.string().max(10_000).optional(),
  quadrant: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1),
  priority: z.number().int().min(0).max(3).default(0),
  parentId: idLike.nullable().default(null),
  listId: idLike.optional(),
  dueDate: dateOnly.nullable().default(null),
  startAt: epochMs.nullable().default(null),
  endAt: epochMs.nullable().default(null),
  location: z.string().max(256).nullable().default(null),
  tagIds: z.array(idLike).max(20).default([]),
  /** 重复规则；创建时就可以带，不必先建再改 */
  rrule: z.string().max(512).nullable().default(null),
});

export type NewTask = z.input<typeof newTaskSchema>;

export const tagSchema = z.object({
  id: idLike,
  name: z.string().trim().min(1).max(24),
  /** 设计 token 的索引，不是自由色值（瑞士风格不允许用户选色） */
  colorKey: z.number().int().min(0).max(5),
});

export type Tag = z.infer<typeof tagSchema>;

export const listSchema = z.object({
  id: idLike,
  name: z.string().trim().min(1).max(48),
  sortOrder: z.number(),
});

export type TaskList = z.infer<typeof listSchema>;

/** 判断一个任务是否已逾期：有结束时间看结束，只有日期则看当天 23:59:59 */
export function isOverdue(task: Task, now: number = Date.now()): boolean {
  if (task.completedAt !== null) return false;
  if (task.endAt !== null) return task.endAt < now;
  if (task.dueDate !== null) {
    const endOfDay = new Date(`${task.dueDate}T23:59:59.999`).getTime();
    return endOfDay < now;
  }
  return false;
}
