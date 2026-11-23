import type { CalEvent, CalendarSource, Habit, HabitLog, Tag, Task } from '@grid/core';
import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db } from '../db/dexie';
import { repo } from '../db/repo';

/**
 * 订阅本地库。
 *
 * 用 Dexie 的 liveQuery 而不是自己维护一个事件总线：
 * 它挂在 IndexedDB 的事务通知上，任何写入（包括另一个标签页写的）都会触发重查，
 * 多标签页同步这一条是白拿的——M1 只有一端，但这个能力以后不会再补。
 *
 * 返回 null 表示"还没读到第一次"，视图据此显示首屏骨架而不是空状态，
 * 否则刷新瞬间会闪一下"还没有任务"，很廉价。
 */
export function useTasks(): Task[] | null {
  const [tasks, setTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    const sub = liveQuery(() => repo.all()).subscribe({
      next: (rows) => setTasks(rows),
      error: (err: unknown) => console.error('[liveQuery:tasks]', err),
    });
    return () => sub.unsubscribe();
  }, []);

  return tasks;
}

/**
 * Outlook 事件镜像。
 *
 * 只取未删除的行：事件表里会有大量墓碑（Outlook 侧取消的会议），
 * 让视图层每次过滤会把"漏过滤"变成一个很难发现的 bug（幽灵会议一直挂在日历上）。
 */
export function useEvents(): CalEvent[] | null {
  const [rows, setRows] = useState<CalEvent[] | null>(null);

  useEffect(() => {
    const sub = liveQuery(() => db.events.filter((row) => row.deletedAt === null).toArray()).subscribe({
      next: (items) => setRows(items),
      error: (err: unknown) => console.error('[liveQuery:events]', err),
    });
    return () => sub.unsubscribe();
  }, []);

  return rows;
}

export function useSources(): CalendarSource[] {
  const [rows, setRows] = useState<CalendarSource[]>([]);

  useEffect(() => {
    const sub = liveQuery(() =>
      db.sources.filter((row) => row.deletedAt === null).toArray(),
    ).subscribe({
      next: (items) => setRows(items.sort((a, b) => a.sortOrder - b.sortOrder)),
      error: (err: unknown) => console.error('[liveQuery:sources]', err),
    });
    return () => sub.unsubscribe();
  }, []);

  return rows;
}

export function useTags(): Map<string, Tag> {
  const [tags, setTags] = useState<Map<string, Tag>>(new Map());

  useEffect(() => {
    const sub = liveQuery(() => repo.tags()).subscribe({
      next: (rows) => setTags(new Map(rows.map((tag) => [tag.id, tag]))),
      error: (err: unknown) => console.error('[liveQuery:tags]', err),
    });
    return () => sub.unsubscribe();
  }, []);

  return tags;
}

/**
 * 打卡习惯（不含已删除）。
 *
 * 归档的习惯照样返回：详情页与历史统计要用它，只是今天的列表不显示。
 * 排序在内存里做，因为 archivedAt 在前、sortOrder 在后的复合顺序用 Dexie 索引表达不了。
 */
export function useHabits(): Habit[] | null {
  const [rows, setRows] = useState<Habit[] | null>(null);

  useEffect(() => {
    const sub = liveQuery(() => db.habits.filter((row) => row.deletedAt === null).toArray()).subscribe({
      next: (items) =>
        setRows(
          items.sort((a, b) => {
            const aArchived = a.archivedAt === null ? 0 : 1;
            const bArchived = b.archivedAt === null ? 0 : 1;
            if (aArchived !== bArchived) return aArchived - bArchived;
            return a.sortOrder - b.sortOrder;
          }),
        ),
      error: (err: unknown) => console.error('[liveQuery:habits]', err),
    });
    return () => sub.unsubscribe();
  }, []);

  return rows;
}

/**
 * 打卡记录（不含墓碑）。
 *
 * 返回数组而不是 Map：调用方通常只要"某个习惯的记录"，而热力图和 streak 都接受
 * Iterable。这里不做按习惯分组的缓存，因为分组一旦缓存就必须在每个写路径上失效，
 * 而漏失效的症状是"打了卡热力图不亮"——最难查的那一类 bug。
 */
export function useHabitLogs(): HabitLog[] | null {
  const [rows, setRows] = useState<HabitLog[] | null>(null);

  useEffect(() => {
    const sub = liveQuery(() => db.habitLogs.filter((row) => row.deletedAt === null).toArray()).subscribe({
      next: (items) => setRows(items),
      error: (err: unknown) => console.error('[liveQuery:habitLogs]', err),
    });
    return () => sub.unsubscribe();
  }, []);

  return rows;
}
