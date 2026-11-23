import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './VirtualList.module.css';

interface VirtualListProps<T> {
  items: readonly T[];
  rowHeight: number;
  getKey: (item: T) => string;
  renderRow: (item: T, index: number) => ReactNode;
  overscan?: number;
  empty?: ReactNode;
  label?: string;
}

/**
 * 定高虚拟列表。
 *
 * 为什么要自己写：M1 的出口条件是「3000 条任务下拖拽不掉帧」，
 * 3000 行 × 4 列表就是 3000 个 flex 容器 + 3000 个 checkbox，
 * 光首次挂载就要 200ms+，滚动时还会持续触发样式重算。
 *
 * 定高的前提是行高固定 48px（--row-h）。**行内不许换行、不许折叠展开成两行**，
 * 一旦有人给某行加了第二行文本，虚拟滚动就会错位——这是这种实现唯一的硬约束。
 */
export function VirtualList<T>({
  items,
  rowHeight,
  getKey,
  renderRow,
  overscan = 8,
  empty,
  label,
}: VirtualListProps<T>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const frame = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (frame.current !== 0) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setScrollTop(viewportRef.current?.scrollTop ?? 0);
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const total = items.length * rowHeight;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const count = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(items.length, start + count);
  const slice = items.slice(start, end);

  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      onScroll={handleScroll}
      role="list"
      aria-label={label}
    >
      {items.length === 0 ? (
        empty ?? null
      ) : (
        <div className={styles.canvas} style={{ height: total }}>
          {slice.map((item, offset) => {
            const index = start + offset;
            return (
              <div
                key={getKey(item)}
                className={styles.slot}
                style={{ transform: `translateY(${index * rowHeight}px)`, height: rowHeight }}
                role="listitem"
                aria-posinset={index + 1}
                aria-setsize={items.length}
              >
                {renderRow(item, index)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
