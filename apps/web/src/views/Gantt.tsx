import { isOverdue, type Task, type TaskPatch } from '@grid/core';
import { useCallback, useMemo, useState } from 'react';
import { Drawer } from '../components/Drawer';
import { repo } from '../db/repo';
import { useLists, useTags, useTasks } from '../hooks/useStore';
import styles from './Gantt.module.css';

/**
 * 甘特只读视图（P1）。
 *
 * 三个刻意的边界：
 * 1. 不做拖拽改期。甘特上的拖拽最容易和"横滚看时间轴"打架，而手机/触控板
 *    上的误操作代价是一次真实的日程变更。改期走详情页。
 * 2. 只有"有日期/时间"的待办才有条形。未排期的单独一组放在最后，
 *    不给它们伪造位置 —— 甘特的价值就在于"看见真实时间分布"。
 * 3. 条形按本地日历日对齐（dayIndexOf），不按 24h 倍数算。跨夏令时的地区
 *    用毫秒差换算会让条形偏移 1 小时，累积到月末就肉眼可见。
 */

type Zoom = 'day' | 'week' | 'month';

const ZOOM_META: Record<Zoom, { label: string; span: number; px: number; back: number }> = {
  day:   { label: '日', span: 21, px: 44, back: 7 },
  week:  { label: '周', span: 12, px: 72, back: 4 },
  month: { label: '月', span: 6, px: 96, back: 2 },
};

const DAY = 86_400_000;

/** 本地日历日 → UTC 日序号。避免 DST 让"一天"变成 23 或 25 小时 */
function dayIndexOf(ts: number): number {
  const d = new Date(ts);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function startOfWeek(ts: number): number {
  return addDays(dayStart(ts), -((new Date(ts).getDay() + 6) % 7));
}

function startOfMonth(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function monthAdd(ts: number, months: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + months, 1).getTime();
}

function rangeOf(task: Task): { start: number; end: number } | null {
  if (task.startAt !== null) return { start: task.startAt, end: task.endAt ?? task.startAt + DAY };
  if (task.dueDate) {
    const ts = new Date(`${task.dueDate}T00:00:00`).getTime();
    return { start: ts, end: ts + DAY };
  }
  return null;
}

interface BarRow {
  task: Task;
  range: { start: number; end: number } | null;
}

export function GanttView() {
  const tasks = useTasks();
  const lists = useLists();
  const tagMap = useTags();
  const [zoom, setZoom] = useState<Zoom>('day');
  const [offset, setOffset] = useState(0);
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const alive = useMemo(() => (tasks ?? []).filter((t) => t.deletedAt === null), [tasks]);

  /** 窗口起点：以今天为基准，偏移 offset 个单位 */
  const winStart = useMemo(() => {
    const meta = ZOOM_META[zoom];
    const today = Date.now();
    const base =
      zoom === 'day'
        ? addDays(dayStart(today), -meta.back)
        : zoom === 'week'
          ? addDays(startOfWeek(today), -meta.back * 7)
          : monthAdd(startOfMonth(today), -meta.back);
    return zoom === 'month' ? monthAdd(base, offset * meta.span) : addDays(base, offset * meta.span * (zoom === 'week' ? 7 : 1));
  }, [zoom, offset]);

  const winDays = zoom === 'day' ? ZOOM_META.day.span : zoom === 'week' ? ZOOM_META.week.span * 7 : 6 * 30;
  const totalW = ZOOM_META[zoom].span * ZOOM_META[zoom].px;

  /** 时间戳 → 像素 x。月档按"月 + 月内天数比例"，否则条形在月之间会跳 */
  const xOf = useCallback(
    (ts: number): number => {
      const px = ZOOM_META[zoom].px;
      const dayDiff = dayIndexOf(ts) - dayIndexOf(winStart);
      if (zoom === 'day') return dayDiff * px;
      if (zoom === 'week') return (dayDiff / 7) * px;
      const d = new Date(ts);
      const w = new Date(winStart);
      const months = (d.getFullYear() - w.getFullYear()) * 12 + (d.getMonth() - w.getMonth());
      const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      return (months + (d.getDate() - 1) / daysInMonth) * px;
    },
    [zoom, winStart],
  );

  /** 按清单分组，未排期单独一组放最后 */
  const groups = useMemo(() => {
    const byList = new Map<string, BarRow[]>();
    const unscheduled: BarRow[] = [];
    for (const task of alive) {
      const range = rangeOf(task);
      if (range === null) {
        unscheduled.push({ task, range });
        continue;
      }
      const bucket = byList.get(task.listId) ?? [];
      bucket.push({ task, range });
      byList.set(task.listId, bucket);
    }

    const ordered = (lists ?? []).map((list) => ({
      key: list.id,
      name: list.name,
      rows: (byList.get(list.id) ?? []).sort((a, b) => a.range!.start - b.range!.start),
    }));
    if (unscheduled.length > 0) {
      ordered.push({ key: '__none__', name: '未排期', rows: unscheduled });
    }
    return ordered.filter((g) => g.rows.length > 0);
  }, [alive, lists]);

  const ticks = useMemo(() => {
    const meta = ZOOM_META[zoom];
    const out: { label: string; ts: number; today: boolean }[] = [];
    const todayDay = dayIndexOf(Date.now());
    for (let i = 0; i < meta.span; i += 1) {
      const ts =
        zoom === 'day'
          ? addDays(winStart, i)
          : zoom === 'week'
            ? addDays(winStart, i * 7)
            : monthAdd(winStart, i);
      const d = new Date(ts);
      const label =
        zoom === 'month'
          ? `${d.getFullYear()}/${d.getMonth() + 1}`
          : `${d.getMonth() + 1}/${d.getDate()}`;
      out.push({ label, ts, today: dayIndexOf(ts) === todayDay });
    }
    return out;
  }, [zoom, winStart]);

  const drawerTask = useMemo(() => alive.find((t) => t.id === drawerId) ?? null, [alive, drawerId]);
  const drawerChildren = useMemo(() => alive.filter((t) => t.parentId === drawerId), [alive, drawerId]);

  const remove = useCallback(async (task: Task) => {
    await repo.softDelete(task.id);
    setDrawerId((prev) => (prev === task.id ? null : prev));
  }, []);

  return (
    <div className={styles.view}>
      <header className={styles.head}>
        <div>
          <p className="eyebrow">甘特</p>
          <h1 className={styles.title}>时间分布（只读）</h1>
          <p className={styles.sub}>
            条形按本地日历日对齐。改期请点条形进详情，甘特上不支持拖拽。
          </p>
        </div>

        <div className={styles.tools}>
          <div role="group" aria-label="缩放">
            {(['day', 'week', 'month'] as Zoom[]).map((z) => (
              <button
                key={z}
                type="button"
                className={styles.segment}
                data-on={zoom === z}
                aria-pressed={zoom === z}
                onClick={() => {
                  setZoom(z);
                  setOffset(0);
                }}
              >
                {ZOOM_META[z].label}
              </button>
            ))}
          </div>
          <button type="button" className={styles.segment} onClick={() => setOffset((o) => o - 1)} aria-label="上一段">
            ←
          </button>
          <button type="button" className={styles.segment} onClick={() => setOffset(0)} aria-label="回到今天">
            今天
          </button>
          <button type="button" className={styles.segment} onClick={() => setOffset((o) => o + 1)} aria-label="下一段">
            →
          </button>
        </div>
      </header>

      <div className={styles.board}>
        {groups.length === 0 ? (
          <p className={styles.empty}>还没有带日期的待办。在「待办」里建一条，选个日期，它就会出现在这里。</p>
        ) : (
          <div className={styles.inner} style={{ width: totalW + 240 }}>
            <div className={styles.headRow}>
              <div className={styles.headName} style={{ ['--name-w' as string]: '240px' }}>
                任务
              </div>
              <div className={styles.headTicks} style={{ width: totalW }}>
                {ticks.map((tick) => (
                  <div
                    key={tick.ts}
                    className={styles.tick}
                    data-today={tick.today}
                    style={{ width: ZOOM_META[zoom].px }}
                  >
                    {tick.label}
                  </div>
                ))}
              </div>
            </div>

            {/* 今天线：绝对定位贯穿所有行，而不是每行画一条 */}
            <div
              className={styles.today}
              style={{
                left: 240 + Math.max(0, xOf(Date.now())),
                height: '100%',
                display: xOf(Date.now()) >= 0 && xOf(Date.now()) <= totalW ? 'block' : 'none',
              }}
            />

            {groups.map((group) => (
              <section key={group.key}>
                <div className={styles.groupRow}>
                  <span className={styles.groupName}>{group.name}</span>
                  <span className={styles.groupCount}>{group.rows.length} 项</span>
                </div>

                {group.rows.map((row) => {
                  const done = row.task.completedAt !== null;
                  const overdue = isOverdue(row.task);
                  const left = row.range ? Math.max(0, xOf(row.range.start)) : 0;
                  const right = row.range ? Math.min(totalW, xOf(row.range.end)) : 0;
                  const visible = row.range === null || right > 0 || left < totalW;
                  return (
                    <div className={styles.row} key={row.task.id}>
                      <div
                        className={styles.nameCell}
                        style={{ ['--name-w' as string]: '240px' }}
                        onClick={() => setDrawerId(row.task.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') setDrawerId(row.task.id);
                        }}
                      >
                        <span className={styles.nameText}>{row.task.title}</span>
                      </div>

                      <div
                        className={styles.track}
                        style={{ width: totalW, ['--unit' as string]: `${ZOOM_META[zoom].px}px` }}
                      >
                        {row.range === null ? (
                          <span className={styles.unscheduled}>未排期</span>
                        ) : visible ? (
                          <button
                            type="button"
                            className={styles.bar}
                            data-done={done}
                            data-overdue={overdue}
                            style={{ left, width: Math.max(8, right - left) }}
                            onClick={() => setDrawerId(row.task.id)}
                            title={`${row.task.title}`}
                          >
                            {right - left > 48 ? row.task.title : ''}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </div>

      {drawerTask ? (
        <Drawer
          task={drawerTask}
          children={drawerChildren}
          tagMap={tagMap}
          onClose={() => setDrawerId(null)}
          onPatch={async (patch: TaskPatch) => {
            await repo.patch(drawerTask.id, patch);
          }}
          onDelete={() => void remove(drawerTask)}
          onToggle={(id) => void repo.toggleComplete(id)}
          onCreateChild={(title, parentId) => repo.create({ title, parentId }).then(() => undefined)}
          onAddTag={async (name) => {
            const tag = await repo.ensureTag(name);
            if (!drawerTask.tagIds.includes(tag.id)) {
              await repo.patch(drawerTask.id, { tagIds: [...drawerTask.tagIds, tag.id] });
            }
          }}
          onRemoveTag={async (tagId) => {
            await repo.patch(drawerTask.id, {
              tagIds: drawerTask.tagIds.filter((x) => x !== tagId),
            });
          }}
          onOpenTask={(id) => setDrawerId(id)}
        />
      ) : null}
    </div>
  );
}
