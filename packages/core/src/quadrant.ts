import type { Quadrant, Task } from './models/task.js';

/**
 * 四象限的编号约定，全项目只认这一套：
 *
 *   01 重要且紧急    02 重要不紧急
 *   03 紧急不重要    04 不重要不紧急
 *
 * 位数公式：quadrant = 4 - (important*2 + urgent)。
 * 也就是说数据库里那个 `important*2+urgent` 生成列（0~3）与本编号是**反向**的，
 * 服务端 03 文档 §4.3 用的是生成列，这里是展示编号——两者换算只允许在本文件发生。
 */
export function quadrantOf(important: boolean, urgent: boolean): Quadrant {
  const bits = (important ? 2 : 0) + (urgent ? 1 : 0);
  return (4 - bits) as Quadrant;
}

export function flagsOf(quadrant: Quadrant): { important: boolean; urgent: boolean } {
  const bits = 4 - quadrant;
  return { important: (bits & 2) !== 0, urgent: (bits & 1) !== 0 };
}

export interface QuadrantMeta {
  no: string;
  title: string;
  hint: string;
}

export const QUADRANT_META: Record<Quadrant, QuadrantMeta> = {
  1: { no: '01', title: '重要且紧急', hint: '立刻做，别排期' },
  2: { no: '02', title: '重要不紧急', hint: '排进日程，长期价值都在这里' },
  3: { no: '03', title: '紧急不重要', hint: '尽快清掉，或想办法委派' },
  4: { no: '04', title: '不重要不紧急', hint: '删掉，或留到真的有空' },
};

/** 拖拽/键盘迁移的顺序：01 → 02 → 03 → 04 只是编号顺序，不是"重要性"顺序 */
export const QUADRANT_ORDER: Quadrant[] = [1, 2, 3, 4];

/**
 * 迁移到相邻象限。direction = -1 表示"往更靠前的一格走"（Alt+↑，04→03），+1 反之。
 * 注意这是**编号顺序**，不是重要性顺序：01→02 其实是从"重要且紧急"到"重要不紧急"。
 */
export function shiftQuadrant(current: Quadrant, direction: -1 | 1): Quadrant {
  const index = QUADRANT_ORDER.indexOf(current);
  const next = Math.min(QUADRANT_ORDER.length - 1, Math.max(0, index + direction));
  return QUADRANT_ORDER[next]!;
}

// ── 时间格式化 ────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

export function toDateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toTimeInput(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把 YYYY-MM-DD + HH:mm 合成 epoch 毫秒（按浏览器本地时区，与 tzid 字段的默认值一致） */
export function combineDateTime(dateStr: string, timeStr: string): number {
  return new Date(`${dateStr}T${timeStr}:00`).getTime();
}

function dayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000,
  );
}

function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 时间区间的显示。
 * 跨天必须显示"次日"，否则 23:00–01:00 会被读成负时长或当晚 01:00——
 * 这是 M1 验收第 6 条专门盯的点。
 */
export function formatTimeRange(startAt: number | null, endAt: number | null): string | null {
  if (startAt === null) return null;
  if (endAt === null) return `${clockOf(startAt)} 起`;

  const startDay = dayIndex(startAt);
  const endDay = dayIndex(endAt);
  const startClock = clockOf(startAt);
  const endClock = clockOf(endAt);

  if (endDay === startDay) {
    return endAt <= startAt ? `${startClock} – ${endClock}` : `${startClock} – ${endClock}`;
  }
  if (endDay === startDay + 1) return `${startClock} – 次日 ${endClock}`;

  const d = new Date(endAt);
  return `${startClock} – ${d.getMonth() + 1}月${d.getDate()}日 ${endClock}`;
}

/** 相对日期：今天 / 明天 / 昨天 / 3月5日 */
export function formatDateLabel(dateStr: string, now: number = Date.now()): string {
  const target = dayIndex(new Date(`${dateStr}T00:00:00`).getTime());
  const today = dayIndex(now);
  const diff = target - today;
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  const d = new Date(`${dateStr}T00:00:00`);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 行内副标题：优先显示时间段，其次日期 */
export function taskMetaText(task: Task, now: number = Date.now()): string | null {
  const range = formatTimeRange(task.startAt, task.endAt);
  if (range) return range;
  if (task.dueDate) return formatDateLabel(task.dueDate, now);
  return null;
}

// ── 排序 ─────────────────────────────────────────────────────

/**
 * 同一象限内的排序：手动顺序优先（sortOrder），其次有日期的靠前，最后创建时间。
 * 已完成不进这个比较器——列表层已经把它们分开了。
 */
export function compareTasks(a: Task, b: Task): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.startAt !== b.startAt) {
    if (a.startAt === null) return 1;
    if (b.startAt === null) return -1;
    return a.startAt - b.startAt;
  }
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return a.createdAt - b.createdAt;
}

/** 子任务按创建顺序，弱化排序概念 */
export function compareSubtasks(a: Task, b: Task): number {
  return a.createdAt - b.createdAt;
}

/** 过滤掉已软删除的，其余原样返回（软删的行在 IndexedDB 里仍然存在，等撤销窗口过去才物理删） */
export function visible(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => t.deletedAt === null);
}
