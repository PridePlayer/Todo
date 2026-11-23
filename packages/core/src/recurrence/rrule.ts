/**
 * RRULE 解析与序列化（iCal 子集）。
 *
 * 只支持能 1:1 映射到 Microsoft Graph 的那一小撮语法（docs/03 §5.1）：
 *   FREQ / INTERVAL / BYDAY / BYMONTHDAY / BYSETPOS / COUNT / UNTIL
 *
 * 为什么把边界掐这么死：RRULE 是个无底洞（BYWEEKNO、BYYEARDAY、多重 BYSETPOS 组合…），
 * 每多支持一种，就多一种"本地能存但同步到 Graph 会丢字段"的状态。
 * 从入口就拒绝（抛错而不是静默忽略），比事后在同步层对齐便宜得多。
 *
 * UNTIL / COUNT 直接编码在字符串里，而不是像文档那样单独占两个列：
 * 重复规则是**原子整体**（docs/03 §6 的合并策略也这么要求），拆成三列之后
 * "改结束条件的同事改了频率"会拼出一条谁也没写过的规则。
 */

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

const WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export interface Rule {
  freq: Freq;
  interval: number;
  /** WEEKLY：哪几天；MONTHLY + bySetPos：第几个星期几 */
  byDay: Weekday[] | null;
  /** MONTHLY / YEARLY：每月几号 */
  byMonthDay: number[] | null;
  /** 仅与 byDay 搭配，取值 -1 / 1 / 2 … 表示"最后一个 / 第一个 / 第二个" */
  bySetPos: number | null;
  count: number | null;
  /** epoch 毫秒；含当天 */
  until: number | null;
}

export class RruleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RruleError';
  }
}

const SUPPORTED_KEYS = new Set([
  'FREQ',
  'INTERVAL',
  'BYDAY',
  'BYMONTHDAY',
  'BYSETPOS',
  'COUNT',
  'UNTIL',
  'WKST',
]);

export function parseRrule(text: string): Rule {
  const raw = text.trim().toUpperCase().replace(/^RRULE:/, '');
  if (raw === '') throw new RruleError('重复规则不能为空');

  const rule: Rule = {
    freq: 'DAILY',
    interval: 1,
    byDay: null,
    byMonthDay: null,
    bySetPos: null,
    count: null,
    until: null,
  };
  let hasFreq = false;

  for (const part of raw.split(';')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq < 0) throw new RruleError(`无法解析的片段：${part}`);
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);

    if (!SUPPORTED_KEYS.has(key)) throw new RruleError(`不支持的 RRULE 属性：${key}`);

    switch (key) {
      case 'FREQ': {
        if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(value)) {
          throw new RruleError(`不支持的频率：${value}`);
        }
        rule.freq = value as Freq;
        hasFreq = true;
        break;
      }
      case 'INTERVAL': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 365) throw new RruleError(`非法的 INTERVAL：${value}`);
        rule.interval = n;
        break;
      }
      case 'BYDAY': {
        // WEEKLY 用纯星期几；MONTHLY 的 "最后一个周五" 走 BYDAY=FR + BYSETPOS=-1，
        // 所以这里不接受 "3FR" 这种带序号的写法
        const days = value.split(',').map((item) => item.trim());
        for (const day of days) {
          if (!WEEKDAYS.includes(day as Weekday)) throw new RruleError(`非法的 BYDAY：${day}`);
        }
        rule.byDay = days as Weekday[];
        break;
      }
      case 'BYMONTHDAY': {
        const days = value.split(',').map((item) => Number(item));
        for (const day of days) {
          if (!Number.isInteger(day) || day < 1 || day > 31) throw new RruleError(`非法的 BYMONTHDAY：${day}`);
        }
        rule.byMonthDay = days;
        break;
      }
      case 'BYSETPOS': {
        const n = Number(value);
        if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 5) throw new RruleError(`非法的 BYSETPOS：${value}`);
        rule.bySetPos = n;
        break;
      }
      case 'COUNT': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 999) throw new RruleError(`非法的 COUNT：${value}`);
        rule.count = n;
        break;
      }
      case 'UNTIL': {
        // 接受 20260331T235959Z 或 20260331
        const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value);
        if (!match) throw new RruleError(`非法的 UNTIL：${value}`);
        const [, y, mo, d, h = '23', mi = '59', s = '59'] = match;
        const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
        if (Number.isNaN(ts)) throw new RruleError(`非法的 UNTIL：${value}`);
        rule.until = ts;
        break;
      }
      case 'WKST': {
        // 只接受默认值：非 MO 的 WKST 会让"每两周"的边界日漂移，Graph 也不接受
        if (value !== 'MO') throw new RruleError('仅支持 WKST=MO');
        break;
      }
      default:
        break;
    }
  }

  if (!hasFreq) throw new RruleError('缺少 FREQ');

  if (rule.count !== null && rule.until !== null) {
    // iCal 允许，但 Graph 的 range 只能二选一；早报错好过同步时才发现
    throw new RruleError('COUNT 与 UNTIL 不能同时出现');
  }
  if (rule.bySetPos !== null && rule.byDay === null) {
    throw new RruleError('BYSETPOS 必须与 BYDAY 一起使用');
  }
  if (rule.freq === 'WEEKLY' && rule.byMonthDay !== null) {
    throw new RruleError('WEEKLY 规则不接受 BYMONTHDAY');
  }
  return rule;
}

export function formatRrule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay && rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.byMonthDay && rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.bySetPos !== null) parts.push(`BYSETPOS=${rule.bySetPos}`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== null) parts.push(`UNTIL=${toIcalDate(rule.until)}`);
  return parts.join(';');
}

export function toIcalDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** 取某天的星期（0=周一 … 6=周日）。iCal 的 WKST 默认是周一，这里跟着它 */
export function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function weekdayOf(date: Date): Weekday {
  return WEEKDAYS[weekdayIndex(date)]!;
}

export { WEEKDAYS };

/**
 * 面向 UI 的预设：只会产出上面那 8 种规则，用户不可能拼出语法错误。
 * 返回 null 表示"不重复"。
 */
export type RrulePreset = 'daily' | 'weekday' | 'weekly' | 'monthly' | 'monthly-last-workday' | 'yearly';

export function rruleFromPreset(preset: RrulePreset, anchor: number): string | null {
  const date = new Date(anchor);
  const day = weekdayOf(date);
  switch (preset) {
    case 'daily':
      return formatRrule(base({ freq: 'DAILY' }));
    case 'weekday':
      return formatRrule(base({ freq: 'WEEKLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }));
    case 'weekly':
      return formatRrule(base({ freq: 'WEEKLY', byDay: [day] }));
    case 'monthly':
      return formatRrule(base({ freq: 'MONTHLY', byMonthDay: [date.getDate()] }));
    case 'monthly-last-workday':
      // "每月最后一个周五"是唯一在商务场景里真正常用的 BYSETPOS 形态
      return formatRrule(base({ freq: 'MONTHLY', byDay: ['FR'], bySetPos: -1 }));
    case 'yearly':
      return formatRrule(base({ freq: 'YEARLY' }));
    default:
      return null;
  }
}

export interface RruleInput {
  freq: Freq;
  /** WEEKLY：哪几天；不给就是"按锚点的星期" */
  byDay?: readonly Weekday[];
  /** MONTHLY / YEARLY：每月几号 */
  byMonthDay?: readonly number[];
  bySetPos?: number | null;
  interval?: number;
  count?: number | null;
  until?: number | null;
}

/**
 * 从 UI 选项拼规则。
 *
 * 不让 UI 自己拼字符串再过 parseRrule：拼接的自由度太高 —— BYDAY 的顺序、
 * INTERVAL=1 该不该写、UNTIL 的 UTC 格式都会出错，而 parseRrule 只能判断
 * "语法合不合法"，判断不出"是不是你想要的那条"。
 * 这里收敛成唯一出口，UI 只提供语义参数。
 */
export function buildRrule(input: RruleInput): string {
  return formatRrule({
    freq: input.freq,
    interval: input.interval && input.interval > 1 ? input.interval : 1,
    byDay: input.byDay && input.byDay.length > 0 ? [...input.byDay] : null,
    byMonthDay: input.byMonthDay && input.byMonthDay.length > 0 ? [...input.byMonthDay] : null,
    bySetPos: input.bySetPos ?? null,
    count: input.count ?? null,
    until: input.until ?? null,
  });
}

function base(partial: Partial<Rule>): Rule {
  return {
    freq: 'DAILY',
    interval: 1,
    byDay: null,
    byMonthDay: null,
    bySetPos: null,
    count: null,
    until: null,
    ...partial,
  };
}
