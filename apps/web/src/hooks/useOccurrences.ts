import { liveQuery } from 'dexie';
import { useEffect, useMemo, useState } from 'react';
import {
  expandTasks,
  type CalEvent,
  type CalendarSource,
  type Occurrence,
  type RecurException,
  type SeriesLike,
  type Task,
} from '@grid/core';
import { db } from '../db/dexie';
import { repo } from '../db/repo';
import { useEvents, useSources, useTasks } from '../hooks/useStore';

/**
 * 把窗口内的任务与 Outlook 事件展开成实例。
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
    kind: 'task',
    origin: null,
  };
}

/**
 * Outlook 事件 → 实例序列。
 *
 * 只读判定放在这里而不是渲染时：拖动逻辑在 EventBlock 里，
 * 如果它拿到的是"可拖"的实例，再在 onMove 里返回，用户会看到块跟着手指动一下又弹回去。
 */
function toEventSeries(event: CalEvent, source: CalendarSource | undefined): SeriesLike {
  const canEdit = source?.canEdit ?? false;
  return {
    id: event.id,
    title: event.subject,
    startAt: event.startAt,
    endAt: event.endAt,
    allDay: event.allDay,
    // 重复事件带着规则一起下发展开；只读不影响"能不能展开"
    rrule: event.isRecurring ? event.rrule : null,
    exceptions: [],
    kind: 'event',
    origin: {
      sourceId: event.sourceId,
      webLink: event.webLink,
      readOnly: event.isRecurring || !canEdit,
      colorKey: source?.colorKey ?? 0,
    },
  };
}

export function useOccurrences(from: number, to: number): { occurrences: Occurrence[]; loading: boolean } {
  const tasks = useTasks();
  const events = useEvents();
  const sources = useSources();
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
    if (tasks === null || events === null) return [];
    const series: SeriesLike[] = [];
    for (const task of tasks) {
      if (task.deletedAt !== null || task.archivedAt !== null) continue;
      series.push(toSeries(task, bySeries));
    }

    // 自己刚写进 Outlook 的日程会被同步拉回来，不排除就会和本地待办重复显示。
    // 判据：标题相同 + 开始时间相差不到 1 分钟（只影响显示，误判概率极低）
    const ownedRows = tasks.filter((task) => task.startAt !== null && task.deletedAt === null);
    const owns = (subject: string, startAt: number): boolean =>
      ownedRows.some((task) => task.title.trim() === subject.trim() && Math.abs(task.startAt! - startAt) < 60_000);

    const sourceMap = new Map(sources.map((row) => [row.id, row]));
    for (const event of events) {
      if (event.deletedAt !== null) continue;
      if (owns(event.subject, event.startAt)) continue;
      const source = sourceMap.get(event.sourceId);
      // 源被关掉或删掉的事件一律不显示：这是"关掉节假日日历"真正生效的地方
      if (!source || !source.isVisible || !source.isSynced || source.deletedAt !== null) continue;
      series.push(toEventSeries(event, source));
    }

    return expandTasks(series, from, to);
  }, [tasks, events, sources, bySeries, from, to]);

  return { occurrences, loading: tasks === null || events === null };
}

/** 供列表视图/详情页使用：某个任务的实例列表 */
export async function occurrencesOfSeries(taskId: string, from: number, to: number): Promise<Occurrence[]> {
  const task = await db.tasks.get(taskId);
  if (!task || task.deletedAt !== null) return [];
  const exceptions = await db.exceptions.where('seriesId').equals(taskId).toArray();
  return expandTasks([toSeries(task, new Map([[taskId, exceptions.filter((row) => row.deletedAt === null)]]))], from, to);
}
