import { liveQuery } from 'dexie';
import { useEffect, useMemo, useState } from 'react';
import { expandTasks, type Occurrence, type RecurException, type SeriesLike, type Task } from '@grid/core';
import { db } from '../db/dexie';
import { repo } from '../db/repo';
import { useTasks } from '../hooks/useStore';

/**
 * 把窗口内的任务展开成实例。
 *
 * 例外单独订阅一次而不是并到 useTasks 里：例外与任务的生命周期不同
 * （删一次任务里的"某一次"不会改任务行），合并订阅会让每次任务写入都重查例外表。
 */
export function useExceptions(): RecurException[] {
  const [rows, setRows] = useState<RecurException[]>([]);
  useEffect(() => {
    const sub = liveQuery(() => repo.allExceptions()).subscribe({
      next: setRows,
      error: (err: unknown) => console.error('[liveQuery:exceptions]', err),
    });
    return () => sub.unsubscribe();
  }, []);
  return rows;
}

function toSeries(task: Task, bySeries: Map<string, RecurException[]>): SeriesLike {
  const anchor = task.startAt ?? (task.dueDate ? new Date(`${task.dueDate}T09:00:00`).getTime() : task.createdAt);
  return {
    id: task.id,
    title: task.title,
    startAt: anchor,
    endAt: task.endAt,
    allDay: task.allDay && task.startAt === null,
    rrule: task.rrule,
    exceptions: bySeries.get(task.id) ?? [],
  };
}

export function useOccurrences(from: number, to: number): { occurrences: Occurrence[]; loading: boolean } {
  const tasks = useTasks();
  const exceptions = useExceptions();

  const bySeries = useMemo(() => {
    const map = new Map<string, RecurException[]>();
    for (const row of exceptions) {
      const bucket = map.get(row.seriesId) ?? [];
      bucket.push(row);
      map.set(row.seriesId, bucket);
    }
    return map;
  }, [exceptions]);

  const occurrences = useMemo(() => {
    if (tasks === null) return [];
    const alive = tasks.filter((task) => task.deletedAt === null && task.archivedAt === null);
    return expandTasks(
      alive.map((task) => toSeries(task, bySeries)),
      from,
      to,
    );
  }, [tasks, bySeries, from, to]);

  return { occurrences, loading: tasks === null };
}

/** 供列表视图/详情页使用：某个任务的实例列表 */
export async function occurrencesOfSeries(taskId: string, from: number, to: number): Promise<Occurrence[]> {
  const task = await db.tasks.get(taskId);
  if (!task || task.deletedAt !== null) return [];
  const exceptions = await db.exceptions.where('seriesId').equals(taskId).toArray();
  return expandTasks([toSeries(task, new Map([[taskId, exceptions.filter((row) => row.deletedAt === null)]]))], from, to);
}
