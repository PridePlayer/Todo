import { splitTodayTasks, type Task } from '@grid/core';

/**
 * 「今日」的口径。
 *
 * 筛选本身在 `@grid/core` 的 `splitTodayTasks` 里 —— 服务端算小组件摘要时
 * 调用的是**同一个函数**。如果这里再写一份，就会出现"首屏说 5 条、
 * 小组件说 3 条"，而这种不一致用户一眼就能看见，且无法解释。
 *
 * 这个文件只负责"日期怎么算"（本地日历日、本地毫秒边界），
 * 因为那部分必须跟着设备时区走。
 */

export interface TodaySections {
  overdue: Task[];
  dueToday: Task[];
  inbox: Task[];
  /** 首屏右上角 / 小组件右上角那个数字 */
  openCount: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地日历日 `YYYY-MM-DD`（不是 UTC 日：用户在 UTC+8 的晚上 11 点，UTC 已经是明天） */
export function localTodayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * 今天的毫秒边界。
 *
 * 服务端需要它来判定「startAt 是否落在今天」—— 而服务端不知道客户端时区
 * （部署在 UTC 机器上时差 8 小时，症状是"早上 8 点前的任务在小组件里不见了"）。
 * 所以边界一律由客户端算好传上去，服务端只做数值比较。
 */
export function localDayRange(now: Date = new Date()): { today: string; dayStart: number; dayEnd: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { today: localTodayKey(now), dayStart: start, dayEnd: start + 86_400_000 };
}

/** 指定某个日历日的毫秒边界（`splitToday` 传了别的日期时用） */
export function dayRangeOf(dateKey: string): { today: string; dayStart: number; dayEnd: number } {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return localDayRange();
  const start = new Date(year, month - 1, day).getTime();
  return { today: dateKey, dayStart: start, dayEnd: start + 86_400_000 };
}

/** 某个时间戳落在哪个本地日历日 */
export function localKeyOf(ts: number): string {
  return localTodayKey(new Date(ts));
}

export function splitToday(tasks: readonly Task[], todayKey: string): TodaySections {
  const { dayStart, dayEnd } = dayRangeOf(todayKey);
  return splitTodayTasks(tasks, todayKey, dayStart, dayEnd);
}
