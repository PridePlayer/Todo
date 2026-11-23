import type { Tag } from '@grid/core';
import { useMemo, useState } from 'react';
import { TagChip } from './TagChip';
import styles from './TagPicker.module.css';

interface TagPickerProps {
  tagMap: Map<string, Tag>;
  value: string[];
  onChange: (next: string[]) => void;
  onCreate: (name: string) => Promise<void>;
}

/**
 * 标签选择器：既能在已有标签里挑，也能直接新建。
 *
 * 原来只有一个"输名字回车"的框，逼用户先记住标签叫什么。
 * 现在输入时按前缀过滤已有标签，点一下就挂上 —— 标签越多，
 * "靠记忆拼写"这条路径就越不可用。
 */
export function TagPicker({ tagMap, value, onChange, onCreate }: TagPickerProps) {
  const [draft, setDraft] = useState('');

  const suggestions = useMemo(() => {
    const q = draft.trim().replace(/^#/, '').toLowerCase();
    const picked = new Set(value);
    return [...tagMap.values()]
      .filter((tag) => !picked.has(tag.id))
      .filter((tag) => (q === '' ? true : tag.name.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [draft, tagMap, value]);

  const exactExists = suggestions.some((t) => t.name.toLowerCase() === draft.trim().replace(/^#/, '').toLowerCase());

  async function add(name: string) {
    const trimmed = name.trim().replace(/^#/, '');
    if (trimmed === '') return;
    await onCreate(trimmed);
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.chips}>
        {value.map((id) => {
          const tag = tagMap.get(id);
          if (!tag) return null;
          return (
            <button
              key={id}
              type="button"
              className={styles.remove}
              title={`移除 #${tag.name}`}
              onClick={() => onChange(value.filter((x) => x !== id))}
            >
              <TagChip tag={tag} />
              <span aria-hidden="true">×</span>
            </button>
          );
        })}

        <input
          className={styles.input}
          value={draft}
          placeholder="搜索或新建标签"
          aria-label="搜索或新建标签"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (suggestions.length > 0 && !exactExists) {
              const first = suggestions[0]!;
              onChange([...value, first.id]);
              setDraft('');
              return;
            }
            void add(draft).then(() => setDraft(''));
          }}
        />
      </div>

      {draft.trim() !== '' && suggestions.length > 0 ? (
        <ul className={styles.suggest} role="listbox" aria-label="已有标签">
          {suggestions.map((tag) => (
            <li key={tag.id}>
              <button
                type="button"
                className={styles.option}
                role="option"
                aria-selected={false}
                onClick={() => {
                  onChange([...value, tag.id]);
                  setDraft('');
                }}
              >
                #{tag.name}
              </button>
            </li>
          ))}
          {!exactExists ? (
            <li>
              <button type="button" className={styles.option} data-new onClick={() => void add(draft).then(() => setDraft(''))}>
                新建「{draft.trim().replace(/^#/, '')}」
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
