import styles from './Skeleton.module.css';

interface SkeletonProps {
  /** 骨架行数。列表类视图给 6~10，详情类给 3 */
  rows?: number;
  /** 无障碍播报文案，不同视图说不同的话，屏幕阅读器能听出差别 */
  label?: string;
}

/**
 * 首屏骨架。
 *
 * 存在理由是"不要闪空状态"：`useTasks()` 第一次返回 null 只持续几十毫秒，
 * 若这时渲染"还没有任务"，用户刷新页面会看到一句红口白牙的谎话。
 * 骨架比转圈好在它预示了最终布局，切走时不会跳动。
 *
 * 尺寸对照真实行高（--row-h 48px），所以从骨架切到真数据时纵向不位移。
 */
export function Skeleton({ rows = 6, label = '正在读取本地数据' }: SkeletonProps) {
  return (
    <div className={styles.wrap} role="status" aria-live="polite" aria-busy="true">
      <span className={styles.sr}>{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div className={styles.row} key={i} aria-hidden="true">
          <div className={styles.box} />
          <div className={styles.line} style={{ width: `${[62, 48, 71, 55, 66, 44][i % 6]}%` }} />
        </div>
      ))}
    </div>
  );
}

/** 内联小骨架：给侧栏、状态条这类不需要整屏骨架的地方用 */
export function SkeletonLine({ width = '100%' }: { width?: string }) {
  return <div className={styles.solo} style={{ width }} aria-hidden="true" />;
}
