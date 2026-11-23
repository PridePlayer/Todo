import { describeRrule, isOverdue, taskMetaText, type Tag, type Task } from '@grid/core';
import { useState } from 'react';
import { Checkbox } from './Checkbox';
import { TagChip } from './TagChip';
import styles from './task.module.css';

interface TaskRowProps {
  task: Task;
  tagMap: Map<string, Tag>;
  selected: boolean;
  /** 缩进层级（= task.depth），0 为顶层 */
  indent: number;
  childCount: number;
  collapsed: boolean;
  draggable: boolean;
  /** 全部待办视图里显示象限编号，四象限视图里不传 */
  badge?: React.ReactNode;
  onToggle: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onToggleCollapse: () => void;
}

export function TaskRow({
  task,
  tagMap,
  selected,
  indent,
  childCount,
  collapsed,
  draggable,
  badge,
  onToggle,
  onOpen,
  onDelete,
  onToggleCollapse,
}: TaskRowProps) {
  const [dragging, setDragging] = useState(false);
  const meta = taskMetaText(task);
  const overdue = isOverdue(task);
  const tags = task.tagIds.map((id) => tagMap.get(id)).filter((tag): tag is Tag => Boolean(tag));

  return (
    <div
      className={styles.row}
      data-selected={selected}
      data-done={task.completedAt !== null}
      data-dragging={dragging}
      style={{ paddingLeft: 8 + indent * 16 }}
      tabIndex={0}
      role="button"
      aria-label={`${task.title}${meta ? `，${meta}` : ''}`}
      draggable={draggable}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onOpen();
        } else if (event.key === ' ') {
          event.preventDefault();
          onToggle();
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          onDelete();
        } else if (event.key === 'ArrowRight' && childCount > 0 && collapsed) {
          event.preventDefault();
          onToggleCollapse();
        } else if (event.key === 'ArrowLeft' && childCount > 0 && !collapsed) {
          event.preventDefault();
          onToggleCollapse();
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', task.id);
        event.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
    >
      {childCount > 0 ? (
        <button
          type="button"
          className={styles.caret}
          data-collapsed={collapsed}
          aria-label={collapsed ? '展开子任务' : '收起子任务'}
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapse();
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
      ) : (
        <span className={styles.caretSpace} aria-hidden="true" />
      )}

      <Checkbox checked={task.completedAt !== null} onChange={onToggle} label={task.title} />

      {task.priority >= 2 ? (
        <span className={styles.priority} aria-label={`优先级 ${task.priority}`}>
          {'!'.repeat(task.priority - 1)}
        </span>
      ) : null}

      <span className={styles.title}>{task.title}</span>

      {badge}

      {tags.slice(0, 2).map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}

      {(() => {
        const repeat = describeRrule(task.rrule);
        return repeat ? (
          <span className={styles.repeat} title={`重复：${repeat}`}>
            ↻ {repeat}
          </span>
        ) : null;
      })()}

      {childCount > 0 ? <span className={styles.count}>{childCount}</span> : null}

      {meta ? (
        <span className={styles.meta} data-overdue={overdue}>
          {meta}
        </span>
      ) : null}

      <button
        type="button"
        className={styles.del}
        aria-label={`删除「${task.title}」`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
