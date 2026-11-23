import { eachDayKey, isScheduled } from './date.js';

/**
 * 完成率。
 *
 * 分母是"这段窗口里**该做**的天数"，不是"窗口总天数"：
 * 一个只排周一的习惯，30 天里该做 4~5 次，按 30 天算永远是 15%，
 * 那种数字既不能反映表现，也会让人干脆不看。
 *
 * 起点还要与习惯创建日取较晚者：刚建的习惯不该背负"上个月没做"的欠账。
 */

export interface RateInfo {
  done: number;
  expected: number;
  /** 0..1；expected=0 时为 0（不是 NaN，NaN 会让格式化输出 "NaN%"） */
  rate: number;
}

export interface RateInput {
  /** 达标的日期集合 */
  doneDays: Set<string>;
  daysOfWeek: readonly number[];
  /** 窗口起点（含）；会被 createdKey 抬高 */
  from: string;
  /** 窗口终点（含） */
  to: string;
  /** 习惯创建日 */
  createdKey: string;
}

export function completionRate(input: RateInput): RateInfo {
  const { doneDays, daysOfWeek, to, createdKey } = input;
  const from = input.from > createdKey ? input.from : createdKey;
  if (from > to) return { done: 0, expected: 0, rate: 0 };

  let expected = 0;
  let done = 0;
  for (const day of eachDayKey(from, to)) {
    if (!isScheduled(day, daysOfWeek)) continue;
    expected += 1;
    if (doneDays.has(day)) done += 1;
  }
  return { done, expected, rate: expected === 0 ? 0 : done / expected };
}

/** 三个口径一次算完：7 天 / 30 天 / 全部（自创建起） */
export function rateBuckets(input: Omit<RateInput, 'from'>): {
  week: RateInfo;
  month: RateInfo;
  all: RateInfo;
} {
  const { to, createdKey } = input;
  const back = (days: number): string => {
    const n = Number(new Date(`${to}T00:00:00Z`)) / 86_400_000 - (days - 1);
    return new Date(n * 86_400_000).toISOString().slice(0, 10);
  };
  return {
    week: completionRate({ ...input, from: back(7) }),
    month: completionRate({ ...input, from: back(30) }),
    all: completionRate({ ...input, from: createdKey }),
  };
}

export function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
