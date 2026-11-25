import type { Habit, Task } from '@grid/core';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
/**
 * 本地提醒的排程（docs/11 §8）。
 *
 * 两条链路：
 *   · 任务提醒  —— 一次性通知，时间 = 锚点 − 提前量。锚点有 startAt 用 startAt，
 *                  否则用 dueDate 当天 09:00（全天任务总得有个时刻，9 点是唯一不冒犯人的选择）
 *   · 打卡提醒  —— 每日重复通知，时间来自 habit.remindMinute
 *
 * 为什么每次都是"全取消再全排"而不是增量更新：
 *   增量更新要维护"哪条通知对应哪个任务"，而这个映射在应用被系统杀掉、
 *   数据被另一台设备改过之后必然对不上。全量重排在几百条规模下只是几十毫秒，
 *   换来的是"绝不会出现两条重复通知"。
 *
 * 代价要认：**用户手动在系统里关掉的通知，下次重新排程会再出现**。
 * 这不是 bug —— 我们能控制的只有排程，控制不了系统的通知开关。
 */

const CHANNEL_ID = 'reminders';
/** 只排未来 7 天：再远的提醒，等用户下次打开 App 时重排更准（任务大概率会改期） */
const MAX_DAYS_AHEAD = 7;
/** 少于 30 秒后触发的提醒直接跳过：排完就响，用户会以为是 bug */
const MIN_LEAD_MS = 30_000;

export type NotificationPermission = 'granted' | 'denied' | 'undetermined';

/** 任务的提醒锚点 */
export function taskAnchor(task: Pick<Task, 'startAt' | 'dueDate'>): number | null {
  if (task.startAt !== null) return task.startAt;
  if (task.dueDate !== null) return new Date(`${task.dueDate}T09:00:00`).getTime();
  return null;
}

/** 这条任务应该在哪一刻提醒；null 表示不提醒 */
export function taskReminderAt(task: Task): number | null {
  if (task.remindLeadMinutes === null) return null;
  if (task.completedAt !== null) return null;
  if (task.deletedAt !== null || task.archivedAt !== null) return null;
  const anchor = taskAnchor(task);
  if (anchor === null) return null;
  return anchor - task.remindLeadMinutes * 60_000;
}

/** 每分钟的数字 → `HH:MM`，给界面显示用 */
export { formatMinuteOfDay, parseMinuteOfDay } from '@grid/core';

export async function ensurePermission(): Promise<NotificationPermission> {
  if (Platform.OS === 'web') return 'denied';
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return 'granted';
  if (!current.canAskAgain) return 'denied';
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted ? 'granted' : 'denied';
}

export async function currentPermission(): Promise<NotificationPermission> {
  if (Platform.OS === 'web') return 'denied';
  const status = await Notifications.getPermissionsAsync();
  if (status.granted) return 'granted';
  return status.canAskAgain ? 'undetermined' : 'denied';
}

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: '提醒',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
  });
}

/**
 * 数据指纹。
 *
 * 每次同步完都重排一遍会平白无故地反复调原生接口（cancelAll + N 次 schedule），
 * 而绝大多数时候数据根本没变。指纹相同就直接跳过。
 */
function fingerprint(tasks: readonly Task[], habits: readonly Habit[]): string {
  const parts: string[] = [];
  for (const task of tasks) {
    const at = taskReminderAt(task);
    if (at !== null) parts.push(`t:${task.id}:${at}:${task.title}`);
  }
  for (const habit of habits) {
    if (habit.remindMinute !== null && habit.archivedAt === null && habit.deletedAt === null) {
      parts.push(`h:${habit.id}:${habit.remindMinute}:${habit.name}`);
    }
  }
  return parts.sort().join('|');
}

let lastFingerprint = '';

export interface RescheduleResult {
  scheduled: number;
  /** 权限没给 / 平台不支持时为 false */
  enabled: boolean;
}

export async function rescheduleReminders(
  tasks: readonly Task[],
  habits: readonly Habit[],
  options: { force?: boolean } = {},
): Promise<RescheduleResult> {
  if (Platform.OS === 'web') return { scheduled: 0, enabled: false };

  const next = fingerprint(tasks, habits);
  if (!options.force && next === lastFingerprint) return { scheduled: 0, enabled: true };

  const permission = await currentPermission();
  if (permission !== 'granted') {
    // 没权限就不要排：排了也不会响，而且会让"设置页显示已排程"变成谎话
    return { scheduled: 0, enabled: false };
  }

  await ensureChannel();
  await Notifications.cancelAllScheduledNotificationsAsync();

  const now = Date.now();
  const until = now + MAX_DAYS_AHEAD * 86_400_000;
  let scheduled = 0;

  for (const task of tasks) {
    const at = taskReminderAt(task);
    if (at === null || at <= now + MIN_LEAD_MS || at > until) continue;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '待办提醒',
        body: task.title,
        data: { kind: 'task', id: task.id },
        sound: true,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at) },
    });
    scheduled += 1;
  }

  for (const habit of habits) {
    if (habit.remindMinute === null) continue;
    if (habit.archivedAt !== null || habit.deletedAt !== null) continue;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '打卡提醒',
        body: habit.name,
        data: { kind: 'habit', id: habit.id },
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: Math.floor(habit.remindMinute / 60),
        minute: habit.remindMinute % 60,
      },
    });
    scheduled += 1;
  }

  lastFingerprint = next;
  return { scheduled, enabled: true };
}

/** 退出登录时清空：否则换了账号还会收到上一个人的提醒 */
export async function cancelAllReminders(): Promise<void> {
  if (Platform.OS === 'web') return;
  lastFingerprint = '';
  await Notifications.cancelAllScheduledNotificationsAsync();
}
