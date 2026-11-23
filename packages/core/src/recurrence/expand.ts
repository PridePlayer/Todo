import { WEEKDAYS, parseRrule, weekdayIndex, weekdayOf, type Rule } from './rrule.js';

/**
 * 把「母体 + 规则 + 例外」展开成某段时间窗口内的实例列表。
 *
 * 三条硬约束：
 * 1. **不存在的日期必须跳过而不是顺延**。RRULE 的语义是"每月 31 日"，
 *    2 月没有 31 日就那一次没有——顺延到 3 月 3 日会凭空多出一个用户没同意的会议。
 * 2. **只在窗口内展开**。展开是惰性的：日历翻到哪个月就只算哪个月，
 *    不会因为有"永不结束"的规则就把未来十年的实例都算一遍。
 * 3. **例外可以挪到窗口外**。所以匹配例外时窗口要前扩一段，
 *    否则"把上周一的那次改到今天"就找不到了。
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** 例外允许把实例挪多远：前后各留 31 天，够覆盖"提前/推迟一个月"这种操作 */
const SHIFT_WINDOW = 31 * DAY;
/** 单条系列在一次展开里最多算多少个原始开始时间，防"每天一次 + 永不结束"打满 CPU */
const RAW_CAP = 2000;

export type ExceptionKind = 'override' | 'deleted';

export interface RecurExceptionLike {
  id: string;
  seriesId: string;
  /** 该次在原系列里的原定开始，例外的定位键 */
  originalStart: number;
  kind: ExceptionKind;
  overrideStart: number | null;
  overrideEnd: number | null;
  overrideTitle: string | null;
  deletedAt: number | null;
}

/**
 * 实例的来源。
 *
 * 同一个日历网格里混着两类东西：本地待办（task）与 Outlook 镜像事件（cal_event）。
 * 两者的编辑语义完全不同——待办可以随便拖，Outlook 的重复事件只能跳过去改——
 * 所以来源必须跟着实例一路传下去，不能在上层靠 id 反查（反查会在渲染时才失败）。
 */
export type OccurrenceKind = 'task' | 'event';

export interface OccurrenceOrigin {
  /** calendar_source.id */
  sourceId: string;
  /** 在 Outlook 网页版打开这条事件 */
  webLink: string | null;
  /** 只读：重复事件（P0）或只读日历（节假日/生日）上的事件 */
  readOnly: boolean;
  /** 灰阶档位，用于事件块的左缘色条 */
  colorKey: number;
}

export interface SeriesLike {
  id: string;
  title: string;
  startAt: number;
  endAt: number | null;
  allDay: boolean;
  rrule: string | null;
  exceptions: readonly RecurExceptionLike[];
  /** 缺省为 task，保持 M3 之前的调用方不用改 */
  kind?: OccurrenceKind;
  origin?: OccurrenceOrigin | null;
}

export interface Occurrence {
  seriesId: string;
  /** 原定开始；对非重复任务就等于 start */
  originalStart: number;
  start: number;
  end: number;
  title: string;
  allDay: boolean;
  /** 有覆盖时为例外 id，用来判断"这次能不能单改" */
  exceptionId: string | null;
  kind: OccurrenceKind;
  origin: OccurrenceOrigin | null;
}

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** 构造某年某月某日的同一时刻；日期溢出（2 月 31 日）时返回 null */
function makeAt(year: number, month: number, day: number, time: Date): number | null {
  const d = new Date(year, month, day, time.getHours(), time.getMinutes(), time.getSeconds(), time.getMilliseconds());
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
  return d.getTime();
}

export function durationOf(series: Pick<SeriesLike, 'startAt' | 'endAt' | 'allDay'>): number {
  if (series.endAt !== null && series.endAt > series.startAt) return series.endAt - series.startAt;
  return series.allDay ? DAY : HOUR;
}

/**
 * 生成规则允许的全部原始开始时间（升序，未套例外）。
 * limitTs 是"不需要再往后的边界"，不是硬性截断——调用方会给它加上余量。
 */
export function rawStarts(rule: Rule, dtstart: number, limitTs: number): number[] {
  const out: number[] = [];
  const time = new Date(dtstart);
  const until = rule.until;

  const accept = (ts: number | null): 'ok' | 'past' | 'beyond' => {
    if (ts === null) return 'ok'; // 不存在的日期：跳过，继续下一个
    if (until !== null && ts > until) return 'beyond';
    if (ts > limitTs) return 'beyond';
    if (ts >= dtstart) out.push(ts);
    return out.length >= RAW_CAP ? 'beyond' : 'ok';
  };

  if (rule.freq === 'DAILY') {
    let cursor = dtstart;
    for (let i = 0; i < RAW_CAP; i += 1) {
      if (accept(cursor) === 'beyond') break;
      cursor = addDays(cursor, rule.interval);
    }
    return out;
  }

  if (rule.freq === 'WEEKLY') {
    const days = (rule.byDay ?? [weekdayOf(time)])
      .slice()
      .sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    // 本周周一，但**保留 DTSTART 的时刻**：addDays 会保留时分秒，
    // 若改用 dayStart 再补时刻，第一周就可能算出 00:00 的实例
    const weekStart = addDays(dtstart, -weekdayIndex(time));

    for (let week = 0; week < RAW_CAP; week += 1) {
      const base = addDays(weekStart, week * rule.interval * 7);
      if (base > limitTs) break;
      let stop = false;
      for (const day of days) {
        const ts = addDays(base, WEEKDAYS.indexOf(day));
        if (ts < dtstart) continue; // 第一周里早于 DTSTART 的日子不算
        const verdict = accept(ts);
        if (verdict === 'beyond') {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
    return out;
  }

  if (rule.freq === 'MONTHLY') {
    const startMonth = time.getMonth();
    const startYear = time.getFullYear();

    for (let step = 0; step < RAW_CAP; step += 1) {
      const cursor = new Date(startYear, startMonth + step * rule.interval, 1);
      const year = cursor.getFullYear();
      const month = cursor.getMonth();
      if (cursor.getTime() > limitTs + 31 * DAY) break;

      const candidates: number[] = [];
      if (rule.byDay && rule.bySetPos !== null) {
        // "每月最后一个周五"：先取本月所有周五，再按 BYSETPOS 从尾/头取
        const matches: number[] = [];
        for (let day = 1; day <= 31; day += 1) {
          const ts = makeAt(year, month, day, time);
          if (ts === null) continue;
          if (rule.byDay.includes(weekdayOf(new Date(ts)))) matches.push(ts);
        }
        const index = rule.bySetPos > 0 ? rule.bySetPos - 1 : matches.length + rule.bySetPos;
        if (matches[index] !== undefined) candidates.push(matches[index]!);
      } else {
        const days = rule.byMonthDay ?? [time.getDate()];
        for (const day of days) {
          const ts = makeAt(year, month, day, time);
          if (ts !== null) candidates.push(ts);
        }
      }

      let stop = false;
      for (const ts of candidates.sort((a, b) => a - b)) {
        const verdict = accept(ts);
        if (verdict === 'beyond') {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
    return out;
  }

  // YEARLY：每年同一个"月 + 日"。2 月 29 日的规则在平年自动跳过（makeAt 返回 null）
  const days = rule.byMonthDay ?? [time.getDate()];
  for (let step = 0; step < RAW_CAP; step += 1) {
    const year = time.getFullYear() + step * rule.interval;
    if (new Date(year, time.getMonth(), 1).getTime() > limitTs + 366 * DAY) break;
    let stop = false;
    for (const day of days) {
      const ts = makeAt(year, time.getMonth(), day, time);
      const verdict = accept(ts);
      if (verdict === 'beyond') {
        stop = true;
        break;
      }
    }
    if (stop) break;
  }
  return out;
}

/**
 * 展开一条系列到 [from, to) 窗口。
 * 非重复任务（rrule 为 null）走单独分支：只判断这一次是否落在窗口里。
 */
export function expandSeries(series: SeriesLike, from: number, to: number, limit = 500): Occurrence[] {
  const duration = durationOf(series);

  if (!series.rrule) {
    const start = series.startAt;
    const end = start + duration;
    if (end <= from || start >= to) return [];
    return [
      {
        seriesId: series.id,
        originalStart: start,
        start,
        end,
        title: series.title,
        allDay: series.allDay,
        exceptionId: null,
        kind: series.kind ?? 'task',
        origin: series.origin ?? null,
      },
    ];
  }

  const rule = parseRrule(series.rrule);
  const starts = rawStarts(rule, series.startAt, to + SHIFT_WINDOW);
  // COUNT 是"总共出现几次"，必须从 DTSTART 起数，不能因为窗口在中间就从窗口开始数
  const counted = rule.count !== null ? starts.slice(0, rule.count) : starts;

  const byOriginal = new Map<number, RecurExceptionLike>();
  for (const exception of series.exceptions) {
    if (exception.deletedAt !== null) continue;
    byOriginal.set(exception.originalStart, exception);
  }

  const occurrences: Occurrence[] = [];
  for (const original of counted) {
    if (original < from - SHIFT_WINDOW) continue;
    if (original >= to + SHIFT_WINDOW) break;

    const exception = byOriginal.get(original);
    if (exception?.kind === 'deleted') continue;

    const start = exception?.overrideStart ?? original;
    const end = exception?.overrideEnd ?? start + duration;
    if (end <= from || start >= to) continue;

    occurrences.push({
      seriesId: series.id,
      originalStart: original,
      start,
      end,
      title: exception?.overrideTitle ?? series.title,
      allDay: series.allDay,
      exceptionId: exception?.id ?? null,
      kind: series.kind ?? 'task',
      origin: series.origin ?? null,
    });
  }

  occurrences.sort((a, b) => a.start - b.start);
  return occurrences.slice(0, limit);
}

/** 日历视图用：把一批任务展开合并，按开始时间排序 */
export function expandTasks(
  series: readonly SeriesLike[],
  from: number,
  to: number,
  limit = 800,
): Occurrence[] {
  const all: Occurrence[] = [];
  for (const item of series) {
    // 母体整个在窗口之前结束、且没有重复 → 直接跳过，省掉 parseRrule
    if (!item.rrule) {
      const end = item.startAt + durationOf(item);
      if (end <= from || item.startAt >= to) continue;
    }
    for (const occurrence of expandSeries(item, from, to)) {
      all.push(occurrence);
      if (all.length >= limit) break;
    }
    if (all.length >= limit) break;
  }
  all.sort((a, b) => a.start - b.start);
  return all;
}
