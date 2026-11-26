import {
  QUADRANT_META,
  buildRrule,
  isDateKey,
  type NewTask,
  type Quadrant,
  type Weekday,
} from '@grid/core';

/**
 * CSV → 任务草稿的转换与校验（docs/12 §批量导入）。
 *
 * 纪律：**这个文件只做纯计算**，不碰 IndexedDB、不写队列。
 * 调用方先拿 `parseRows()` 的全量结果，有错就整批不导；没错再交给 `db/import.ts` 落库。
 * 只有这样才谈得上"原子导入"—— 校验和写入混在一起时，
 * 第 300 行报错的那一刻前 299 条已经写进去了，那就是"导了一半"。
 */

/** 11 列的字段键 */
export type ColumnKey =
  | 'title'
  | 'date'
  | 'time'
  | 'endTime'
  | 'quadrant'
  | 'priority'
  | 'tags'
  | 'location'
  | 'note'
  | 'remind'
  | 'repeat';

/**
 * 表头别名。
 *
 * 中文为主，同时认英文和几个常见简写 —— 用户从别的工具导过来的表头
 * 十有八九是 `title` / `due` / `tags`，逼他改表头等于让他在 Excel 里返工。
 */
const HEADER_ALIASES: Record<ColumnKey, string[]> = {
  title: ['标题', '任务', '内容', 'title', 'name', 'task'],
  date: ['日期', '截止日期', 'due', 'duedate', 'date'],
  time: ['时间', '开始时间', 'time', 'start', 'startat'],
  endTime: ['结束时间', 'end', 'endtime', 'endat'],
  quadrant: ['象限', '四象限', 'quadrant', 'q'],
  priority: ['优先级', 'priority', 'prio'],
  tags: ['标签', 'tag', 'tags'],
  location: ['地点', '位置', 'location', 'place'],
  note: ['备注', '说明', 'note', 'notes', 'remark'],
  remind: ['提醒提前', '提醒提前分钟', '提前提醒', '提醒', 'remind', 'remindleadminutes'],
  repeat: ['重复', '重复规则', 'repeat', 'rrule'],
};

/** 模板的列顺序，也是下载文件的表头 */
export const TEMPLATE_HEADERS = [
  '标题',
  '日期',
  '时间',
  '结束时间',
  '象限',
  '优先级',
  '标签',
  '地点',
  '备注',
  '提醒提前',
  '重复',
] as const;

const COLUMN_KEYS: ColumnKey[] = [
  'title',
  'date',
  'time',
  'endTime',
  'quadrant',
  'priority',
  'tags',
  'location',
  'note',
  'remind',
  'repeat',
];

export interface ImportRow {
  /** CSV 里的行号，从 1 开始（表头是第 1 行），报错时直接指给用户看 */
  line: number;
  draft: NewTask;
  /** 标签名，落库时按名字查/建 */
  tags: string[];
}

export interface RowError {
  line: number;
  message: string;
}

export interface ParseOutcome {
  /** 表头层面就无法继续时为 true（比如根本没有"标题"列） */
  fatal: string | null;
  rows: ImportRow[];
  errors: RowError[];
  /** 数据行总数（不含表头），用于"共 N 行"的提示 */
  total: number;
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const PRIORITY_ALIASES: Record<string, number> = {
  无: 0,
  低: 1,
  中: 2,
  高: 3,
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const WEEKDAY_ALIASES: Record<string, Weekday> = {
  一: 'MO',
  二: 'TU',
  三: 'WE',
  四: 'TH',
  五: 'FR',
  六: 'SA',
  日: 'SU',
  天: 'SU',
};

function normalizeHeader(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '').replace(/[*＊]/g, '');
}

function mapHeaders(header: string[]): Partial<Record<ColumnKey, number>> {
  const positions: Partial<Record<ColumnKey, number>> = {};
  header.forEach((cell, index) => {
    const normalized = normalizeHeader(cell);
    if (normalized === '') return;
    for (const key of COLUMN_KEYS) {
      if (positions[key] !== undefined) continue;
      if (HEADER_ALIASES[key].some((alias) => normalizeHeader(alias) === normalized)) {
        positions[key] = index;
        return;
      }
    }
  });
  return positions;
}

/**
 * 本地时区把日期+时间合成时间戳。
 *
 * 必须显式拼 `T00:00:00`：`new Date('2026-12-01')` 按 **UTC** 解析，
 * 在 UTC+8 就是本地 08:00 —— 再加 9 小时会得到 17:00，比用户想写的晚了 8 小时。
 * 这种错误在 UTC+0 的机器上完全看不出来，只在东八区出现。
 */
function combine(dateKey: string, time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return new Date(`${dateKey}T00:00:00`).getTime() + hour! * 3_600_000 + minute! * 60_000;
}

function parseQuadrant(raw: string): Quadrant | null {
  const text = raw.trim();
  if (text === '') return 4;
  // 01 / 1 / 重要且紧急 都认
  const asNumber = Number(text);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= 4) return asNumber as Quadrant;
  for (const [key, meta] of Object.entries(QUADRANT_META)) {
    if (meta.title === text || meta.no === text) return Number(key) as Quadrant;
  }
  return null;
}

function parsePriority(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return 0;
  const asNumber = Number(text);
  if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= 3) return asNumber;
  const mapped = PRIORITY_ALIASES[text.toLowerCase()] ?? PRIORITY_ALIASES[text];
  return mapped ?? null;
}

/**
 * 重复规则的文字档位 → iCal。
 *
 * 注意两处受限于 core 的实现（`packages/core/src/recurrence/rrule.ts` 的 SUPPORTED_KEYS
 * 没有 BYMONTH）：
 *   · 「每月」取**日期列**的那一天
 *   · 「每年」取**日期列**的月日，不能单独指定"每年 3 月 5 日"
 * 所以这两档必须有日期列，否则无处取锚点。
 */
function parseRepeat(raw: string, dateKey: string | null): { rrule: string | null; error: string | null } {
  const text = raw.trim();
  if (text === '') return { rrule: null, error: null };

  if (text === '每天') return { rrule: buildRrule({ freq: 'DAILY' }), error: null };
  if (text === '工作日') {
    return { rrule: buildRrule({ freq: 'WEEKLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }), error: null };
  }

  const weekday = /^每周([一二三四五六日天])$/.exec(text);
  if (weekday) {
    const day = WEEKDAY_ALIASES[weekday[1]!]!;
    return { rrule: buildRrule({ freq: 'WEEKLY', byDay: [day] }), error: null };
  }

  const monthDay = /^每月(\d{1,2})[日号]$/.exec(text);
  if (monthDay) {
    const day = Number(monthDay[1]);
    if (day < 1 || day > 31) return { rrule: null, error: `「${text}」里的日期超出 1–31` };
    return { rrule: buildRrule({ freq: 'MONTHLY', byMonthDay: [day] }), error: null };
  }

  // 「每月」「每年」需要日期列提供锚点
  if (text === '每月' || text === '每年') {
    if (dateKey === null) {
      return { rrule: null, error: `「${text}」需要填「日期」列，否则没有可重复的锚点` };
    }
    if (text === '每月') {
      // 直接从字符串取"日"：`new Date('2026-12-01').getDate()` 走 UTC，东八区会取到前一天
      const dayOfMonth = Number(dateKey.slice(8, 10));
      return { rrule: buildRrule({ freq: 'MONTHLY', byMonthDay: [dayOfMonth] }), error: null };
    }
    return { rrule: buildRrule({ freq: 'YEARLY' }), error: null };
  }

  return {
    rrule: null,
    error: `无法识别的重复规则「${text}」，可填：每天 / 工作日 / 每周一…每周日 / 每月 / 每月15号 / 每年`,
  };
}

/** 单行转换。返回错误字符串而不是抛异常：我们要一次收齐所有行的错，而不是遇到第一行就停 */
function parseRow(
  cells: string[],
  positions: Partial<Record<ColumnKey, number>>,
  line: number,
): { row: ImportRow } | { error: string } {
  const cell = (key: ColumnKey): string => {
    const index = positions[key];
    if (index === undefined) return '';
    return (cells[index] ?? '').trim();
  };

  const title = cell('title');
  if (title === '') return { error: '「标题」不能为空' };
  if (title.length > 512) return { error: '「标题」超过 512 字' };

  const rawDate = cell('date');
  let dueDate: string | null = null;
  if (rawDate !== '') {
    if (!isDateKey(rawDate)) {
      return { error: `「日期」"${rawDate}" 不是合法的 YYYY-MM-DD（比如 2026-12-01）` };
    }
    dueDate = rawDate;
  }

  const rawTime = cell('time');
  let startAt: number | null = null;
  if (rawTime !== '') {
    if (!TIME_RE.test(rawTime)) return { error: `「时间」"${rawTime}" 不是合法的 HH:MM` };
    if (dueDate === null) return { error: '填了「时间」就必须填「日期」，否则不知道是哪一天' };
    startAt = combine(dueDate, rawTime);
  }

  const rawEnd = cell('endTime');
  let endAt: number | null = null;
  if (rawEnd !== '') {
    if (!TIME_RE.test(rawEnd)) return { error: `「结束时间」"${rawEnd}" 不是合法的 HH:MM` };
    if (dueDate === null) return { error: '填了「结束时间」就必须填「日期」' };
    endAt = combine(dueDate, rawEnd);
    if (startAt !== null && endAt <= startAt) {
      // 跨天结束（22:00→01:00）在待办里几乎没有意义，直接报错比猜一个更诚实
      return { error: '「结束时间」必须晚于「时间」；跨天的任务请拆成两条' };
    }
    if (startAt === null) startAt = endAt - 3_600_000;
  }

  const quadrant = parseQuadrant(cell('quadrant'));
  if (quadrant === null) {
    return { error: `「象限」"${cell('quadrant')}" 无法识别，可填 01–04 或 1–4` };
  }

  const priority = parsePriority(cell('priority'));
  if (priority === null) {
    return { error: `「优先级」"${cell('priority')}" 无法识别，可填 无/低/中/高 或 0–3` };
  }

  const rawRemind = cell('remind');
  let remindLeadMinutes: number | null = null;
  if (rawRemind !== '') {
    const minutes = Number(rawRemind);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10_080) {
      return { error: `「提醒提前」"${rawRemind}" 必须是 0–10080 的整数（分钟）` };
    }
    if (startAt === null && dueDate === null) {
      return { error: '填了「提醒提前」就必须有日期或时间，否则没有可提醒的时刻' };
    }
    remindLeadMinutes = minutes;
  }

  const repeat = parseRepeat(cell('repeat'), dueDate);
  if (repeat.error !== null) return { error: repeat.error };

  // 分号分隔：CSV 本身用逗号分列，标签里再写逗号必须加引号，Excel 里一改就乱
  const tags = cell('tags')
    .split(/[;；]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .slice(0, 20);

  const note = cell('note');
  const location = cell('location');

  return {
    row: {
      line,
      tags,
      draft: {
        title,
        note: note === '' ? undefined : note.slice(0, 10_000),
        quadrant,
        priority,
        dueDate,
        startAt,
        endAt,
        location: location === '' ? null : location.slice(0, 256),
        tagIds: [],
        rrule: repeat.rrule,
        remindLeadMinutes,
      },
    },
  };
}

/** 把整张 CSV 表转成草稿列表；所有错误一次收齐 */
export function parseRows(table: string[][]): ParseOutcome {
  if (table.length === 0) return { fatal: '文件是空的', rows: [], errors: [], total: 0 };

  const header = table[0]!;
  const positions = mapHeaders(header);

  if (positions.title === undefined) {
    return {
      fatal: `找不到「标题」列。当前表头是：${header.map((cell) => cell.trim() || '(空)').join(' / ')}`,
      rows: [],
      errors: [],
      total: 0,
    };
  }

  const body = table.slice(1);
  const rows: ImportRow[] = [];
  const errors: RowError[] = [];

  body.forEach((cells, index) => {
    // +2：CSV 从 1 数，且第 1 行是表头。这样报出来的行号与 Excel 左侧的行号一致
    const line = index + 2;
    const parsed = parseRow(cells, positions, line);
    if ('error' in parsed) errors.push({ line, message: parsed.error });
    else rows.push(parsed.row);
  });

  return { fatal: null, rows, errors, total: body.length };
}

/** 模板内容：两行示例覆盖「全天 + 标签 + 提醒」和「定时 + 结束时间 + 重复」两种形态 */
export function templateRows(): string[][] {
  return [
    [...TEMPLATE_HEADERS],
    ['交本周周报', '2026-12-01', '', '', '01', '高', '工作', '', '把上周的数据补上', '15', ''],
    ['每周复盘', '2026-12-04', '18:00', '19:00', '02', '中', '工作；复盘', '会议室 A', '', '30', '每周五'],
  ];
}
