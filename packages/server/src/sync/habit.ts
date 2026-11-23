import { HABIT_TYPES, habitLogId, isDateKey } from '@grid/core';

/**
 * 打卡相关的写入规则（服务端侧）。
 *
 * 为什么这些规则不放在客户端：
 *   客户端一定有多个（Web / Android），每加一个端就要把"目标值不能为 0""星期不能是 9"
 *   再抄一遍，抄漏的那一次会变成库里一条永远算不出完成率的习惯——界面上表现为
 *   "这个习惯的完成率一直是 0%"，而它看起来像统计算错了。
 *   放在服务端是**唯一的收口点**：只要进来了就是干净的。
 */

const MAX_NAME = 128;
const MAX_UNIT = 8;
const MAX_TARGET = 100_000;

export type SanitizeResult =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; reason: string };

function asArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((item) => Number(item));
  // 客户端没走 JSON 编码时（手工调接口）可能是字符串
  if (typeof value === 'string' && value !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((item) => Number(item)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 规范化 habit 的写入字段。
 *
 * 只处理"能在不改语义的前提下修好"的脏数据：
 *   daysOfWeek 去重排序、越界值丢弃 —— 顺序和重复对语义没有影响
 *   target 抬到 1                        —— 0 会让完成率的分母变成 0（NaN%）
 * 不能修的（type 不认识、name 为空）直接拒绝，不要猜。
 */
export function sanitizeHabitFields(fields: Record<string, unknown>): SanitizeResult {
  const out: Record<string, unknown> = { ...fields };

  if (fields.type !== undefined) {
    if (typeof fields.type !== 'string' || !(HABIT_TYPES as readonly string[]).includes(fields.type)) {
      return { ok: false, reason: 'bad_habit_type' };
    }
    out.type = fields.type;
  }

  if (fields.name !== undefined) {
    const name = typeof fields.name === 'string' ? fields.name.trim().slice(0, MAX_NAME) : '';
    if (name === '') return { ok: false, reason: 'missing_name' };
    out.name = name;
  }

  if (fields.target !== undefined) {
    const target = Math.trunc(Number(fields.target));
    if (!Number.isFinite(target) || target <= 0) return { ok: false, reason: 'bad_target' };
    out.target = Math.min(target, MAX_TARGET);
  }

  if (fields.unit !== undefined) {
    out.unit = typeof fields.unit === 'string' && fields.unit !== '' ? fields.unit.slice(0, MAX_UNIT) : null;
  }

  if (fields.daysOfWeek !== undefined) {
    // 空数组 = 每天。越界的值直接丢掉而不是拒绝：用户不会手写 9，
    // 出现 9 只可能是某次代码 bug，丢掉比让整条习惯写不进去更好
    out.daysOfWeek = [...new Set(asArray(fields.daysOfWeek))]
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((a, b) => a - b);
  }

  return { ok: true, fields: out };
}

/**
 * 打卡记录的身份校验。
 *
 * 两条都必须成立，否则同一天会出现两行（两台设备各点一次 → 数字翻倍，且无法纠正）：
 *   1. id 必须等于 hash(habitId + logDate)
 *   2. logDate 必须是真正的 'YYYY-MM-DD'（2026-02-30 这种会被 isDateKey 挡掉）
 */
export function checkLogIdentity(
  id: string,
  habitId: unknown,
  logDate: unknown,
): { ok: true; habitId: string; logDate: string; id: string } | { ok: false; reason: string } {
  if (typeof habitId !== 'string' || habitId === '') return { ok: false, reason: 'missing_habitId' };
  if (typeof logDate !== 'string' || !isDateKey(logDate)) return { ok: false, reason: 'bad_log_date' };
  const expected = habitLogId(habitId, logDate);
  if (id !== expected) return { ok: false, reason: 'nondeterministic_log_id' };
  return { ok: true, habitId, logDate, id: expected };
}

/** 记录值的合法范围：负数没有意义，超大值通常是"手滑多按了几个 0" */
export function clampLogValue(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_TARGET);
}
