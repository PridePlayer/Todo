import type { Occurrence } from '@grid/core';
import { addDays, dayStart, isAllDayLike, monthStart } from './geometry';
import styles from './calendar.module.css';

/**
 * 月视图。
 *
 * 每格最多显示 3 条 + "还有 N 条"：把一整个月塞进一屏，格子里能读的字有上限，
 * 多出来的挤成 2px 的行既看不清也不能点，不如直接给个数字。
 */

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

interface MonthViewProps {
  gridStart: number;
  monthAnchor: number;
  occurrences: readonly Occurrence[];
  onOpen: (occurrence: Occurrence) => void;
  onPickDay: (day: number) => void;
}

export function MonthView({ gridStart, monthAnchor, occurrences, onOpen, onPickDay }: MonthViewProps) {
  const month = new Date(monthStart(monthAnchor)).getMonth();
  const today = dayStart(Date.now());

  const byDay = new Map<number, Occurrence[]>();
  for (const occurrence of occurrences) {
    // 跨天事件在它覆盖到的每一天都出现一次，否则"连开三天的会"只在第一天可见
    let cursor = dayStart(occurrence.start);
    const last = dayStart(Math.max(occurrence.start, occurrence.end - 1));
    for (let guard = 0; cursor <= last && guard < 60; guard += 1) {
      const bucket = byDay.get(cursor) ?? [];
      bucket.push(occurrence);
      byDay.set(cursor, bucket);
      cursor = addDays(cursor, 1);
    }
  }

  return (
    <div className={styles.monthWrap}>
      <div className={styles.weekHead}>
        {WEEK_LABELS.map((label) => (
          <div key={label} className={styles.weekHeadCell}>
            {label}
          </div>
        ))}
      </div>
      <div className={styles.monthBody}>
        {Array.from({ length: 42 }, (_, index) => addDays(gridStart, index)).map((day) => {
          const list = (byDay.get(day) ?? []).slice().sort((a, b) => a.start - b.start);
          const outside = new Date(day).getMonth() !== month;
          return (
            <div
              key={day}
              className={styles.mCell}
              data-out={outside}
              data-today={day === today}
              onClick={() => onPickDay(day)}
              role="presentation"
            >
              <span className={styles.mDate}>{new Date(day).getDate()}</span>
              {list.slice(0, 3).map((occurrence) => (
                <button
                  key={`${occurrence.seriesId}-${occurrence.originalStart}-${day}`}
                  type="button"
                  className={styles.bar}
                  title={occurrence.title}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(occurrence);
                  }}
                >
                  {isAllDayLike(occurrence) ? '' : `${new Date(occurrence.start).getHours()}:${String(new Date(occurrence.start).getMinutes()).padStart(2, '0')} `}
                  {occurrence.title}
                </button>
              ))}
              {list.length > 3 ? <span className={styles.more}>还有 {list.length - 3} 条</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
