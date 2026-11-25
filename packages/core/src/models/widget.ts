import { z } from 'zod';

/**
 * 桌面小组件的数据契约（docs/11）。
 *
 * 为什么单独一份而不是复用 `Task` / `Habit`：
 *   小组件只需要渲染用的那几个字段，而 `Task` 有 20 多个。headless JS 里
 *   每次唤醒都要反序列化一遍，字段越多越慢（而且 widget 只画 3 行）。
 *   更重要的是：这份契约是**服务端算好结果**的，不是原始行 ——
 *   `overdue` 与 `doneToday` 都由服务端判定，widget 不做任何业务判断。
 *   业务判断放在两边各写一次，迟早会出现"widget 说已完成、App 说没完成"。
 */

/** widget 上最多显示 3 条待办，第 4 条用于"勾掉一条后立刻补位" */
export const WIDGET_TASK_SLOTS = 4;
/**
 * 4×4 里打卡也占三行，与待办对等（各 3 行）。
 *
 * 曾经只放一行四个无标签圆圈，结果没人看得懂那四个圆是什么 ——
 * 视觉上省下来的空间，全变成了理解成本。
 */
export const WIDGET_HABIT_SLOTS = 3;

export const widgetTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  quadrant: z.number().int().min(1).max(4),
  dueDate: z.string().nullable(),
  startAt: z.number().int().nullable(),
  allDay: z.boolean(),
  /** 服务端算好：dueDate 早于 today */
  overdue: z.boolean(),
  /**
   * 重复任务的规则。
   * 必须带：勾选完成时要用它判断"是写 completedAt 还是推进母体"，
   * 判错的症状是"勾掉今天这次，整个系列从此消失"。
   */
  rrule: z.string().nullable(),
  /** 构造 SyncOp 的 baseRev 需要它，缺了就没法做乐观写 */
  rev: z.number().int(),
});

export type WidgetTask = z.infer<typeof widgetTaskSchema>;

export const widgetHabitSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['check', 'count', 'duration']),
  target: z.number().int().positive(),
  unit: z.string().nullable(),
  colorKey: z.number().int(),
  /**
   * 今天已记录的值。必须带 —— 计数型/时长型光有 doneToday 是不够的：
   * 目标 8 杯水、已经喝了 3 杯，小组件要能显示"3"，否则用户点了两下
   * 看到什么都没变，会以为点击没生效。
   */
  value: z.number(),
  /** 今天是否已达标（服务端按 reached() 判定，widget 不重算） */
  doneToday: z.boolean(),
  /** 当前连续天数（今天没打卡不算断，由 computeStreak 保证） */
  streak: z.number().int(),
});

export type WidgetHabit = z.infer<typeof widgetHabitSchema>;

export const widgetSummarySchema = z.object({
  /** 客户端传上来的本地日期，原样回显，方便对照排错 */
  today: z.string(),
  /** 逾期 + 今日 的未完成条数（不含收件箱，与 App 首屏那个数字同一个口径） */
  openCount: z.number().int(),
  tasks: z.array(widgetTaskSchema).max(WIDGET_TASK_SLOTS),
  /** 今天该做的习惯，最多 4 个 */
  habits: z.array(widgetHabitSchema).max(WIDGET_HABIT_SLOTS),
  /** 今天该做的习惯总数，用于显示 "+3" */
  habitTotal: z.number().int(),
  /** 今日习惯里最大的连续天数，widget 上那个大数字 */
  maxStreak: z.number().int(),
  generatedAt: z.number().int(),
});

export type WidgetSummary = z.infer<typeof widgetSummarySchema>;

/**
 * 查询参数。
 *
 * `dayStart` / `dayEnd` 由客户端按**本地时区**算好传上来，服务端只做数值比较。
 * 服务端自己算"今天 0 点"会在部署于 UTC 的机器上差 8 小时，
 * 症状是"早上 8 点前的任务在小组件里不见了"——这种 bug 只在特定时间段出现。
 */
export const widgetSummaryQuerySchema = z.object({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'today 必须是 YYYY-MM-DD'),
  dayStart: z.coerce.number().int().nonnegative(),
  dayEnd: z.coerce.number().int().nonnegative(),
});

export type WidgetSummaryQuery = z.infer<typeof widgetSummaryQuerySchema>;

/** 请求小组件摘要的路径（服务端与客户端共用，避免两边各写一份字符串） */
export const WIDGET_SUMMARY_PATH = '/api/widget/summary';
