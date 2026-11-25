import { z } from 'zod';

/**
 * 打卡习惯。
 *
 * 三种类型共用一张表（不是三张）：它们的差别只有一个"目标值怎么比"，
 * 拆表会让列表页、热力图、连续天数都要写三份。
 *
 * `daysOfWeek` 为空数组表示"每天"。存 JSON 数组而不是 7 个布尔列：
 * 加"每月 1 号"这类规则时不用改表结构。
 */
export const HABIT_TYPES = ['check', 'count', 'duration'] as const;
export type HabitType = (typeof HABIT_TYPES)[number];

export const habitSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** check = 打勾；count = 计数（喝 8 杯水）；duration = 时长（冥想 10 分钟） */
  type: z.enum(HABIT_TYPES),
  /** 目标值：check 固定 1，count 是次数，duration 是分钟 */
  target: z.number().int().positive(),
  /** 计数型的单位（杯/次/页），时长型固定"分钟" */
  unit: z.string().nullable(),
  /** 0=周一 … 6=周日；空数组 = 每天 */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7),
  /** 0..5，灰阶档位，与标签/日历共用同一套色阶 */
  colorKey: z.number().int(),
  sortOrder: z.number().int(),
  /**
   * 一天中的第几分钟（0..1439）提醒打卡，null = 不提醒。
   *
   * 存时刻而不是时间戳：打卡提醒是"每天 21:00"，与日期无关。
   * 存时间戳的话每过一天就得重新排一次，而"排程失败"是完全静默的。
   */
  remindMinute: z.number().int().min(0).max(1439).nullable().default(null),
  /** 归档后不再出现在今日列表，但历史与统计保留 */
  archivedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
  rev: z.number().int(),
});

export type Habit = z.infer<typeof habitSchema>;

export const newHabitSchema = habitSchema.pick({ name: true, type: true }).extend({
  target: z.number().int().positive().max(1000).optional(),
  unit: z.string().max(8).nullable().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  remindMinute: z.number().int().min(0).max(1439).nullable().optional(),
});
export type NewHabit = z.infer<typeof newHabitSchema>;

/** check 型目标恒为 1；其余留空时给个合理默认 */
export function defaultTarget(type: HabitType): number {
  if (type === 'check') return 1;
  if (type === 'count') return 8;
  return 10;
}

export function habitUnit(habit: Pick<Habit, 'type' | 'unit'>): string {
  if (habit.type === 'duration') return '分钟';
  if (habit.type === 'check') return '次';
  return habit.unit ?? '次';
}
