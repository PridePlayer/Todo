import {
  QUADRANT_META,
  compareTasks,
  expandSeries,
  formatDateLabel,
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
import { useExceptions, useTags, useTasks } from '../hooks/useStore';
import { useUndo } from '../hooks/useUndo';
import styles from './AllTasks.module.css';

const ROW_H = 48;

type StatusFilter = 'open' | 'done' | 'all';
type SortMode = 'manual' | 'created' | 'priority' | 'completed';

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
  completed: '完成时间',
};

export function AllTasksView() {
  const tasks = useTasks();
  const tagMap = useTags();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [sort, setSort] = useState<SortMode>('manual');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 按日期查看：看"今天要做什么"而不是全部待办。null = 不筛日期
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  // 拖拽到标签上给任务打标签。只在 hover 到某个标签时置位，
  // 用来在拖动过程中给目标一个"放这里"的高亮 —— 没有它，
  // 用户不知道鼠标悬停的那个 chips 到底收不收。
  const [dropTag, setDropTag] = useState<string | null>(null);
  // 新建不再要求先选象限：默认落 04（不重要不紧急），也就是收件箱的位置。
  // "收集"这一步一旦要求做分类决策，绝大多数人会在这一步放弃记录。
  const quickTarget: Quadrant = 4;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const quickRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { entry, push, undo } = useUndo();
  const exceptions = useExceptions();

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

  /**
   * 过期但还挂着的重复实例。
   * 列表显示的是母体、不展开实例，所以这些"上周一那次"平时看不见，
   * 只有把实例摊出来才知道该跳过几次。
   */
  const overdueRepeats = useMemo(() => {
    const d0 = new Date();
    d0.setHours(0, 0, 0, 0);
    const todayStart = d0.getTime();
    const keyOf = (ts: number) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const skipped = new Set(
      exceptions.filter((e) => e.kind === 'deleted').map((e) => `${e.seriesId}@${e.originalStart}`),
    );
    const out: { key: string; task: Task; originalStart: number; dateText: string }[] = [];
    for (const task of alive) {
      if (!task.rrule || task.completedAt !== null) continue;
      const anchor = task.startAt ?? (task.dueDate ? new Date(`${task.dueDate}T00:00:00`).getTime() : null);
      if (anchor === null) continue;
      // from 取任务创建以来，不能是 0：从 1970 年展开会被远古实例占满 limit，
      // 最近的过期实例取不到，界面表现为"有的能跳过、有的点不动"
      const from = Math.max(task.createdAt, todayStart - 90 * 86_400_000);
      const occurrences = expandSeries(
        {
          id: task.id,
          title: task.title,
          startAt: anchor,
          endAt: task.endAt,
          allDay: task.allDay,
          rrule: task.rrule,
          exceptions: exceptions.filter((e) => e.seriesId === task.id),
          kind: 'task',
          origin: null,
        },
        from,
        todayStart,
        200,
      );
      for (const occ of occurrences) {
        if (occ.start >= todayStart) continue;
        const key = `${task.id}@${occ.originalStart}`;
        if (skipped.has(key)) continue;
        out.push({ key, task, originalStart: occ.originalStart, dateText: formatDateLabel(keyOf(occ.start)) });
      }
    }
    return out;
  }, [alive, exceptions]);

  const skipAllOverdue = useCallback(async () => {
    // 每个任务只推进一次：目标是 now 之后的下一次，逐条调用会跳过好几周
    const seen = new Set<string>();
    for (const item of overdueRepeats) {
      if (seen.has(item.task.id)) continue;
      seen.add(item.task.id);
      await repo.skipOccurrence(item.task.id, item.originalStart);
    }
  }, [overdueRepeats]);

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
      // 按完成时间倒序：最近完成的在最上面。未完成的排最后（它们没有 completedAt）
      if (sort === 'completed') {
        const av = a.completedAt ?? -1;
        const bv = b.completedAt ?? -1;
        if (av !== bv) return bv - av;
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
    const dateOk = (task: Task) => {
      if (dateFilter === null) return true;
      if (dateFilter === 'overdue') {
        // 过期 = 有截止日、早于今天、还没完成
        const pad = (n: number) => String(n).padStart(2, '0');
        const d = new Date();
        const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        return task.completedAt === null && task.dueDate !== null && task.dueDate < today;
      }
      if (task.dueDate === dateFilter) return true;
      if (task.startAt !== null) {
        const d = new Date(task.startAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return key === dateFilter;
      }
      return false;
    };
    const textOk = (task: Task) =>
      needle === '' ||
      task.title.toLowerCase().includes(needle) ||
      (task.note ?? '').toLowerCase().includes(needle);

    if (needle !== '') {
      // 搜索时拍平：层级会让结果更难扫，这里优先"找到"
      return alive
        .filter((task) => statusOk(task) && tagOk(task) && dateOk(task) && textOk(task))
        .sort(sorter)
        .map((task) => ({ task, indent: 0, childCount: 0, collapsed: false }));
    }

    const out: Row[] = [];
    const walk = (task: Task, indent: number) => {
      const kids = (byParent.get(task.id) ?? []).filter((t) => statusOk(t) && tagOk(t) && dateOk(t));
      out.push({ task, indent, childCount: kids.length, collapsed: collapsed.has(task.id) });
      if (kids.length > 0 && !collapsed.has(task.id)) {
        for (const kid of [...kids].sort(sorter)) walk(kid, indent + 1);
      }
    };
    for (const root of [...(byParent.get(null) ?? [])].filter((t) => statusOk(t) && tagOk(t) && dateOk(t)).sort(sorter)) {
      walk(root, 0);
    }
    return out;
  }, [alive, byParent, collapsed, query, sort, sorter, status, tagFilter, dateFilter]);

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

      <div className={styles.dateBar} role="group" aria-label="按日期查看">
        {(() => {
          const pad = (n: number) => String(n).padStart(2, '0');
          const key = (offset: number) => {
            const d = new Date();
            d.setDate(d.getDate() + offset);
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          };
          const today = key(0);
          return (
            <>
              <button
                type="button"
                className={styles.dateChip}
                data-on={dateFilter === null}
                aria-pressed={dateFilter === null}
                onClick={() => setDateFilter(null)}
              >
                全部日期
              </button>
              <button
                type="button"
                className={styles.dateChip}
                data-on={dateFilter === 'overdue'}
                aria-pressed={dateFilter === 'overdue'}
                onClick={() => setDateFilter(dateFilter === 'overdue' ? null : 'overdue')}
              >
                已过期
              </button>
              <button
                type="button"
                className={styles.dateChip}
                data-on={dateFilter === today}
                aria-pressed={dateFilter === today}
                onClick={() => setDateFilter(dateFilter === today ? null : today)}
              >
                今天
              </button>
              <button
                type="button"
                className={styles.dateChip}
                data-on={dateFilter === key(1)}
                aria-pressed={dateFilter === key(1)}
                onClick={() => setDateFilter(dateFilter === key(1) ? null : key(1))}
              >
                明天
              </button>
              <input
                type="date"
                className={styles.dateInput}
                value={dateFilter ?? ''}
                aria-label="按日期筛选"
                onChange={(event) => setDateFilter(event.target.value || null)}
              />
            </>
          );
        })()}
      </div>

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
              data-drop={dropTag === tag.id}
              aria-pressed={tagFilter === tag.id}
              onClick={() => setTagFilter(tagFilter === tag.id ? null : tag.id)}
              onDragOver={(event) => {
                // 必须 preventDefault，否则 drop 事件根本不会触发
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropTag(tag.id);
              }}
              onDragLeave={() => setDropTag((prev) => (prev === tag.id ? null : prev))}
              onDrop={(event) => {
                event.preventDefault();
                setDropTag(null);
                const taskId = event.dataTransfer.getData('text/plain');
                const task = alive.find((t) => t.id === taskId);
                if (!task || task.tagIds.includes(tag.id)) return;
                void repo.patch(task.id, { tagIds: [...task.tagIds, tag.id] });
              }}
            >
              #{tag.name}
            </button>
          ))}
        </div>
      ) : null}

      {overdueRepeats.length > 0 ? (
        <div className={styles.overdueBar}>
          <span>
            {overdueRepeats.length} 个过期的重复实例，最久 {overdueRepeats[0]?.dateText}
          </span>
          <button type="button" className={styles.overdueBtn} onClick={() => void skipAllOverdue()}>
            全部跳过
          </button>
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
              draggable
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
