import { WIDGET_HABIT_SLOTS, WIDGET_TASK_SLOTS, type WidgetSummary } from '../models/widget.js';
import { addDaysKey, isScheduled } from '../habit/date.js';
import { computeStreak } from '../habit/streak.js';
import { reached } from '../models/habit-log.js';

/**
 * 从原始行算出小组件摘要。
 *
 * 为什么这个函数在 core 而不是服务端：
 *   同一份 summary 有两个产出点 —— 服务端（widget 醒来自已拉）和 App（用户刚改完，
 *   主动把桌面刷成最新的，不等 30 分钟）。两边各算一遍，数字迟早会不一样，
 *   而"App 说 5 条、桌面说 3 条"是用户一眼就能看见的那种错。
 *
 * 为什么用「轻量结构」而不是 `Task` / `Habit`：
 *   服务端手里是 snake_case 行 + payload 字典，要凑出一个完整的 `Task` 得先过一遍 zod；
 *   2000 条任务全量 parse 的代价没有必要 —— 这里只用到 9 个字段。
 *   App 端的 `Task` 结构天然满足这几个字段，所以同一个函数两边都能喂。
 */

export interface WidgetTaskLike {
  id: string;
  title: string;
  quadrant: number;
  dueDate: string | null;
  startAt: number | null;
  allDay: boolean;
  completedAt: number | null;
  rrule: string | null;
  sortOrder: number;
  rev: number;
}

export interface WidgetHabitLike {
  id: string;
  name: string;
  type: string;
  target: number;
  unit: string | null;
  colorKey: number;
  daysOfWeek: readonly number[];
  archivedAt: number | null;
  deletedAt: number | null;
}

export interface WidgetLogLike {
  habitId: string;
  logDate: string;
  value: number;
  deletedAt: number | null;
}

export interface TodayBuckets<T> {
  overdue: T[];
  dueToday: T[];
  inbox: T[];
  openCount: number;
}

/**
 * 今日待办分桶。口径与 App 首屏逐字一致：
 *   逾期 = dueDate < today（按象限）
 *   今日 = dueDate == today 或 startAt 落在 [dayStart, dayEnd)（按时间再象限）
 *   收件箱 = 无日期无时间（**不计入 openCount**）
 */
export function splitTodayTasks<T extends WidgetTaskLike>(
  tasks: readonly T[],
  today: string,
  dayStart: number,
  dayEnd: number,
): TodayBuckets<T> {
  const byQuadrant = (a: WidgetTaskLike, b: WidgetTaskLike): number =>
    a.quadrant - b.quadrant || a.sortOrder - b.sortOrder;

  const overdue: T[] = [];
  const dueToday: T[] = [];
  const inbox: T[] = [];

  for (const task of tasks) {
    if (task.completedAt !== null) continue;
    const hasTime = task.startAt !== null;
    const startIsToday = hasTime && task.startAt! >= dayStart && task.startAt! < dayEnd;

    if (task.dueDate !== null && task.dueDate < today) {
      overdue.push(task);
      continue;
    }
    if (task.dueDate === today || startIsToday) {
      dueToday.push(task);
      continue;
    }
    if (task.dueDate === null && !hasTime) inbox.push(task);
  }

  return {
    overdue: overdue.sort(byQuadrant),
    dueToday: dueToday.sort(
      (a, b) => (a.startAt ?? 0) - (b.startAt ?? 0) || a.quadrant - b.quadrant || a.sortOrder - b.sortOrder,
    ),
    inbox: inbox.sort(byQuadrant),
    openCount: overdue.length + dueToday.length,
  };
}

/** 连续天数最多回溯一年：够了，而且避免把五年老习惯的全部记录都读一遍 */
export const WIDGET_STREAK_LOOKBACK_DAYS = 365;

export interface BuildWidgetSummaryInput {
  tasks: readonly WidgetTaskLike[];
  habits: readonly WidgetHabitLike[];
  /** 至少覆盖最近 WIDGET_STREAK_LOOKBACK_DAYS 天，否则连续天数会被截断 */
  logs: readonly WidgetLogLike[];
  today: string;
  dayStart: number;
  dayEnd: number;
  now?: number;
}

function isHabitDueToday(habit: WidgetHabitLike, today: string): boolean {
  if (habit.archivedAt !== null || habit.deletedAt !== null) return false;
  // 直接复用 isScheduled：它内部按 UTC 日序号推星期几，
  // 手写一遍 `new Date(today).getDay()` 会在负时区差一天（同一天变成前一天）
  return isScheduled(today, habit.daysOfWeek);
}

export function buildWidgetSummary(input: BuildWidgetSummaryInput): WidgetSummary {
  const { tasks, habits, logs, today, dayStart, dayEnd } = input;
  const now = input.now ?? Date.now();

  const buckets = splitTodayTasks(tasks, today, dayStart, dayEnd);
  const picked = [...buckets.overdue.map((t) => ({ task: t, overdue: true })), ...buckets.dueToday.map((t) => ({ task: t, overdue: false }))]
    // 多取一条：勾掉一条后要立刻补位，所以返回 4 条、只画 3 条
    .slice(0, WIDGET_TASK_SLOTS);

  const dueHabits = habits.filter((habit) => isHabitDueToday(habit, today));

  // 达标日期按习惯归拢：唯一判据是 reached()，与 Web 端 doneDaysOf 同一套
  const doneByHabit = new Map<string, Set<string>>();
  // 今天已记录的值：计数型要点到第 8 杯才达标，中间态必须能被画出来
  const todayValueByHabit = new Map<string, number>();
  for (const log of logs) {
    if (log.deletedAt !== null) continue;
    if (log.logDate === today) todayValueByHabit.set(log.habitId, log.value);

    const habit = dueHabits.find((item) => item.id === log.habitId);
    if (!habit) continue;
    if (!reached({ type: habit.type, target: habit.target }, log.value)) continue;
    const set = doneByHabit.get(log.habitId) ?? new Set<string>();
    set.add(log.logDate);
    doneByHabit.set(log.habitId, set);
  }

  let maxStreak = 0;
  const surfaced = dueHabits.slice(0, WIDGET_HABIT_SLOTS).map((habit) => {
    const streak = computeStreak(doneByHabit.get(habit.id) ?? [], today);
    if (streak.current > maxStreak) maxStreak = streak.current;
    return {
      id: habit.id,
      name: habit.name,
      type: (habit.type === 'count' || habit.type === 'duration' ? habit.type : 'check') as
        | 'check'
        | 'count'
        | 'duration',
      target: Math.max(1, habit.target),
      unit: habit.unit,
      colorKey: habit.colorKey,
      value: todayValueByHabit.get(habit.id) ?? 0,
      doneToday: streak.doneToday,
      streak: streak.current,
    };
  });

  // 只画 4 个点的习惯，但最大连续天数要覆盖**所有**今日该做的习惯：
  // 否则第 5 个习惯连续 30 天，桌面上却显示 0
  for (const habit of dueHabits.slice(WIDGET_HABIT_SLOTS)) {
    const streak = computeStreak(doneByHabit.get(habit.id) ?? [], today);
    if (streak.current > maxStreak) maxStreak = streak.current;
  }

  return {
    today,
    openCount: buckets.openCount,
    tasks: picked.map(({ task, overdue }) => ({
      id: task.id,
      title: task.title,
      quadrant: task.quadrant >= 1 && task.quadrant <= 4 ? task.quadrant : 1,
      dueDate: task.dueDate,
      startAt: task.startAt,
      allDay: task.allDay,
      overdue,
      rrule: task.rrule,
      rev: task.rev,
    })),
    habits: surfaced,
    habitTotal: dueHabits.length,
    maxStreak,
    generatedAt: now,
  };
}

/** 回溯窗口的起点（含今天）：服务端查 habit_log 时用 */
export function widgetLogWindowStart(today: string): string {
  return addDaysKey(today, -(WIDGET_STREAK_LOOKBACK_DAYS - 1));
}
