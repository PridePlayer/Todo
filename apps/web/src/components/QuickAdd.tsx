import { QUADRANT_META, QUADRANT_ORDER, type Quadrant } from '@grid/core';
import { useState, type RefObject } from 'react';
import styles from './QuickAdd.module.css';

interface QuickAddProps {
  target: Quadrant;
  onTargetChange: (quadrant: Quadrant) => void;
  onCreate: (title: string) => Promise<void>;
  inputRef: RefObject<HTMLInputElement | null>;
  showQuadrantPicker?: boolean;
  placeholder?: string;
}

/**
 * 快速新增条。
 *
 * 验收要求「连续输入 3 条不用重新点」，所以提交成功后**不清空焦点、不关闭**，
 * 只把输入框清空。用户按 N 进来，敲标题，回车，再敲，再回车——
 * 中间不能有任何一次需要动鼠标。
 */
export function QuickAdd({
  target,
  onTargetChange,
  onCreate,
  inputRef,
  showQuadrantPicker = true,
  placeholder = '写点什么，回车就存',
}: QuickAddProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const title = value.trim();
    if (title === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(title);
      setValue('');
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <form
        className={styles.bar}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <svg className={styles.plus} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>

        <input
          ref={inputRef}
          className={styles.input}
          value={value}
          placeholder={placeholder}
          aria-label="快速新增待办"
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.blur();
              setValue('');
              return;
            }
            // 输入框为空时按 1–4 切换目标象限，不用鼠标去点
            if (showQuadrantPicker && value === '' && /^[1-4]$/.test(event.key)) {
              event.preventDefault();
              onTargetChange(Number(event.key) as Quadrant);
            }
          }}
        />

        {showQuadrantPicker ? (
          <div className={styles.targets} role="group" aria-label="目标象限">
            {QUADRANT_ORDER.map((quadrant) => (
              <button
                key={quadrant}
                type="button"
                className={styles.target}
                data-on={quadrant === target}
                aria-pressed={quadrant === target}
                title={`${QUADRANT_META[quadrant].no} ${QUADRANT_META[quadrant].title}`}
                onClick={() => {
                  onTargetChange(quadrant);
                  inputRef.current?.focus();
                }}
              >
                {QUADRANT_META[quadrant].no}
              </button>
            ))}
          </div>
        ) : null}

        <span className={styles.hint}>Enter 保存并继续 · Esc 收起</span>
      </form>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
