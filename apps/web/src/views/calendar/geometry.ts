import type { Occurrence } from '@grid/core';

/**
 * 日历视图的几何与窗口计算。
 *
 * 单独抽出来的理由：这些是"纯算术"，而 React 组件里最容易被塞进去的脏东西
 * 就是这些算术（今天加几天、第几周、时间轴像素换算）。抽出来之后
 * 组件只负责摆放，算错了也只看这一个文件。
 */

export type CalendarMode = 'day' | 'week' | 'month' | 'list';

/** 时间轴一小时的像素高度。改这个值要同步 --hour-h（EventBlock 用内联样式，不读 CSS 变量） */
export const HOUR_H = 56;
export const MIN_BLOCK_H = 22;
const DAY_MS = 24 * 60 * 60 * 1000;
const SNAP_DEFAULT = 30 * 60 * 1000;
const SNAP_FINE = 15 * 60 * 1000;

export function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function weekStart(ts: number): number {
  // 周一为一周之始：和 iCal 的默认 WKST 保持一致，
  // 否则"每周一三五"在周视图里会被劈成两半
  return addDays(dayStart(ts), -((new Date(ts).getDay() + 6) % 7));
}

export function monthStart(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function monthGridStart(ts: number): number {
  return weekStart(monthStart(ts));
}

/** 视图窗口 [from, to)。月视图固定 6 行 42 天，避免切换月份时行数跳动 */
export function windowOf(anchor: number, mode: CalendarMode): { from: number; to: number } {
  switch (mode) {
    case 'day':
      return { from: dayStart(anchor), to: addDays(dayStart(anchor), 1) };
    case 'week':
      return { from: weekStart(anchor), to: addDays(weekStart(anchor), 7) };
    case 'month':
      return { from: monthGridStart(anchor), to: addDays(monthGridStart(anchor), 42) };
    case 'list':
    default:
      return { from: dayStart(anchor), to: addDays(dayStart(anchor), 30) };
  }
}

export function shiftAnchor(anchor: number, mode: CalendarMode, direction: -1 | 1): number {
  switch (mode) {
    case 'day':
      return addDays(anchor, direction);
    case 'week':
      return addDays(anchor, 7 * direction);
    case 'month': {
      const d = new Date(anchor);
      // 用"当月 1 日再加减"避免 1 月 31 日 +1 月落到 3 月 3 日
      return new Date(d.getFullYear(), d.getMonth() + direction, 1).getTime();
    }
    case 'list':
    default:
      return addDays(anchor, 30 * direction);
  }
}

export function snap(ts: number, fine: boolean): number {
  const size = fine ? SNAP_FINE : SNAP_DEFAULT;
  return Math.round(ts / size) * size;
}

/** 时间轴上的位置（像素）。不按 24 小时裁切——跨天事件由调用方裁 */
export function offsetOf(ts: number, base: number): number {
  return ((ts - base) / (60 * 60 * 1000)) * HOUR_H;
}

export interface PlacedBlock {
  occurrence: Occurrence;
  top: number;
  height: number;
  /** 同一时段内第几列 */
  column: number;
  columns: number;
  /** 开始时间被上一天遮住（跨天事件的第二天） */
  clippedTop: boolean;
  clippedBottom: boolean;
}

/**
 * 同一天内的重叠布局：按开始时间排序后贪心分列。
 *
 * 不做"每列等宽"的完整区间图着色：日历里同屏重叠通常不超过 3 个，
 * 贪心分列已经不会互相盖住，而完整算法在长事件 + 短事件混排时反而让块变窄到看不清标题。
 */
export function layoutDay(occurrences: readonly Occurrence[], dayBase: number): PlacedBlock[] {
  const dayTo = addDays(dayBase, 1);
  const inDay = occurrences
    .filter((item) => item.start < dayTo && item.end > dayBase)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const blocks: PlacedBlock[] = [];
  let clusterStart = 0;
  let clusterEnd = 0;
  let cluster: PlacedBlock[] = [];

  const flush = (): void => {
    if (cluster.length === 0) return;
    const columns = Math.max(...cluster.map((block) => block.column)) + 1;
    for (const block of cluster) block.columns = columns;
    cluster = [];
  };

  for (const occurrence of inDay) {
    if (occurrence.start >= clusterEnd && cluster.length > 0) flush();
    if (cluster.length === 0) {
      clusterStart = occurrence.start;
      clusterEnd = occurrence.end;
    } else {
      clusterEnd = Math.max(clusterEnd, occurrence.end);
    }

    const used = new Set(cluster.filter((block) => block.occurrence.end > occurrence.start).map((block) => block.column));
    let column = 0;
    while (used.has(column)) column += 1;

    const clippedTop = occurrence.start < dayBase;
    const clippedBottom = occurrence.end > dayTo;
    const start = Math.max(occurrence.start, dayBase);
    const end = Math.min(occurrence.end, dayTo);

    const block: PlacedBlock = {
      occurrence,
      top: offsetOf(start, dayBase),
      height: Math.max(MIN_BLOCK_H, offsetOf(end, dayBase) - offsetOf(start, dayBase)),
      column,
      columns: 1,
      clippedTop,
      clippedBottom,
    };
    cluster.push(block);
    blocks.push(block);
  }
  flush();
  return blocks;
}

/** 全天 / 跨天事件在时间轴上方单独一行，不参与重叠计算 */
export function isAllDayLike(occurrence: Occurrence): boolean {
  return occurrence.allDay || occurrence.end - occurrence.start >= DAY_MS;
}

export function formatDayLabel(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(ts));
}

export function formatMonthLabel(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(new Date(ts));
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
