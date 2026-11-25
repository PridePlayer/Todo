import {
  habitLogId,
  nextOccurrencePatch,
  ulid,
  type HabitLog,
  type RecurException,
  type Task,
} from '@grid/core';
import { ensureDeviceId } from '../auth';
import { putRow, queueOp, softDeleteRow } from '../db/local';
import { nextHlc } from '../hlc';

/**
 * 勾完成 / 打卡的写操作。
 *
 * 从 store.tsx 抽出来是为了让桌面小组件的 headless 任务复用**同一份**语义。
 * 这不是为了少写几行 —— 重复任务的勾选语义（推进母体而不是写 completedAt）
 * 和打卡的删除语义（算到 0 要删行而不是写 0）都是踩过坑才定下来的，
 * 在 widget 里重写一遍必然漏掉其中一条，而漏掉的症状要等用户用了几天才发现。
 */

export interface TaskToggleResult {
  task: Task;
  /** 给用户看的一句话（App 里走 flash，widget 里没有 toast，只用于日志） */
  message: string;
  /** true = 这次点的是"重复任务推进到下一次"，不是终态完成 */
  advanced: boolean;
}

export async function toggleTaskComplete(
  task: Task,
  exceptions: readonly RecurException[],
): Promise<TaskToggleResult> {
  const device = await ensureDeviceId();

  // 重复任务勾选完成 ≠ 终态。
  // 直接把 completedAt 写死会让整条记录从列表里消失，用户再也看不到下一次；
  // 正确语义是"这一次做完了，母体滚到下一个重复日"。
  if (task.rrule !== null && task.completedAt === null) {
    const patch = nextOccurrencePatch(task, [...exceptions]);
    if (patch !== null) {
      const next: Task = { ...task, ...patch, updatedAt: Date.now() };
      await putRow('task', task.id, task.rev, next as unknown as Record<string, unknown>);
      await queueOp({
        opId: ulid(),
        table: 'task',
        action: 'update',
        id: task.id,
        baseRev: task.rev,
        fields: patch as unknown as Record<string, unknown>,
        base: {
          dueDate: task.dueDate,
          startAt: task.startAt,
          endAt: task.endAt,
          allDay: task.allDay,
        },
        hlc: nextHlc(device),
      });
      return {
        task: next,
        message: `已跳到 ${patch.dueDate ?? '下一次'}（重复任务不会整条消失）`,
        advanced: true,
      };
    }
    // 规则已经结束（COUNT 用完 / 超过 UNTIL）→ 落到下面的普通完成逻辑
  }

  const nextCompleted = task.completedAt === null ? Date.now() : null;
  const payload = { ...task, completedAt: nextCompleted };
  // rev 不动：本地 rev 必须始终等于"服务端已知版本"，
  // 自己 +1 会让下一次 push 的 baseRev 高于服务端，永远冲突
  await putRow('task', task.id, task.rev, payload as unknown as Record<string, unknown>);
  await queueOp({
    opId: ulid(),
    table: 'task',
    action: 'update',
    id: task.id,
    baseRev: task.rev,
    fields: { completedAt: nextCompleted },
    base: { completedAt: task.completedAt },
    hlc: nextHlc(device),
  });

  return {
    task: { ...task, completedAt: nextCompleted },
    message: nextCompleted === null ? '已取消完成' : '已完成',
    advanced: false,
  };
}

export interface HabitCheckResult {
  /** 新的记录；null 表示这次操作把它删掉了（算到 0） */
  log: HabitLog | null;
  id: string;
}

/**
 * 打卡（可正可负）。
 *
 * 计数型是"加上去"而不是"设成某个值"，所以必须读当前值再算，
 * 并且主键用 core 的 habitLogId(habitId, logDate) —— 确定性主键让
 * "两台设备同一天各点一次"撞成同一行，服务端才能按 max 合并。
 */
export async function checkHabit(
  habitId: string,
  logDate: string,
  existing: HabitLog | null,
  delta = 1,
): Promise<HabitCheckResult> {
  const id = habitLogId(habitId, logDate);
  const device = await ensureDeviceId();
  const now = Date.now();
  const nextValue = Math.max(0, (existing?.value ?? 0) + delta);

  // 算到 0 就是"取消打卡"，必须**删掉这条记录**，不能写 value=0。
  //
  // 服务端对 habit_log.value 的合并是 GREATEST(local, remote) —— 那条规则
  // 正确地挡住了"两台设备各点一次被相加"，但也同样挡住了"把数字改小"：
  // 推上去的 0 会被服务端现有的 1 又并回来，界面表现为"取消了又自己打回来"。
  // 删除是幂等的、能传播的，且与 max 合并不冲突。
  //
  // 代价：计数型只能往上加，想减少就只能清零。这是合并语义本身决定的，
  // 而不是 UI 偷懒 —— 见 docs/03 §4.5。
  if (nextValue <= 0) {
    if (!existing) return { log: null, id };
    await softDeleteRow('habit_log', id, now);
    await queueOp({
      opId: ulid(),
      table: 'habit_log',
      action: 'delete',
      id,
      baseRev: existing.rev,
      fields: {},
      hlc: nextHlc(device),
    });
    return { log: null, id };
  }

  const next: HabitLog = {
    id,
    habitId,
    logDate,
    value: nextValue,
    backfilled: false,
    note: existing?.note ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
    rev: existing?.rev ?? 1,
  };
  await putRow('habit_log', id, existing?.rev ?? 1, next as unknown as Record<string, unknown>);
  await queueOp({
    opId: ulid(),
    table: 'habit_log',
    action: existing ? 'update' : 'create',
    id,
    baseRev: existing?.rev ?? 0,
    fields: next as unknown as Record<string, unknown>,
    hlc: nextHlc(device),
  });
  return { log: next, id };
}
