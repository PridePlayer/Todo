import {
  QUADRANT_META,
  QUADRANT_ORDER,
  compareTasks,
  shiftQuadrant,
  type Quadrant,
  type Task,
  type TaskPatch,
} from '@grid/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import styles from './Quadrant.module.css';

const ROW_H = 48;

interface Row {
  task: Task;
  indent: number;
  childCount: number;
  collapsed: boolean;
}

export function QuadrantView() {
  const tasks = useTasks();
  const tagMap = useTags();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showDone, setShowDone] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [quickTarget, setQuickTarget] = useState<Quadrant>(1);
  const [dragOver, setDragOver] = useState<Quadrant | null>(null);
  const quickRef = useRef<HTMLInputElement | null>(null);
  const { entry, push, undo } = useUndo();

  // 上次会话里被软删、但撤销窗口没走完的行，启动时补刀
  useEffect(() => {
    void repo.purgeExpired(10_000);
  }, []);

  const index = useMemo(() => {
    const alive = (tasks ?? []).filter((task) => task.deletedAt === null);
    const byParent = new Map<string | null, Task[]>();
    for (const task of alive) {
      const bucket = byParent.get(task.parentId) ?? [];
      bucket.push(task);
      byParent.set(task.parentId, bucket);
    }
    for (const bucket of byParent.values()) bucket.sort(compareTasks);

    const roots = new Map<Quadrant, Task[]>();
    const doneCount = new Map<Quadrant, number>();
    for (const quadrant of QUADRANT_ORDER) {
      roots.set(quadrant, []);
      doneCount.set(quadrant, 0);
    }
    for (const task of byParent.get(null) ?? []) {
      const bucket = roots.get(task.quadrant)!;
      if (task.completedAt !== null) {
        doneCount.set(task.quadrant, (doneCount.get(task.quadrant) ?? 0) + 1);
        if (!showDone) continue;
      }
      bucket.push(task);
    }
    // 未完成永远排在已完成之上
    for (const bucket of roots.values()) {
      bucket.sort(
        (a, b) =>
          Number(a.completedAt !== null) - Number(b.completedAt !== null) || compareTasks(a, b),
      );
    }
    return { byParent, roots, doneCount };
  }, [tasks, showDone]);

  const rowsByQuadrant = useMemo(() => {
    const result = new Map<Quadrant, Row[]>();
    for (const quadrant of QUADRANT_ORDER) {
      const rows: Row[] = [];
      const walk = (task: Task, indent: number) => {
        const kids = (index.byParent.get(task.id) ?? []).filter(
          (child) => showDone || child.completedAt === null,
        );
        rows.push({ task, indent, childCount: kids.length, collapsed: collapsed.has(task.id) });
        if (kids.length > 0 && !collapsed.has(task.id)) {
          for (const kid of kids) walk(kid, indent + 1);
        }
      };
      for (const root of index.roots.get(quadrant) ?? []) walk(root, 0);
      result.set(quadrant, rows);
    }
    return result;
  }, [index, collapsed, showDone]);

  const drawerTask = useMemo(
    () => (tasks ?? []).find((task) => task.id === drawerId && task.deletedAt === null) ?? null,
    [tasks, drawerId],
  );

  const drawerChildren = useMemo(() => {
    if (!drawerTask) return [];
    return (index.byParent.get(drawerTask.id) ?? []).filter((task) => task.deletedAt === null);
  }, [index, drawerTask]);

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
    [drawerId, selectedId, push],
  );

  const migrate = useCallback(
    async (task: Task, direction: -1 | 1) => {
      // 子任务的象限跟着父任务走，不允许单独迁移，否则一列里会出现别列的任务
      if (task.parentId !== null) return;
      const next = shiftQuadrant(task.quadrant, direction);
      if (next === task.quadrant) return;
      await repo.patch(task.id, { quadrant: next, sortOrder: await repo.maxSortOrder(next) });
    },
    [],
  );

  const migrateSelected = useCallback(
    (direction: -1 | 1) => {
      const task = (tasks ?? []).find((row) => row.id === selectedId && row.deletedAt === null);
      if (task) void migrate(task, direction);
    },
    [tasks, selectedId, migrate],
  );

  useHotkeys({
    n: () => quickRef.current?.focus(),
    escape: () => setDrawerId(null),
    'alt+arrowup': () => migrateSelected(-1),
    'alt+arrowdown': () => migrateSelected(1),
  });

  async function dropInto(taskId: string, quadrant: Quadrant) {
    const task = (tasks ?? []).find((row) => row.id === taskId);
    if (!task || task.deletedAt !== null) return;
    if (task.parentId !== null) return;
    if (task.quadrant === quadrant) return;
    await repo.patch(task.id, { quadrant, sortOrder: await repo.maxSortOrder(quadrant) });
  }

  if (tasks === null) {
    return <div className={styles.loading}>正在读取本地数据…</div>;
  }

  return (
    <div className={styles.view}>
      <header className={styles.head}>
        <div>
          <p className="eyebrow">四象限</p>
          <h1 className={styles.title}>按重要性排，不按到来顺序排</h1>
        </div>
        <div className={styles.tools}>
          <button
            type="button"
            className={styles.toggle}
            data-on={showDone}
            aria-pressed={showDone}
            onClick={() => setShowDone((value) => !value)}
          >
            显示已完成
          </button>
          <span className={styles.kbdHint}>
            <kbd>N</kbd> 新增 · <kbd>Alt</kbd>+<kbd>↑</kbd> 迁移 · 拖拽换格
          </span>
        </div>
      </header>

      <div className={styles.quickSlot}>
        <QuickAdd
          target={quickTarget}
          onTargetChange={setQuickTarget}
          onCreate={async (title) => {
            await repo.create({ title, quadrant: quickTarget });
          }}
          inputRef={quickRef}
        />
      </div>

      <div className={styles.grid}>
        {QUADRANT_ORDER.map((quadrant) => {
          const meta = QUADRANT_META[quadrant];
          const rows = rowsByQuadrant.get(quadrant) ?? [];
          const done = index.doneCount.get(quadrant) ?? 0;
          return (
            <section
              key={quadrant}
              className={styles.col}
              data-over={dragOver === quadrant}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (dragOver !== quadrant) setDragOver(quadrant);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                setDragOver(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(null);
                const id = event.dataTransfer.getData('text/plain');
                if (id) void dropInto(id, quadrant);
              }}
            >
              <header className={styles.colHead}>
                <span className={styles.colNo}>{meta.no}</span>
                <h2 className={styles.colTitle}>{meta.title}</h2>
                <span className={styles.colCount}>{index.roots.get(quadrant)?.length ?? 0}</span>
                <button
                  type="button"
                  className={styles.colAdd}
                  aria-label={`在「${meta.title}」新增`}
                  onClick={() => {
                    setQuickTarget(quadrant);
                    quickRef.current?.focus();
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                </button>
              </header>

              <div className={styles.colBody}>
                <VirtualList
                  items={rows}
                  rowHeight={ROW_H}
                  getKey={(row) => row.task.id}
                  label={meta.title}
                  renderRow={(row) => (
                    <TaskRow
                      task={row.task}
                      tagMap={tagMap}
                      selected={selectedId === row.task.id}
                      indent={row.indent}
                      childCount={row.childCount}
                      collapsed={row.collapsed}
                      draggable={row.task.parentId === null}
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
                      title="这一格是空的"
                      hint={
                        quadrant === 2
                          ? '重要不紧急最长寿。空着说明你一直在救火。'
                          : '按 N 直接写一条，或用 + 号把别的任务拖进来。'
                      }
                    />
                  }
                />
              </div>

              <footer className={styles.colFoot}>
                <span>{meta.hint}</span>
                {done > 0 ? <span className={styles.doneCount}>{done} 已完成</span> : null}
              </footer>

              {dragOver === quadrant ? <div className={styles.dropMask}>放到这里</div> : null}
            </section>
          );
        })}
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
