import { formatRrule, parseZonedDateTime, type Freq, type Rule, type Weekday } from '@grid/core';
import { CAL_TIME_ZONE } from './client.js';

/**
 * Graph 的 `recurrence` 对象 → iCal RRULE 字符串。
 *
 * Graph 的重复规则是结构化的，iCal 是字符串。两边能 1:1 对应的部分很窄：
 *   pattern.type: daily | weekly | absoluteMonthly | relativeMonthly | absoluteYearly | relativeYearly
 *   range.type:   endDate | noEnd | numbered
 * 超出这个范围（例如 relativeYearly + 多个 daysOfWeek）时不猜，返回 null，
 * 该事件按"非重复"镜像——宁可少显示几次，也不要显示在错误日期上。
 */

interface GraphPattern {
  type?: string;
  interval?: number;
  month?: number;
  dayOfMonth?: number;
  daysOfWeek?: string[];
  index?: string;
  firstDayOfWeek?: string;
}

interface GraphRange {
  type?: string;
  startDate?: string;
  endDate?: string;
  numberOfOccurrences?: number;
  recurrenceTimeZone?: string;
}

export interface GraphRecurrence {
  pattern?: GraphPattern;
  range?: GraphRange;
}

const DAY_LETTER: Record<string, Weekday> = {
  monday: 'MO',
  tuesday: 'TU',
  wednesday: 'WE',
  thursday: 'TH',
  friday: 'FR',
  saturday: 'SA',
  sunday: 'SU',
};

const INDEX_POS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  last: -1,
};

export interface ConvertedRecurrence {
  rrule: string;
  /** END 类型的截止日（含），用于排查 */
  untilDate: string | null;
}

export function rruleFromGraph(
  recurrence: GraphRecurrence | null | undefined,
  tzid: string = CAL_TIME_ZONE,
): ConvertedRecurrence | null {
  const pattern = recurrence?.pattern;
  const range = recurrence?.range;
  if (!pattern || typeof pattern.type !== 'string') return null;

  const interval = Number.isFinite(pattern.interval) && (pattern.interval ?? 0) > 0 ? Number(pattern.interval) : 1;
  const days = (pattern.daysOfWeek ?? [])
    .map((day) => DAY_LETTER[String(day).toLowerCase()])
    .filter((day): day is Weekday => Boolean(day));

  let freq: Freq;
  let byDay: Weekday[] | null = null;
  let byMonthDay: number[] | null = null;
  let bySetPos: number | null = null;

  switch (pattern.type) {
    case 'daily':
      freq = 'DAILY';
      break;
    case 'weekly':
      freq = 'WEEKLY';
      // 每周不指定星期几时，Graph 用 DTSTART 那一天；留空让本地展开按 DTSTART 走，语义一致
      byDay = days.length > 0 ? days : null;
      break;
    case 'absoluteMonthly':
      freq = 'MONTHLY';
      byMonthDay = [pattern.dayOfMonth ?? 1];
      break;
    case 'relativeMonthly': {
      // "每月第二个周二" 在我们的模型里是 BYDAY=TU; BYSETPOS=2
      if (days.length !== 1) return null;
      const pos = INDEX_POS[String(pattern.index ?? '').toLowerCase()];
      if (pos === undefined) return null;
      freq = 'MONTHLY';
      byDay = days;
      bySetPos = pos;
      break;
    }
    case 'absoluteYearly':
      freq = 'YEARLY';
      byMonthDay = [pattern.dayOfMonth ?? 1];
      break;
    case 'relativeYearly': {
      if (days.length !== 1) return null;
      const pos = INDEX_POS[String(pattern.index ?? '').toLowerCase()];
      if (pos === undefined) return null;
      // 每年 + 指定月份 + 第几个星期几：本地模型没有 BYMONTH，只能放弃
      return null;
    }
    default:
      return null;
  }

  let count: number | null = null;
  let until: number | null = null;
  let untilDate: string | null = null;

  const rangeType = range?.type ?? 'noEnd';
  if (rangeType === 'numbered') {
    const n = Number(range?.numberOfOccurrences ?? 0);
    if (Number.isInteger(n) && n > 0 && n <= 999) count = n;
  } else if (rangeType === 'endDate' && typeof range?.endDate === 'string') {
    untilDate = range.endDate;
    // Graph 的 endDate 是**含当天**的日期（该时区），所以取当天 23:59:59
    const ts = parseZonedDateTime(`${range.endDate}T23:59:59`, tzid);
    if (ts !== null) until = ts;
  }

  const rule: Rule = { freq, interval, byDay, byMonthDay, bySetPos, count, until };
  try {
    return { rrule: formatRrule(rule), untilDate };
  } catch {
    return null;
  }
}

/** 反向：RRULE → Graph recurrence。P0 不需要（重复事件只读），留着给 M7 的"在 GRID 建重复会议" */
export function recurrenceFromRrule(rrule: string, startAt: number, tzid: string): GraphRecurrence | null {
  const parsed = rrule.trim().toUpperCase();
  const get = (key: string): string | null => {
    const match = new RegExp(`(?:^|;)${key}=([^;]+)`).exec(parsed);
    return match?.[1] ?? null;
  };
  const freq = get('FREQ');
  if (!freq) return null;
  const interval = Number(get('INTERVAL') ?? 1) || 1;
  const pattern: GraphPattern = { type: 'daily', interval };
  const letters = get('BYDAY')?.split(',') ?? [];
  const dayNames = Object.entries(DAY_LETTER)
    .filter(([, letter]) => letters.includes(letter))
    .map(([name]) => name);

  if (freq === 'DAILY') pattern.type = 'daily';
  else if (freq === 'WEEKLY') {
    pattern.type = 'weekly';
    if (dayNames.length > 0) pattern.daysOfWeek = dayNames;
  } else if (freq === 'MONTHLY') {
    const setPos = Number(get('BYSETPOS') ?? 0);
    if (setPos !== 0 && dayNames.length === 1) {
      pattern.type = 'relativeMonthly';
      pattern.daysOfWeek = dayNames;
      pattern.index = setPos === -1 ? 'last' : ['first', 'second', 'third', 'fourth'][setPos - 1];
    } else {
      pattern.type = 'absoluteMonthly';
      pattern.dayOfMonth = Number(get('BYMONTHDAY')?.split(',')[0] ?? new Date(startAt).getDate());
    }
  } else {
    pattern.type = 'absoluteYearly';
    pattern.month = new Date(startAt).getMonth() + 1;
    pattern.dayOfMonth = new Date(startAt).getDate();
  }

  const range: GraphRange = { type: 'noEnd', startDate: '', recurrenceTimeZone: tzid };
  return { pattern, range };
}
