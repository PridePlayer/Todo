import {
  MAX_DEPTH,
  QUADRANT_META,
  QUADRANT_ORDER,
  combineDateTime,
  formatTimeRange,
  toDateInput,
  toTimeInput,
  type Quadrant,
  type Tag,
  type Task,
  type TaskPatch,
} from '@grid/core';
import { useEffect, useRef, useState } from 'react';
import { Checkbox } from './Checkbox';
import { TagChip } from './TagChip';
import styles from './Drawer.module.css';

interface DrawerProps {
  task: Task;
  children: Task[];
  tagMap: Map<string, Tag>;
  onClose: () => void;
  onPatch: (patch: TaskPatch) => Promise<void>;
  onDelete: () => void;
  onToggle: (id: string) => void;
  onCreateChild: (title: string, parentId: string) => Promise<void>;
  onAddTag: (name: string) => Promise<void>;
  onRemoveTag: (tagId: string) => Promise<void>;
  onOpenTask: (id: string) => void;
}

const PRIORITY_LABEL: Record<number, string> = { 0: '无', 1: '低', 2: '中', 3: '高' };
const DAY_MS = 86_400_000;

export function Drawer({
  task,
  children,
  tagMap,
  onClose,
  onPatch,
  onDelete,
  onToggle,
  onCreateChild,
  onAddTag,
  onRemoveTag,
  onOpenTask,
}: DrawerProps) {
  const titleRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note ?? '');
  const [tagDraft, setTagDraft] = useState('');
  const [childDraft, setChildDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 切到另一个任务时同步草稿，否则会拿上一条的标题去覆盖这一条
  useEffect(() => {
    setTitle(task.title);
    setNote(task.note ?? '');
    setError(null);
  }, [task.id, task.title, task.note]);

  const dateValue = task.dueDate ?? (task.startAt !== null ? toDateInput(task.startAt) : '');
  const startValue = task.startAt !== null ? toTimeInput(task.startAt) : '';
  const endValue = task.endAt !== null ? toTimeInput(task.endAt) : '';
  const range = formatTimeRange(task.startAt, task.endAt);

  const canNest = task.depth < MAX_DEPTH - 1;

  async function applyTimes(nextDate: string, nextStart: string, nextEnd: string) {
    if (nextDate === '') {
      await onPatch({ dueDate: null, startAt: null, endAt: null });
      return;
    }
    if (nextStart === '') {
      await onPatch({ dueDate: nextDate, startAt: null, endAt: null });
      return;
    }
    const startAt = combineDateTime(nextDate, nextStart);
    let endAt: number | null = null;
    if (nextEnd !== '') {
      endAt = combineDateTime(nextDate, nextEnd);
      // 结束早于开始 = 跨天，这正是「23:00 – 次日 01:00」的建模方式
      if (endAt <= startAt) endAt += DAY_MS;
    }
    await onPatch({ dueDate: null, startAt, endAt });
  }

  async function commitTitle() {
    const clean = title.trim();
    if (clean === '' || clean === task.title) {
      setTitle(task.title);
      return;
    }
    await onPatch({ title: clean });
  }

  return (
    <aside className={styles.drawer} aria-label="任务详情">
      <header className={styles.head}>
        <span className={styles.crumb}>任务 · 第 {task.depth + 1} 层</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="关闭详情">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      </header>

      <div className={styles.body}>
        <input
          ref={titleRef}
          className={styles.titleInput}
          value={title}
          aria-label="任务标题"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />

        <section className={styles.field}>
          <span className={styles.label}>象限</span>
          <div className={styles.quadrants}>
            {QUADRANT_ORDER.map((quadrant) => (
              <button
                key={quadrant}
                type="button"
                className={styles.quadrant}
                data-on={task.quadrant === quadrant}
                aria-pressed={task.quadrant === quadrant}
                onClick={() => void onPatch({ quadrant: quadrant as Quadrant })}
              >
                <span className={styles.quadrantNo}>{QUADRANT_META[quadrant].no}</span>
                <span className={styles.quadrantName}>{QUADRANT_META[quadrant].title}</span>
              </button>
            ))}
          </div>
        </section>

        <section className={styles.field}>
          <span className={styles.label}>时间</span>
          <div className={styles.timeRow}>
            <input
              type="date"
              className={styles.control}
              value={dateValue}
              aria-label="日期"
              onChange={(event) => void applyTimes(event.target.value, startValue, endValue)}
            />
            <input
              type="time"
              className={styles.control}
              value={startValue}
              aria-label="开始时间"
              onChange={(event) => void applyTimes(dateValue, event.target.value, endValue)}
            />
            <span className={styles.dash} aria-hidden="true">
              –
            </span>
            <input
              type="time"
              className={styles.control}
              value={endValue}
              aria-label="结束时间"
              onChange={(event) => void applyTimes(dateValue, startValue, event.target.value)}
            />
          </div>
          <p className={styles.hint}>
            {range ? `显示为 ${range}` : '只填日期就是全天任务；结束早于开始会自动算成次日'}
          </p>
        </section>

        <section className={styles.field}>
          <span className={styles.label}>地点</span>
          <input
            className={styles.control}
            defaultValue={task.location ?? ''}
            placeholder="可留空"
            aria-label="地点"
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== (task.location ?? '')) void onPatch({ location: value || null });
            }}
          />
        </section>

        <section className={styles.field}>
          <span className={styles.label}>优先级</span>
          <div className={styles.segments} role="group" aria-label="优先级">
            {[0, 1, 2, 3].map((level) => (
              <button
                key={level}
                type="button"
                className={styles.segment}
                data-on={task.priority === level}
                aria-pressed={task.priority === level}
                onClick={() => void onPatch({ priority: level })}
              >
                {PRIORITY_LABEL[level]}
              </button>
            ))}
          </div>
        </section>

        <section className={styles.field}>
          <span className={styles.label}>标签</span>
          <div className={styles.tagRow}>
            {task.tagIds.map((id) => {
              const tag = tagMap.get(id);
              if (!tag) return null;
              return (
                <button
                  key={id}
                  type="button"
                  className={styles.tagButton}
                  title={`移除 #${tag.name}`}
                  onClick={() => void onRemoveTag(id)}
                >
                  <TagChip tag={tag} />
                  <span className={styles.tagX} aria-hidden="true">
                    ×
                  </span>
                </button>
              );
            })}
            <input
              className={styles.tagInput}
              value={tagDraft}
              placeholder="+ 标签"
              aria-label="添加标签"
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const name = tagDraft.trim();
                if (name === '') return;
                void onAddTag(name).then(() => setTagDraft(''));
              }}
            />
          </div>
        </section>

        <section className={styles.field}>
          <span className={styles.label}>备注</span>
          <textarea
            className={styles.note}
            value={note}
            rows={4}
            placeholder="背景、链接、要问的人…"
            aria-label="备注"
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => {
              const next = note.trim() === '' ? null : note;
              if (next !== (task.note ?? null)) void onPatch({ note: next });
            }}
          />
        </section>

        <section className={styles.field}>
          <span className={styles.label}>
            子任务 {children.length > 0 ? `（${children.length}）` : ''}
          </span>

          {children.length > 0 ? (
            <ul className={styles.children}>
              {children.map((child) => (
                <li key={child.id} className={styles.child}>
                  <Checkbox
                    checked={child.completedAt !== null}
                    onChange={() => onToggle(child.id)}
                    label={child.title}
                  />
                  <button
                    type="button"
                    className={styles.childTitle}
                    data-done={child.completedAt !== null}
                    onClick={() => onOpenTask(child.id)}
                  >
                    {child.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {canNest ? (
            <input
              className={styles.control}
              value={childDraft}
              placeholder="加一条子任务，回车确认"
              aria-label="添加子任务"
              onChange={(event) => setChildDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const value = childDraft.trim();
                if (value === '') return;
                setError(null);
                void onCreateChild(value, task.id)
                  .then(() => setChildDraft(''))
                  .catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : '添加失败'),
                  );
              }}
            />
          ) : (
            <p className={styles.limit}>已经是第 {MAX_DEPTH} 层，不能再加子任务（最多 {MAX_DEPTH} 层）</p>
          )}

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>

      <footer className={styles.foot}>
        <button
          type="button"
          className={styles.done}
          onClick={() => onToggle(task.id)}
        >
          {task.completedAt !== null ? '标记为未完成' : '标记完成'}
        </button>
        <button type="button" className={styles.remove} onClick={onDelete}>
          删除
        </button>
      </footer>
    </aside>
  );
}
