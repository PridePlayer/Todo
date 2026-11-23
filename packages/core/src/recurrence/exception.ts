import { durationOf, rawStarts, type Occurrence, type SeriesLike } from './expand.js';
import { formatRrule, parseRrule } from './rrule.js';

/**
 * 重复系列的三选项编辑（docs/06 B-7 与 docs/03 §5.4）。
 *
 * 三个选项不是三种 UI 状态，而是三种**数据结构**：
 *   仅本次      → 写一条 recur_exception(kind='override')，母体一个字不动
 *   本次及后续  → 把母体截断到 cutoff 之前，再造一条新系列从 cutoff 起
 *   全部        → 直接改母体
 *
 * "本次及后续"最容易被写错的地方是**截断点**：截断必须落在"上一个真实发生过的实例"上，
 * 而不是 cutoff 减一天。因为规则可能是"每周一三五"，cutoff 在周二，
 * 用"减一天"会让周一那次也被砍掉。
 */

export interface OccurrencePatch {
  title?: string;
  note?: string | null;
  startAt?: number;
  endAt?: number;
  allDay?: boolean;
  location?: string | null;
  rrule?: string | null;
}

export interface ExceptionDraft {
  seriesId: string;
  originalStart: number;
  kind: 'override' | 'deleted';
  overrideStart: number | null;
  overrideEnd: number | null;
  overrideTitle: string | null;
  /** 其余被改字段的稀疏覆盖（note / location 等） */
  payload: Record<string, unknown> | null;
}

export interface SplitPlan {
  /** 原系列的新规则（已截断）；没有"之前的实例"时为空，表示整条系列都被换掉 */
  masterRrule: string | null;
  /** 需要把原系列整条删除（本次及后续 = 整个系列） */
  retireMaster: boolean;
  next: {
    startAt: number;
    endAt: number | null;
    title: string;
    rrule: string;
    patch: OccurrencePatch;
  };
  /** 原系列里 originalStart >= cutoff 的例外，必须改挂到新系列，否则变成孤儿 */
  remap: { id: string; originalStart: number }[];
}

/**
 * 仅本次：把这一实例的差异写成例外。
 * 只记录"和母体不一样"的字段，等于母体时返回 null（不需要制造例外）。
 */
export function planThisOnly(series: SeriesLike, occurrence: Occurrence, patch: OccurrencePatch): ExceptionDraft | null {
  const duration = durationOf(series);
  const start = patch.startAt ?? occurrence.start;
  const end = patch.endAt ?? (patch.startAt !== undefined ? patch.startAt + duration : occurrence.end);

  const movedStart = start !== occurrence.start;
  const movedEnd = end !== occurrence.end;
  const renamed = patch.title !== undefined && patch.title !== series.title;

  const payload: Record<string, unknown> = {};
  if (patch.note !== undefined) payload.note = patch.note;
  if (patch.location !== undefined) payload.location = patch.location;

  if (!movedStart && !movedEnd && !renamed && Object.keys(payload).length === 0) return null;

  return {
    seriesId: series.id,
    originalStart: occurrence.originalStart,
    kind: 'override',
    overrideStart: movedStart ? start : null,
    overrideEnd: movedEnd ? end : null,
    overrideTitle: renamed ? (patch.title ?? null) : null,
    payload: Object.keys(payload).length > 0 ? payload : null,
  };
}

/** 仅本次的删除：写 kind='deleted' 的例外（等价于 iCal 的 EXDATE） */
export function planSkip(seriesId: string, originalStart: number): ExceptionDraft {
  return {
    seriesId,
    originalStart,
    kind: 'deleted',
    overrideStart: null,
    overrideEnd: null,
    overrideTitle: null,
    payload: null,
  };
}

/** 全部：直接改母体，规则可以一起改 */
export function planAll(series: SeriesLike, patch: OccurrencePatch): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (patch.title !== undefined) fields.title = patch.title;
  if (patch.note !== undefined) fields.note = patch.note;
  if (patch.location !== undefined) fields.location = patch.location;
  if (patch.startAt !== undefined) fields.startAt = patch.startAt;
  if (patch.endAt !== undefined) fields.endAt = patch.endAt;
  if (patch.allDay !== undefined) fields.allDay = patch.allDay;
  if (patch.rrule !== undefined) fields.rrule = patch.rrule;
  return fields;
}

/**
 * 本次及后续：截断 + 新建。
 *
 * 返回的 next.startAt 用的是 occurrence.start（可能已经被前一次"仅本次"挪过），
 * 而不是母体的 startAt——用户在周三 14:00 看到这一条，选"本次及后续"，新系列就该从 14:00 起。
 */
export function planThisAndFollowing(
  series: SeriesLike,
  occurrence: Occurrence,
  patch: OccurrencePatch,
): SplitPlan {
  if (!series.rrule) throw new Error('这条任务不是重复任务');

  const rule = parseRrule(series.rrule);
  const previous = lastStartBefore(series, rule, occurrence.originalStart);

  const nextStart = patch.startAt ?? occurrence.start;
  const duration = durationOf(series);
  const nextEnd = patch.endAt ?? (patch.startAt !== undefined ? patch.startAt + duration : occurrence.end);

  const nextRrule = patch.rrule ?? formatRrule(rule);

  return {
    // 截断点必须是"上一个真实发生过的开始时间"，不能用 cutoff 减一天
    masterRrule: previous === null ? null : formatRrule({ ...rule, until: previous }),
    retireMaster: previous === null,
    next: {
      startAt: nextStart,
      endAt: nextEnd,
      title: patch.title ?? series.title,
      rrule: nextRrule,
      patch,
    },
    remap: [],
  };
}

/** cutoff 之前最近的一次原始开始时间；没有则 null（说明 cutoff 就是第一次） */
export function lastStartBefore(series: SeriesLike, rule: ReturnType<typeof parseRrule>, cutoff: number): number | null {
  const starts = rawStarts(rule, series.startAt, cutoff);
  let last: number | null = null;
  for (const ts of starts) {
    if (ts >= cutoff) break;
    last = ts;
  }
  return last;
}

/** 把例外按 originalStart 分成"留在原系列"和"该改挂到新系列"两组 */
export function partitionExceptions(
  exceptions: readonly { id: string; originalStart: number }[],
  cutoff: number,
): { keep: string[]; remap: { id: string; originalStart: number }[] } {
  const keep: string[] = [];
  const remap: { id: string; originalStart: number }[] = [];
  for (const exception of exceptions) {
    if (exception.originalStart >= cutoff) remap.push(exception);
    else keep.push(exception.id);
  }
  return { keep, remap };
}
