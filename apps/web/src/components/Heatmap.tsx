import type { HeatCell } from '@grid/core';
import type { CSSProperties } from 'react';
import styles from './Heatmap.module.css';

/**
 * 12 周热力图。
 *
 * 三个视觉约定，都是为了让"这张图能被正确读"而不是"好看"：
 *   1. 五档按**占目标的比例**上色，不按绝对值。8 杯水和 10 分钟冥想放同一张图里，
 *      绝对值没有可比性，比例有。
 *   2. 补卡的那天画成"空心环"。它是事后补记，不是当天真做了；
 *      不区分的话，一次补记 10 天看起来就是"连续坚持 10 天"。
 *   3. 不在排期里的日子用更淡的底色，将来的日子用虚线框。
 *      否则"每周一三五"的习惯会有一半格子是空的，看起来像天天在断。
 */

const WEEKDAY_LABEL = ['一', '', '三', '', '五', '', ''];

interface HeatmapProps {
  weeks: HeatCell[][];
  target: number;
  unit: string;
  /** 点某一格 → 补记/修改那一天。不传则整体只读 */
  onPick?: ((date: string) => void) | undefined;
  selected?: string | null;
}

function describe(cell: HeatCell, target: number, unit: string): string {
  const parts = [cell.date];
  if (cell.future) parts.push('还没到');
  else if (cell.value <= 0) parts.push('没有记录');
  else parts.push(`${cell.value}/${target} ${unit}`);
  if (cell.backfilled) parts.push('补记');
  if (!cell.scheduled) parts.push('不在排期');
  return parts.join(' · ');
}

/** 每列（一周）该不该标月份：只在"这一周里有 1 号"时标，避免同一列重复标两次 */
function monthLabelOf(week: readonly HeatCell[]): string | null {
  for (const cell of week) {
    if (cell.date.endsWith('-01')) return `${Number(cell.date.slice(5, 7))}月`;
  }
  return null;
}

export function Heatmap({ weeks, target, unit, onPick, selected }: HeatmapProps) {
  const columns: CSSProperties = { '--cols': String(weeks.length) } as CSSProperties;

  return (
    <div className={styles.wrap}>
      <div className={styles.inner} style={columns}>
        <div className={styles.corner} aria-hidden="true" />
        <div className={styles.months} aria-hidden="true">
          {weeks.map((week, index) => (
            <span key={index} className={styles.month}>
              {monthLabelOf(week) ?? ''}
            </span>
          ))}
        </div>

        <div className={styles.days} aria-hidden="true">
          {WEEKDAY_LABEL.map((label, index) => (
            <span key={index} className={styles.day}>
              {label}
            </span>
          ))}
        </div>

        <div className={styles.grid} role="grid" aria-label="近 12 周打卡记录">
          {weeks.map((week) =>
            week.map((cell) => {
              const label = describe(cell, target, unit);
              const extra = {
                'data-level': String(cell.level),
                'data-backfilled': String(cell.backfilled),
                'data-scheduled': String(cell.scheduled),
                'data-future': String(cell.future),
                'data-selected': String(selected === cell.date),
                title: label,
              };
              if (!onPick || cell.future) {
                return <span key={cell.date} role="gridcell" aria-label={label} className={styles.cell} {...extra} />;
              }
              return (
                <button
                  key={cell.date}
                  type="button"
                  role="gridcell"
                  aria-label={label}
                  className={styles.cell}
                  {...extra}
                  onClick={() => onPick(cell.date)}
                />
              );
            }),
          )}
        </div>
      </div>

      <div className={styles.legend} aria-hidden="true">
        <span className={styles.legendText}>少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className={styles.cell} data-level={level} />
        ))}
        <span className={styles.legendText}>多</span>
        <span className={styles.legendGap} />
        <span className={styles.cell} data-level={3} data-backfilled="true" />
        <span className={styles.legendText}>补记</span>
      </div>
    </div>
  );
}
