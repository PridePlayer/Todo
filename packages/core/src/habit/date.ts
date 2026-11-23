/**
 * 打卡用的日期工具。
 *
 * 纪律：习惯与记录里的"日期"一律是 `YYYY-MM-DD` 的**本地日历日**，不是 epoch 毫秒。
 * 理由：打卡问的是"今天做了没"。用毫秒表示的话，同一天在不同时区会变成两天，
 * 跨时区旅行一次就会把连续 30 天的记录打断。日期字符串 + UTC 日序号做算术，
 * 既不受时区影响，也不受夏令时（一天 23/25 小时）影响。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' → 自 1970-01-01 起的天数。按 UTC 解析，避免本地时区插手 */
export function dayNumber(dateKey: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return Number.NaN;
  const ts = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.round(ts / DAY_MS);
}

export function dateKeyOfDayNumber(day: number): string {
  const d = new Date(day * DAY_MS);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDaysKey(dateKey: string, delta: number): string {
  return dateKeyOfDayNumber(dayNumber(dateKey) + delta);
}

/** a 到 b 相差几天（b 更晚为正） */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = dayNumber(value);
  if (!Number.isFinite(day)) return false;
  // 必须回写比对：`Date.UTC(2026, 1, 30)` 不会报错，它会静默滚到 3 月 2 日。
  // 只查"能不能算出天数"的话，"2026-02-30"会被当成合法日期，
  // 于是这条记录写着 2-30、实际落在 3-02，热力图上永远对不上，
  // 而它看起来只是"某天多了一条记录"。
  return dateKeyOfDayNumber(day) === value;
}

/** 0 = 周一 … 6 = 周日，与 `habit.daysOfWeek` 一致 */
export function weekdayOfKey(dateKey: string): number {
  // 1970-01-01 是周四，故 +3 后取模得到"周一为 0"
  return ((dayNumber(dateKey) % 7) + 7 + 3) % 7;
}

/** [from, to] 闭区间内的每一天 */
export function eachDayKey(from: string, to: string): string[] {
  const start = dayNumber(from);
  const end = dayNumber(to);
  const out: string[] = [];
  for (let day = start; day <= end; day += 1) out.push(dateKeyOfDayNumber(day));
  return out;
}

/** 该日期是否落在习惯的排期里 */
export function isScheduled(dateKey: string, daysOfWeek: readonly number[]): boolean {
  if (daysOfWeek.length === 0) return true;
  return daysOfWeek.includes(weekdayOfKey(dateKey));
}

/** 本周周一 */
export function weekStartKey(dateKey: string): string {
  return addDaysKey(dateKey, -weekdayOfKey(dateKey));
}
