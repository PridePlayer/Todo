import type { Tag, Task } from '@grid/core';
import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
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
