import type { UndoEntry } from '../hooks/useUndo';
import styles from './Toast.module.css';

interface ToastProps {
  entry: UndoEntry;
  onUndo: () => void;
}

/**
 * 撤销条。
 * 不用自动消失的"提示"，因为删除必须有可逆路径——这是需求里「所有删除操作需二次确认或提供撤销机制」的落点。
 */
export function Toast({ entry, onUndo }: ToastProps) {
  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span className={styles.message}>{entry.message}</span>
      <button type="button" className={styles.action} onClick={onUndo}>
        撤销
      </button>
      <span className={styles.bar} aria-hidden="true">
        <span
          className={styles.barFill}
          style={{ animationDuration: `${entry.ttlMs}ms` }}
        />
      </span>
    </div>
  );
}
