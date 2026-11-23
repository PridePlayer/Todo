import { z } from 'zod';

/**
 * 一天的打卡记录。
 *
 * 两条硬约束（docs/03 §4.5）：
 *   1. 主键是**确定性生成**的 `hash(habitId + logDate)`，不是随机 ULID。
 *      两台设备同一天各打一次卡会算出同一个 id，于是同步时是"同一条记录合并"，
 *      而不是"两条记录都插进去，界面显示 2/8"（看起来像打卡翻倍）。
 *   2. 合并取值用 `GREATEST`，**不能相加**。相加的话同步一次数字就翻倍，
 *      而且没有第二次机会纠正——本地已经是被加过的值了。
 */
export const habitLogSchema = z.object({
  id: z.string(),
  habitId: z.string(),
  /** 本地时区的 'YYYY-MM-DD'。不用 epoch：跨时区后同一天会变成两天 */
  logDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** check 型恒为 1；count 是次数；duration 是分钟 */
  value: z.number(),
  /** 是补卡（事后补记）。热力图上要画斜纹，避免"和当天真的做了"混淆 */
  backfilled: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
  rev: z.number().int(),
});

export type HabitLog = z.infer<typeof habitLogSchema>;

/** 打卡是否达标。check 型看有没有记录，其余看 value 是否够 */
export function reached(habit: { type: string; target: number }, value: number): boolean {
  return value >= habit.target;
}

export function progressOf(habit: { type: string; target: number }, value: number): number {
  if (habit.target <= 0) return value > 0 ? 1 : 0;
  return Math.min(1, value / habit.target);
}
