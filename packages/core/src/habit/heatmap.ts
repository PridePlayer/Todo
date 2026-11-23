import { addDaysKey, isScheduled, weekStartKey } from './date.js';

/**
 * 热力图（12 周 = 84 格）。
 *
 * 分档按"占目标的比例"而不是原值：8 杯水与 10 分钟冥想的原值没有可比性，
 * 但 0%/40%/80%/100%/超额 这五档是同一套语言。
 *
 * 补卡单独标出来（斜纹）——它不是"当天做了"，而是"事后补记"。
 * 不区分的话，连续 10 天的斜纹会被误读成"真的坚持了 10 天"。
 */

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatCell {
  date: string;
  level: HeatLevel;
  value: number;
  /** 补记 */
  backfilled: boolean;
  /** 这一天是否在习惯的排期里（不在排期的日子画淡底，不算漏） */
  scheduled: boolean;
  /** 未来日期：画虚线框，不可点 */
  future: boolean;
}

export interface HeatInput {
  today: string;
  weeks?: number;
  /** date → 记录 */
  logs: Map<string, { value: number; backfilled: boolean }>;
  target: number;
  daysOfWeek: readonly number[];
}

export function levelOf(value: number, target: number): HeatLevel {
  if (value <= 0) return 0;
  const ratio = target > 0 ? value / target : 1;
  if (ratio < 0.5) return 1;
  if (ratio < 1) return 2;
  if (ratio === 1) return 3;
  return 4;
}

/** 返回按周分组的格子：外层长度 = weeks，内层固定 7（周一 → 周日） */
export function heatmapWeeks(input: HeatInput): HeatCell[][] {
  const weeks = input.weeks ?? 12;
  const thisWeekStart = weekStartKey(input.today);
  const firstWeekStart = addDaysKey(thisWeekStart, -(weeks - 1) * 7);

  const out: HeatCell[][] = [];
  for (let w = 0; w < weeks; w += 1) {
    const row: HeatCell[] = [];
    for (let d = 0; d < 7; d += 1) {
      const date = addDaysKey(firstWeekStart, w * 7 + d);
      const log = input.logs.get(date);
      row.push({
        date,
        level: log ? levelOf(log.value, input.target) : 0,
        value: log?.value ?? 0,
        backfilled: log?.backfilled ?? false,
        scheduled: isScheduled(date, input.daysOfWeek),
        future: date > input.today,
      });
    }
    out.push(row);
  }
  return out;
}

/** 一组日期里达标的天数（用于"本周完成 x/y"这类文案） */
export function countReached(
  logs: Map<string, { value: number }>,
  target: number,
  dates: readonly string[],
): number {
  let count = 0;
  for (const date of dates) {
    const log = logs.get(date);
    if (log && log.value >= target) count += 1;
  }
  return count;
}
