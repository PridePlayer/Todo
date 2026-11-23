import type { Occurrence } from '@grid/core';
import { addDays, dayStart, formatClock, isAllDayLike } from './geometry';
import styles from './calendar.module.css';

/**
 * 列表视图：把未来一段时间的实例按天摊开。
 *
 * 存在的理由不是"多一个视图显得功能全"，而是**删除某一次**需要一个明确的落点：
 * 月视图的格子里点开的是系列，周视图里拖拽会触发范围选择，
 * 只有这里是"一行=一次"，点 × 就是"这一次不要了"。
 */

interface AgendaViewProps {
  from: number;
  to: number;
  occurrences: readonly Occurrence[];
  onOpen: (occurrence: Occurrence) => void;
  onSkip: (occurrence: Occurrence) => void;
}

export function AgendaView({ from, to, occurrences, onOpen, onSkip }: AgendaViewProps) {
  const groups: { day: number; list: Occurrence[] }[] = [];
  const index = new Map<number, Occurrence[]>();

  for (const occurrence of occurrences) {
    const day = dayStart(occurrence.start);
    const bucket = index.get(day) ?? [];
    bucket.push(occurrence);
    index.set(day, bucket);
  }
  for (let day = dayStart(from); day < to; day = addDays(day, 1)) {
    const list = index.get(day);
    if (list && list.length > 0) groups.push({ day, list: list.sort((a, b) => a.start - b.start) });
  }

  if (groups.length === 0) {
    return (
      <div className={styles.agenda}>
        <p className={styles.empty}>这段时间没有安排。上面输入框直接写一条，选个重复。</p>
      </div>
    );
  }

  return (
    <div className={styles.agenda}>
      {groups.map((group) => (
        <div key={group.day} className={styles.aGroup}>
          <div className={styles.aDate}>
            {new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(
              new Date(group.day),
            )}
          </div>
          <div className={styles.aRows}>
            {group.list.map((occurrence) => {
              const recurring = occurrence.originalStart !== occurrence.start || occurrence.exceptionId !== null;
              const isEvent = occurrence.kind === 'event';
              const readOnly = occurrence.origin?.readOnly === true;
              return (
                <div
                  key={`${occurrence.seriesId}-${occurrence.originalStart}`}
                  className={styles.aRow}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(occurrence)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onOpen(occurrence);
                  }}
                >
                  <span className={styles.aTime}>
                    {isAllDayLike(occurrence)
                      ? '全天'
                      : `${formatClock(occurrence.start)}–${formatClock(occurrence.end)}`}
                  </span>
                  <span className={styles.aTitle}>{occurrence.title}</span>
                  {recurring ? <span className={styles.aTag}>已改</span> : null}
                  {isEvent ? (
                    // Outlook 事件的删除只能在 Outlook 里做（P0 不做重复/单次删除的回写）
                    <span className={styles.aTag} title="来自 Outlook">
                      Outlook{readOnly ? ' · 只读' : ''}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={styles.aDel}
                      aria-label={`删除「${occurrence.title}」这一次`}
                      title="只删这一次"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSkip(occurrence);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
