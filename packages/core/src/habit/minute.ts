/**
 * 「一天中的第几分钟」（0..1439）与 `HH:MM` 的互转。
 *
 * 为什么用分钟数而不是 `HH:MM` 字符串存库：
 *   字符串要先校验格式才能比较，"25:99" 这种脏值一旦落库，排程时要么静默不响，
 *   要么被 JS 的 Date 悄悄滚到第二天。整数没有这些歧义。
 *
 * 三个端都要用（App 排程、Web 表单、服务端清洗），所以放 core，不各写一份。
 */

/** 分钟数 → `HH:MM`。越界夹到端点，负数当 0 */
export function formatMinuteOfDay(minute: number): string {
  const safe = Math.min(1439, Math.max(0, Math.trunc(Number.isFinite(minute) ? minute : 0)));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

/**
 * `HH:MM` → 分钟数。
 *
 * 做不到就返回 null（而不是抛）：调用方是输入框的 onChange，
 * 用户把"21:00"删成"21:"的中途这一定会发生，抛异常会把整个表单打挂。
 */
export function parseMinuteOfDay(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}
