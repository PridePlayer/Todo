import styles from './task.module.css';

interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  label: string;
}

export function Checkbox({ checked, onChange, label }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={styles.checkbox}
      onClick={(event) => {
        // 复选框的点击不该同时打开详情抽屉
        event.stopPropagation();
        onChange();
      }}
    >
      {checked ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 12.5l5 5L20 6.5" />
        </svg>
      ) : null}
    </button>
  );
}
