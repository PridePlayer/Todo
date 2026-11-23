import {
  QUADRANT_META,
  compareTasks,
  isOverdue,
  type Quadrant,
  type Task,
  type TaskPatch,
} from '@grid/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { QuickAdd } from '../components/QuickAdd';
import { TaskRow } from '../components/TaskRow';
import { Toast } from '../components/Toast';
import { VirtualList } from '../components/VirtualList';
import { repo } from '../db/repo';
import { useHotkeys } from '../hooks/useHotkeys';
import { useTags, useTasks } from '../hooks/useStore';
import { useUndo } from '../hooks/useUndo';
import styles from './AllTasks.module.css';

const ROW_H = 48;

type StatusFilter = 'open' | 'done' | 'all';
type SortMode = 'manual' | 'created' | 'priority';

interface Row {
  task: Task;
  indent: number;
  childCount: number;
  collapsed: boolean;
}

const STATUS_LABEL: Record<StatusFilter, string> = { open: '未完成', done: '已完成', all: '全部' };
const SORT_LABEL: Record<SortMode, string> = {
  manual: '手动排序',
  created: '创建时间',
  priority: '优先级',
};

export function AllTasksView() {
  const tasks = useTasks();
  const tagMap = useTags();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [sort, setSort] = useState<SortMode>('manual');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 新建不再要求先选象限：默认落 04（不重要不紧急），也就是收件箱的位置。
  // "收集"这一步一旦要求做分类决策，绝大多数人会在这一步放弃记录。
  const quickTarget: Quadrant = 4;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const quickRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { entry, push, undo } = useUndo();

  const alive = useMemo(() => (tasks ?? []).filter((task) => task.deletedAt === null), [tasks]);

  const byParent = useMemo(() => {
    const map = new Map<string | null, Task[]>();
    for (const task of alive) {
      const bucket = map.get(task.parentId) ?? [];
      bucket.push(task);
      map.set(task.parentId, bucket);
    }
    for (const bucket of map.values()) bucket.sort(compareTasks);
    return map;
  }, [alive]);

  const stats = useMemo(() => {
    const open = alive.filter((task) => task.completedAt === null);
    return {
      total: alive.length,
      open: open.length,
      overdue: open.filter((task) => isOverdue(task)).length,
    };
  }, [alive]);

  const sorter = useCallback(
    (a: Task, b: Task) => {
      if (sort === 'created') return b.createdAt - a.createdAt;
      if (sort === 'priority') {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return compareTasks(a, b);
      }
      return compareTasks(a, b);
    },
    [sort],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const statusOk = (task: Task) =>
      status === 'all' ||
      (status === 'open' ? task.completedAt === null : task.completedAt !== null);
    const tagOk = (task: Task) => tagFilter === null || task.tagIds.includes(tagFilter);
    const textOk = (task: Task) =>
      needle === '' ||
      task.title.toLowerCase().includes(needle) ||
      (task.note ?? '').toLowerCase().includes(needle);

    if (needle !== '') {
      // 搜索时拍平：层级会让结果更难扫，这里优先"找到"
      return alive
        .filter((task) => statusOk(task) && tagOk(task) && textOk(task))
        .sort(sorter)
        .map((task) => ({ task, indent: 0, childCount: 0, collapsed: false }));
    }

    const out: Row[] = [];
    const walk = (task: Task, indent: number) => {
      const kids = (byParent.get(task.id) ?? []).filter((t) => statusOk(t) && tagOk(t));
      out.push({ task, indent, childCount: kids.length, collapsed: collapsed.has(task.id) });
      if (kids.length > 0 && !collapsed.has(task.id)) {
        for (const kid of [...kids].sort(sorter)) walk(kid, indent + 1);
      }
    };
    for (const root of [...(byParent.get(null) ?? [])].filter((t) => statusOk(t) && tagOk(t)).sort(sorter)) {
      walk(root, 0);
    }
    return out;
  }, [alive, byParent, collapsed, query, sort, sorter, status, tagFilter]);

  const drawerTask = useMemo(
    () => alive.find((task) => task.id === drawerId) ?? null,
    [alive, drawerId],
  );

  const drawerChildren = useMemo(
    () => (drawerTask ? (byParent.get(drawerTask.id) ?? []) : []),
    [byParent, drawerTask],
  );

  const remove = useCallback(
    async (task: Task) => {
      const ids = await repo.softDelete(task.id);
      if (drawerId !== null && ids.includes(drawerId)) setDrawerId(null);
      if (selectedId !== null && ids.includes(selectedId)) setSelectedId(null);
      await push(`已删除「${task.title}」`, {
        undo: () => repo.restore(ids),
        commit: () => repo.purge(ids),
      });
    },
    [drawerId, push, selectedId],
  );

  useHotkeys({
    n: () => quickRef.current?.focus(),
    '/': () => searchRef.current?.focus(),
    escape: () => setDrawerId(null),
  });

  if (tasks === null) {
    return <div className={styles.loading}>正在读取本地数据…</div>;
  }

  return (
    <div className={styles.view}>
      <header className={styles.head}>
        <div>
          <p className="eyebrow">全部待办</p>
          <h1 className={styles.title}>
            {stats.open} 条未完成
            {stats.overdue > 0 ? (
              <span className={styles.overdue}> · {stats.overdue} 条已逾期</span>
            ) : null}
          </h1>
        </div>
        <div className={styles.filters}>
          <input
            ref={searchRef}
            className={styles.search}
            value={query}
            placeholder="搜索标题和备注（/ 聚焦）"
            aria-label="搜索待办"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('');
                event.currentTarget.blur();
              }
            }}
          />
          <div className={styles.segments} role="group" aria-label="状态筛选">
            {(['open', 'done', 'all'] as StatusFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                className={styles.segment}
                data-on={status === value}
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
              >
                {STATUS_LABEL[value]}
              </button>
            ))}
          </div>
          <select
            className={styles.select}
            value={sort}
            aria-label="排序方式"
            onChange={(event) => setSort(event.target.value as SortMode)}
          >
            {(['manual', 'created', 'priority'] as SortMode[]).map((value) => (
              <option key={value} value={value}>
                {SORT_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      </header>

      {tagMap.size > 0 ? (
        <div className={styles.tagBar} role="group" aria-label="按标签筛选">
          <button
            type="button"
            className={styles.tagChip}
            data-on={tagFilter === null}
            aria-pressed={tagFilter === null}
            onClick={() => setTagFilter(null)}
          >
            全部标签
          </button>
          {[...tagMap.values()].map((tag) => (
            <button
              key={tag.id}
              type="button"
              className={styles.tagChip}
              data-on={tagFilter === tag.id}
              aria-pressed={tagFilter === tag.id}
              onClick={() => setTagFilter(tagFilter === tag.id ? null : tag.id)}
            >
              #{tag.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.quickSlot}>
        <QuickAdd
          target={quickTarget}
          onTargetChange={() => undefined}
          onCreate={async (title) => {
            await repo.create({ title, quadrant: quickTarget });
          }}
          inputRef={quickRef}
          showQuadrantPicker={false}
          placeholder="新增一条待办，回车保存（先收进 04，稍后再分类）"
        />
      </div>

      <div className={styles.list}>
        <VirtualList
          items={rows}
          rowHeight={ROW_H}
          getKey={(row) => row.task.id}
          label="全部待办"
          renderRow={(row) => (
            <TaskRow
              task={row.task}
              tagMap={tagMap}
              selected={selectedId === row.task.id}
              indent={row.indent}
              childCount={row.childCount}
              collapsed={row.collapsed}
              draggable={false}
              badge={<span className={styles.quad}>{QUADRANT_META[row.task.quadrant].no}</span>}
              onToggle={() => void repo.toggleComplete(row.task.id)}
              onOpen={() => {
                setSelectedId(row.task.id);
                setDrawerId(row.task.id);
              }}
              onDelete={() => void remove(row.task)}
              onToggleCollapse={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.task.id)) next.delete(row.task.id);
                  else next.add(row.task.id);
                  return next;
                })
              }
            />
          )}
          empty={
            <EmptyState
              title={query !== '' ? '没搜到' : status === 'done' ? '还没有完成的任务' : '清空了'}
              hint={
                query !== ''
                  ? '换个关键词，或清空搜索看全部'
                  : '按 N 写一条。一条都没有的时候，先写"给这件事定个日期"。'
              }
            />
          }
        />
      </div>

      <div className={styles.drawerSlot}>
        {drawerTask ? (
          <Drawer
            task={drawerTask}
            children={drawerChildren}
            tagMap={tagMap}
            onClose={() => setDrawerId(null)}
            onPatch={(patch: TaskPatch) => repo.patch(drawerTask.id, patch).then(() => undefined)}
            onDelete={() => void remove(drawerTask)}
            onToggle={(id) => void repo.toggleComplete(id)}
            onCreateChild={(title, parentId) =>
              repo.create({ title, parentId }).then(() => undefined)
            }
            onAddTag={async (name) => {
              const tag = await repo.ensureTag(name);
              if (!drawerTask.tagIds.includes(tag.id)) {
                await repo.patch(drawerTask.id, { tagIds: [...drawerTask.tagIds, tag.id] });
              }
            }}
            onRemoveTag={(tagId) =>
              repo
                .patch(drawerTask.id, { tagIds: drawerTask.tagIds.filter((id) => id !== tagId) })
                .then(() => undefined)
            }
            onOpenTask={(id) => {
              setSelectedId(id);
              setDrawerId(id);
            }}
          />
        ) : null}
      </div>

      {entry ? <Toast entry={entry} onUndo={() => void undo()} /> : null}
    </div>
  );
}
