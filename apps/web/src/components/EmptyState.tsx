import styles from './task.module.css';

interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}

export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <rect x="4" y="4" width="16" height="16" rx="1" />
          <path d="M8 10h8M8 14h5" />
        </svg>
      </span>
      <p className={styles.emptyTitle}>{title}</p>
      {hint ? <p className={styles.emptyHint}>{hint}</p> : null}
      {action}
    </div>
  );
}
