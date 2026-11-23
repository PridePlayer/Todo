import type { Tag } from '@grid/core';
import styles from './task.module.css';

export function TagChip({ tag }: { tag: Tag }) {
  return (
    <span className={styles.chip} data-color={tag.colorKey}>
      {tag.name}
    </span>
  );
}
