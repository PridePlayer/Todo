import {
  dateKeyInZone,
  defaultTarget,
  habitLogId,
  type Habit,
  type HabitLog,
  type HabitType,
  ulid,
} from '@grid/core';
import { db } from './dexie';
import { enqueueTableCreate, enqueueTableDelete, enqueueTableUpdate } from './repo';

/**
 * 打卡的本地写入路径。
 *
 * 与 task / cal_event 一样分成单独一层，不塞进 repo.ts：
 * 这里所有写入都围绕一个**确定性主键**（habitLogId），而别的表用的都是随机 ULID。
 * 把两种 id 语义混在一个类里，早晚会有人在删除时用错那一种。
 *
 * 纪律：**先写本地，再入队**。顺序反过来的症状是界面闪一下旧值（队列先 flush，
 * 服务端回包又把它写回来），而打卡这种"点一下就该立刻有反馈"的交互尤其不能闪。
 */

const MAX_NAME = 64;

export function todayKey(): string {
  return dateKeyInZone(Date.now());
}

export interface HabitDraft {
  name: string;
  type: HabitType;
  target?: number;
  unit?: string | null;
  /** 空数组 = 每天 */
  daysOfWeek?: number[];
  colorKey?: number;
  /** 一天中的第几分钟（0..1439）提醒打卡，null = 不提醒 */
  remindMinute?: number | null;
}

function habitFields(habit: Habit): Record<string, unknown> {
  return {
    name: habit.name,
    type: habit.type,
    target: habit.target,
    unit: habit.unit,
    daysOfWeek: habit.daysOfWeek,
    colorKey: habit.colorKey,
    remindMinute: habit.remindMinute,
    sortOrder: habit.sortOrder,
    archivedAt: habit.archivedAt,
    createdAt: habit.createdAt,
    updatedAt: habit.updatedAt,
    deletedAt: habit.deletedAt,
  };
}

function logFields(log: HabitLog): Record<string, unknown> {
  return {
    habitId: log.habitId,
    logDate: log.logDate,
    value: log.value,
    backfilled: log.backfilled,
    note: log.note,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
    deletedAt: log.deletedAt,
  };
}

export async function createHabit(draft: HabitDraft): Promise<Habit> {
  const name = draft.name.trim().slice(0, MAX_NAME);
  if (name === '') throw new Error('习惯名称不能为空');

  const now = Date.now();
  const sortOrder = await nextSortOrder();
  const habit: Habit = {
    id: ulid(now),
    name,
    type: draft.type,
    // check 型的目标恒为 1：让用户给"每天读书"设一个目标次数，只会得到 1/3 这种看不懂的进度
    target: draft.type === 'check' ? 1 : Math.max(1, Math.trunc(draft.target ?? defaultTarget(draft.type))),
    unit: draft.type === 'duration' ? null : (draft.unit ?? null),
    daysOfWeek: [...new Set(draft.daysOfWeek ?? [])].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b),
    colorKey: draft.colorKey ?? 0,
    sortOrder,
    remindMinute: draft.remindMinute ?? null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    rev: 0,
  };

  await db.habits.add(habit);
  await enqueueTableCreate('habit', habit.id, habitFields(habit));
  return habit;
}

async function nextSortOrder(): Promise<number> {
  const rows = await db.habits.toArray();
  let max = 0;
  for (const row of rows) if (row.sortOrder > max) max = row.sortOrder;
  return max + 1;
}

export type HabitPatch = Partial<
  Pick<Habit, 'name' | 'target' | 'unit' | 'daysOfWeek' | 'colorKey' | 'sortOrder' | 'remindMinute'>
>;

export async function patchHabit(id: string, patch: HabitPatch): Promise<void> {
  const row = await db.habits.get(id);
  if (!row || row.deletedAt !== null) return;

  const fields: Record<string, unknown> = {};
  const base: Record<string, unknown> = {};

  const put = (key: keyof HabitPatch, value: unknown): void => {
    if (value === undefined) return;
    if (JSON.stringify(row[key]) === JSON.stringify(value)) return;
    fields[key] = value;
    base[key] = row[key];
  };

  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, MAX_NAME);
    if (name === '') throw new Error('习惯名称不能为空');
    put('name', name);
  }
  if (patch.target !== undefined) put('target', Math.max(1, Math.trunc(patch.target)));
  if (patch.unit !== undefined) put('unit', patch.unit);
  if (patch.daysOfWeek !== undefined) {
    put('daysOfWeek', [...new Set(patch.daysOfWeek)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b));
  }
  if (patch.colorKey !== undefined) put('colorKey', Math.min(5, Math.max(0, Math.trunc(patch.colorKey))));
  if (patch.sortOrder !== undefined) put('sortOrder', patch.sortOrder);
  if (patch.remindMinute !== undefined) {
    // null = 取消提醒；数字夹到 0..1439（一天内的分钟数）
    const minute =
      patch.remindMinute === null
        ? null
        : Math.min(1439, Math.max(0, Math.trunc(Number(patch.remindMinute))));
    put('remindMinute', minute);
  }

  if (Object.keys(fields).length === 0) return;

  const now = Date.now();
  await db.habits.put({ ...row, ...(fields as Partial<Habit>), updatedAt: now });
  await enqueueTableUpdate('habit', id, { ...fields, updatedAt: now }, base, row.rev);
}

/** 归档：不再出现在今日列表，但历史与统计保留 */
export async function archiveHabit(id: string, archived: boolean): Promise<void> {
  const row = await db.habits.get(id);
  if (!row || row.deletedAt !== null) return;
  const now = Date.now();
  const archivedAt = archived ? now : null;
  if (row.archivedAt === archivedAt) return;

  await db.habits.put({ ...row, archivedAt, updatedAt: now });
  await enqueueTableUpdate(
    'habit',
    id,
    { archivedAt, updatedAt: now },
    { archivedAt: row.archivedAt },
    row.rev,
  );
}

/**
 * 删除习惯：连带它的全部记录一起软删。
 *
 * 只删习惯不删记录会留下孤儿（记录还在、习惯没了），而孤儿记录的 id 是确定性的，
 * 将来"又建了同名习惯"也不会复活它们——它们就永久占着一份同步流量，谁也看不见。
 * 这正是 M3 例外表踩过的坑，这里一次做对。
 */
export async function deleteHabit(id: string): Promise<void> {
  const row = await db.habits.get(id);
  if (!row || row.deletedAt !== null) return;

  const now = Date.now();
  const logs = await db.habitLogs.where('habitId').equals(id).toArray();
  const alive = logs.filter((log) => log.deletedAt === null);

  await db.habits.put({ ...row, deletedAt: now, updatedAt: now });
  await db.habitLogs.bulkPut(alive.map((log) => ({ ...log, deletedAt: now, updatedAt: now })));

  await enqueueTableDelete('habit', id, row.rev);
  for (const log of alive) {
    await enqueueTableDelete('habit_log', log.id, log.rev);
  }
}

export interface LogWrite {
  value: number;
  note?: string | null;
}

/**
 * 写某一天的值（唯一写入入口）。
 *
 * 三条约定：
 *   1. id 由 `habitLogId(habitId, logDate)` 算出，**不是随机生成**。
 *      两台设备同一天各写一次时命中同一行，服务端才有机会按"取较大值"合并。
 *   2. 值降到 0 且原本有记录 → 软删记录，而不是留一条 value=0 的行。
 *      留着 0 会让"这天有没有做过"变成"这天做过但记了 0"，补卡列表里会冒出一堆 0。
 *   3. 日期早于今天就标记 backfilled（补卡）。热力图要把它画成斜纹，
 *      否则"事后一次补 10 天"看起来和"真的坚持了 10 天"一模一样。
 */
export async function setLog(habit: Habit, logDate: string, write: LogWrite): Promise<void> {
  const id = habitLogId(habit.id, logDate);
  const existing = await db.habitLogs.get(id);
  const now = Date.now();
  const value = Math.max(0, write.value);

  if (existing && existing.deletedAt === null && value <= 0) {
    await db.habitLogs.put({ ...existing, deletedAt: now, updatedAt: now });
    await enqueueTableDelete('habit_log', id, existing.rev);
    return;
  }

  const backfilled = logDate < todayKey();

  if (existing) {
    // 复活路径：软删过的行必须复用同一个 id（服务端唯一索引是 (habit_id, log_date)），
    // 新建一行会被拒绝，而拒绝是静默的——用户会看到"点了但没记上"
    const next: HabitLog = {
      ...existing,
      value,
      backfilled,
      note: write.note ?? existing.note,
      deletedAt: null,
      updatedAt: now,
    };
    await db.habitLogs.put(next);
    await enqueueTableUpdate(
      'habit_log',
      id,
      { value, backfilled, note: next.note, deletedAt: null, updatedAt: now },
      { value: existing.value, backfilled: existing.backfilled, note: existing.note, deletedAt: existing.deletedAt },
      existing.rev,
    );
    return;
  }

  const log: HabitLog = {
    id,
    habitId: habit.id,
    logDate,
    value,
    backfilled,
    note: write.note ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    rev: 0,
  };
  await db.habitLogs.put(log);
  await enqueueTableCreate('habit_log', id, logFields(log));
}

export async function deleteLog(logId: string): Promise<void> {
  const row = await db.habitLogs.get(logId);
  if (!row || row.deletedAt !== null) return;
  const now = Date.now();
  await db.habitLogs.put({ ...row, deletedAt: now, updatedAt: now });
  await enqueueTableDelete('habit_log', logId, row.rev);
}

/** 今天的值 +1；到目标就停在这里（计数型不该出现 9/8，那会让"达标"变得没有意义） */
export async function bumpToday(habit: Habit, logDate: string = todayKey()): Promise<void> {
  const current = await db.habitLogs.get(habitLogId(habit.id, logDate));
  const base = current && current.deletedAt === null ? current.value : 0;
  if (base >= habit.target) return;
  await setLog(habit, logDate, { value: base + 1 });
}

/** 打勾型：有记录就撤掉，没有就记上 */
export async function toggleCheck(habit: Habit, logDate: string = todayKey()): Promise<void> {
  const current = await db.habitLogs.get(habitLogId(habit.id, logDate));
  const done = current !== undefined && current.deletedAt === null && current.value > 0;
  await setLog(habit, logDate, { value: done ? 0 : 1 });
}
