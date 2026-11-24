import type { Task } from '../models/task.js';
import { expandSeries, type RecurExceptionLike } from './expand.js';

/** 推进后要写回去的字段。null 表示规则已结束，不该再推进 */
export interface AdvancePatch {
  dueDate: string | null;
  startAt: number | null;
  endAt: number | null;
  allDay: boolean;
}

function dateKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 重复任务被完成 / 被跳过之后，应该落到哪一天。
 *
 * 这是整件东西最容易做错的地方：把 `completedAt` 一设，任务在列表里就消失了，
 * 而"消失"对重复任务是错的——用户要的是"这一次做完了，下一次照旧"。
 * 所以重复任务不设 completedAt，而是把母体的日期**滚动到下一次**。
 *
 * 边界：
 *   · 规则已结束（COUNT 用完 / 超过 UNTIL）→ 返回 null，调用方按普通任务处理
 *   · 原任务是"全天"（只有 dueDate、没有 startAt）→ 推进后仍然全天，不带时间
 *   · 原任务有具体时间 → 保留时长（endAt - startAt），只挪开始
 *
 * `after` 传"现在"：周一做的任务，下一次应该是周三而不是周一。
 * 如果传任务原定的开始时间，已经过期的实例会被重新算出来，推进就原地打转。
 */
export function nextOccurrencePatch(
  task: Task,
  exceptions: readonly RecurExceptionLike[],
  after: number = Date.now(),
): AdvancePatch | null {
  if (!task.rrule) return null;

  try {
  const anchor =
    task.startAt ?? (task.dueDate ? new Date(`${task.dueDate}T09:00:00`).getTime() : null);
  if (anchor === null) return null;

  // 当前这一次的时间戳：完成/跳过都表示"这一次结束了"，下一次必须严格晚于它。
  // 不能只靠窗口的 from 排除 —— expandSeries 为了让"改期到窗口内的实例"可见，
  // 会把起点往前放宽 SHIFT_WINDOW，今天的实例于是又出现在结果里。
  const currentTs = anchor;

  // 一年足够覆盖任何现实规则；多取几条再用 currentTs 过滤
  const horizon = after + 366 * 86_400_000;
  const occurrences = expandSeries(
    {
      id: task.id,
      title: task.title,
      startAt: anchor,
      endAt: task.endAt,
      allDay: task.allDay,
      rrule: task.rrule,
      exceptions,
      kind: 'task',
      origin: null,
    },
    after,
    horizon,
    8,
  );

  // 严格晚于当前这次。找不到就是规则结束了
  const next = occurrences.find((occ) => occ.start > currentTs);
  if (!next) return null;

  const duration =
    task.startAt !== null && task.endAt !== null ? task.endAt - task.startAt : null;
  const hasTime = task.startAt !== null;

  return {
    dueDate: dateKeyOf(next.start),
    startAt: hasTime ? next.start : null,
    endAt: hasTime && duration !== null ? next.start + duration : null,
    allDay: !hasTime,
  };
  } catch {
    // 规则非法（历史数据、手改过的 RRULE）时不要抛：
    // 调用方是"勾选完成"，抛出去会让整次点击失效，界面看起来完全没反应。
    // 返回 null 表示"不推进"，落到普通完成逻辑，至少这次勾选是生效的。
    return null;
  }
}
