import type { Occurrence } from '@grid/core';
import { useEffect, useRef } from 'react';
import { EventBlock } from '../../components/EventBlock';
import {
  HOUR_H,
  addDays,
  dayStart,
  formatClock,
  isAllDayLike,
  layoutDay,
  offsetOf,
  type PlacedBlock,
} from './geometry';
import styles from './calendar.module.css';

/**
 * 日视图与周视图共用的一条时间轴。
 *
 * 一条实现而不是两条：日视图就是"只有一天"的周视图。分开写的话
 * 拖拽吸附、重叠分列、跨天裁切三件事都要维护两遍，而它们最容易出现
 * "日视图对、周视图差半格"这种只在截图里才看得出来的偏差。
 */

const HOURS = Array.from({ length: 24 }, (_, index) => index);

interface TimeGridProps {
  days: readonly number[];
  occurrences: readonly Occurrence[];
  onMove: (occurrence: Occurrence, deltaMs: number) => void;
  onResize: (occurrence: Occurrence, deltaMs: number) => void;
  onOpen: (occurrence: Occurrence) => void;
  onPickDay: (day: number) => void;
}

export function TimeGrid({ days, occurrences, onMove, onResize, onOpen, onPickDay }: TimeGridProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const today = dayStart(Date.now());

  // 首次渲染滚到 07:00：从 00:00 开始看意味着一屏全是空的，用户得先滚
  useEffect(() => {
    if (!scroller.current) return;
    scroller.current.scrollTop = Math.max(0, offsetOf(dayStart(Date.now()) + 7 * 3600_000, dayStart(Date.now())) - 8);
  }, []);

  const allDayPerDay = days.map((day) => {
    const to = addDays(day, 1);
    return occurrences.filter((item) => isAllDayLike(item) && item.start < to && item.end > day);
  });

  return (
    <div className={styles.gridWrap} ref={scroller}>
      <div className={styles.headRow}>
        <div className={styles.hoursSpacer} />
        {days.map((day) => (
          <div
            key={day}
            className={styles.dayColHead}
            data-today={day === today}
            onClick={() => onPickDay(day)}
            role="presentation"
          >
            <span className={styles.dayName}>
              {new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(new Date(day))}
            </span>
            <span className={styles.dayNo}>{new Date(day).getDate()}</span>
          </div>
        ))}
      </div>

      {allDayPerDay.some((list) => list.length > 0) ? (
        <div className={styles.allDayRow}>
          <div className={styles.allDayLabel}>全天</div>
          {allDayPerDay.map((list, index) => (
            <div key={days[index]} className={styles.allDayCell}>
              {list.slice(0, 3).map((item) => (
                <button
                  key={`${item.seriesId}-${item.originalStart}`}
                  type="button"
                  className={styles.allDayChip}
                  onClick={() => onOpen(item)}
                >
                  {item.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      <div className={styles.bodyRow}>
        <div className={styles.hours}>
          <div className={styles.hoursInner} style={{ height: 24 * HOUR_H }}>
            {HOURS.map((hour) => (
              <span key={hour} className={styles.hourLabel} style={{ top: hour * HOUR_H }}>
                {String(hour).padStart(2, '0')}
              </span>
            ))}
          </div>
        </div>

        <div className={styles.dayCols}>
          {days.map((day) => {
            const blocks = layoutDay(
              occurrences.filter((item) => !isAllDayLike(item)),
              day,
            );
            return (
              <div key={day} className={styles.dayCol}>
                <div className={styles.canvas} style={{ height: 24 * HOUR_H }}>
                  {HOURS.map((hour) => (
                    <div key={hour}>
                      <div className={styles.hourLine} style={{ top: hour * HOUR_H }} />
                      {hour < 23 ? (
                        <div className={styles.halfLine} style={{ top: hour * HOUR_H + HOUR_H / 2 }} />
                      ) : null}
                    </div>
                  ))}
                  {day === today && Date.now() >= day && Date.now() < addDays(day, 1) ? (
                    <div className={styles.nowLine} style={{ top: offsetOf(Date.now(), day) }}>
                      <span className={styles.nowDot} />
                    </div>
                  ) : null}
                  {blocks.map((block) => (
                    <Block
                      key={`${block.occurrence.seriesId}-${block.occurrence.originalStart}`}
                      block={block}
                      onMove={onMove}
                      onResize={onResize}
                      onOpen={onOpen}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface BlockProps {
  block: PlacedBlock;
  onMove: (occurrence: Occurrence, deltaMs: number) => void;
  onResize: (occurrence: Occurrence, deltaMs: number) => void;
  onOpen: (occurrence: Occurrence) => void;
}

function Block({ block, onMove, onResize, onOpen }: BlockProps) {
  const short = block.height < 34;
  return (
    <EventBlock
      block={block}
      compact={short}
      onMove={onMove}
      onResize={onResize}
      onOpen={onOpen}
    />
  );
}

/** 供列表与月视图复用：把一天内的事件压成"09:00–10:00 标题" */
export function summarize(occurrence: Occurrence): string {
  if (isAllDayLike(occurrence)) return '全天';
  return `${formatClock(occurrence.start)} – ${formatClock(occurrence.end)}`;
}
