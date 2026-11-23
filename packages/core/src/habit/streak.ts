import { addDaysKey, dayNumber } from './date.js';

/**
 * 连续天数。
 *
 * 四条必须同时成立的约定（M5 出口条件就是这四条）：
 *   1. **今天还没打卡不算断**。否则每天凌晨所有人都会看到"连续天数归零"，
 *      用户会以为记录丢了。今天没打就从前一天往回数。
 *   2. 跨月/跨年靠"日序号"加减，不靠月份长度表——闰年 2 月 29 与 3 月 1 自然相邻。
 *   3. 只认达标的日子（调用方传进来的就是达标集合）。
 *   4. 删除记录后回退：本函数是纯函数，每次都从当前集合重算，
 *      没有任何缓存或累加字段——累加字段是"删了记录但天数不变"的唯一来源。
 */

export interface StreakInfo {
  /** 当前连续天数（今天未打则从现在往回数到昨天） */
  current: number;
  /** 历史最长连续天数 */
  longest: number;
  /** 最近一次达标日期 */
  lastDone: string | null;
  /** 今天是否已达标 */
  doneToday: boolean;
}

export function computeStreak(doneDays: Iterable<string>, todayKey: string): StreakInfo {
  const set = doneDays instanceof Set ? (doneDays as Set<string>) : new Set(doneDays);
  if (set.size === 0) return { current: 0, longest: 0, lastDone: null, doneToday: false };

  const doneToday = set.has(todayKey);
  let cursor = doneToday ? todayKey : addDaysKey(todayKey, -1);
  let current = 0;
  while (set.has(cursor)) {
    current += 1;
    cursor = addDaysKey(cursor, -1);
  }

  const sorted = [...set].sort((a, b) => dayNumber(a) - dayNumber(b));
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of sorted) {
    run = previous !== null && dayNumber(day) - dayNumber(previous) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = day;
  }

  return { current, longest: Math.max(longest, current), lastDone: sorted[sorted.length - 1] ?? null, doneToday };
}
