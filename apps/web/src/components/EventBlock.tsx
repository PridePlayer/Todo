import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Occurrence } from '@grid/core';
import { HOUR_H, formatClock, type PlacedBlock } from '../views/calendar/geometry';
import styles from './EventBlock.module.css';

/**
 * 日历里的一个事件块。
 *
 * 拖拽用 Pointer Events 而不是 HTML5 拖放：后者在拖拽过程中**拿不到精确的鼠标位置**
 * （drag 事件的 clientY 在部分浏览器上是 0），无法做 15 分钟级别的吸附。
 * 拖动过程中只改 transform 不改 top，避免每次移动都触发一次布局。
 *
 * `snapMs` 由调用方给：普通拖动 30 分钟、按住 Alt 15 分钟。
 * 那是产品决定，不该藏在组件里。
 */

interface EventBlockProps {
  block: PlacedBlock;
  /** 拖拽结束，参数是相对原位置的时间位移 */
  onMove: (occurrence: Occurrence, deltaMs: number) => void;
  onResize: (occurrence: Occurrence, deltaMs: number) => void;
  onOpen: (occurrence: Occurrence) => void;
  compact?: boolean;
}

export function EventBlock({ block, onMove, onResize, onOpen, compact = false }: EventBlockProps) {
  const [dy, setDy] = useState(0);
  const [mode, setMode] = useState<'idle' | 'move' | 'resize'>('idle');
  const drag = useRef<{ startY: number; pointerId: number } | null>(null);

  const occurrence = block.occurrence;

  function begin(event: ReactPointerEvent<HTMLElement>, next: 'move' | 'resize'): void {
    // 只用主键：右键与中键不该拖动
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, pointerId: event.pointerId };
    setMode(next);
  }

  function move(event: ReactPointerEvent<HTMLElement>): void {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    setDy(event.clientY - drag.current.startY);
  }

  function end(event: ReactPointerEvent<HTMLElement>): void {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const delta = dy;
    const fine = event.altKey;
    drag.current = null;
    setMode('idle');
    setDy(0);

    const msPerPixel = (60 * 60 * 1000) / HOUR_H;
    const rawMs = delta * msPerPixel;
    const size = fine ? 15 * 60 * 1000 : 30 * 60 * 1000;
    const snapped = Math.round(rawMs / size) * size;

    if (mode === 'resize') {
      if (snapped !== 0) onResize(occurrence, snapped);
    } else if (snapped !== 0) {
      onMove(occurrence, snapped);
    }
    // 位移为 0 视作点击，交给 onClick 处理
  }

  const width = 100 / block.columns;
  const style = {
    top: block.top,
    height: block.height,
    left: `calc(${block.column * width}% + 2px)`,
    width: `calc(${width}% - 4px)`,
    transform: dy === 0 ? undefined : `translateY(${dy}px)`,
    zIndex: mode === 'idle' ? undefined : 5,
  };

  return (
    <div
      className={styles.block}
      style={style}
      data-mode={mode}
      data-compact={compact}
      data-recurring={occurrence.exceptionId !== null || occurrence.originalStart !== occurrence.start}
      role="button"
      tabIndex={0}
      title={`${occurrence.title} ${formatClock(occurrence.start)}–${formatClock(occurrence.end)}`}
      onPointerDown={(event) => begin(event, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(occurrence);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(occurrence);
        }
      }}
    >
      <span className={styles.time}>
        {block.clippedTop ? '…' : formatClock(occurrence.start)}
      </span>
      <span className={styles.title}>{occurrence.title}</span>
      <span
        className={styles.resize}
        aria-hidden="true"
        onPointerDown={(event) => begin(event, 'resize')}
        onPointerMove={move}
        onPointerUp={end}
      />
    </div>
  );
}
