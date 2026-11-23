import type { Occurrence, OccurrencePatch, Task } from '@grid/core';
import { useState } from 'react';
import { RangeChoice, type EditScope } from '../../components/RangeChoice';
import styles from './calendar.module.css';
import { dayStart } from './geometry';
import editor from './EventEditor.module.css';

const DAY = 24 * 60 * 60 * 1000;

/**
 * 单次事件的编辑面板。
 *
 * 保存时**不默认**"改整个系列"：重复任务被误改整个系列是最难发现的事故
 * （发现时已经过去两周，原来那 8 个会议都被挪走了）。所以只要系列带规则，
 * 保存前一定先问范围。
 */

interface EventEditorProps {
  occurrence: Occurrence;
  series: Task | null;
  onApply: (patch: OccurrencePatch, scope: EditScope | null) => Promise<void>;
  onSkip: () => void;
  onClose: () => void;
}

function dateInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function EventEditor({ occurrence, series, onApply, onSkip, onClose }: EventEditorProps) {
  const [title, setTitle] = useState(occurrence.title);
  const [date, setDate] = useState(dateInput(occurrence.start));
  const [start, setStart] = useState(timeInput(occurrence.start));
  const [end, setEnd] = useState(timeInput(occurrence.end));
  const [askScope, setAskScope] = useState(false);
  const [busy, setBusy] = useState(false);

  const recurring = series?.rrule !== null && series?.rrule !== undefined;
  const duration = occurrence.end - occurrence.start;

  /**
   * 只改开始时间时，**保持时长**而不是保持"结束时刻"。
   *
   * 反过来的做法（把结束时刻原样搬过去）会产生一个反直觉的坑：
   * 把 09:00–10:00 的开始改成 14:00，结束仍是 10:00 → 被判成"跨天"，
   * 于是这次会议变成 14:00 到次日 10:00，日历上看是一个 20 小时的色块。
   */
  function buildPatch(): OccurrencePatch {
    const patch: OccurrencePatch = {};
    const patchTitle = title.trim();
    if (patchTitle !== '' && patchTitle !== occurrence.title) patch.title = patchTitle;

    const startDirty = start !== timeInput(occurrence.start);
    const endDirty = end !== timeInput(occurrence.end);
    const dayShift = new Date(`${date}T00:00:00`).getTime() - dayStart(occurrence.start);

    if (!startDirty && !endDirty && dayShift === 0) return patch;

    const startAt = new Date(`${date}T${start}:00`).getTime();
    let endAt: number;
    if (endDirty) {
      // 用户明确改了结束时间：早于开始就按跨天算（23:00–01:00 是常见诉求）
      const crossDay = end <= start;
      endAt = new Date(`${date}T${end}:00`).getTime() + (crossDay ? DAY : 0);
    } else {
      endAt = startAt + duration;
    }
    patch.startAt = startAt;
    patch.endAt = Math.max(startAt + 15 * 60 * 1000, endAt);
    return patch;
  }

  async function save(scope: EditScope | null): Promise<void> {
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await onApply(patch, scope);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={editor.overlay} role="presentation" onClick={onClose}>
      <form
        className={editor.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (recurring) setAskScope(true);
          else void save(null);
        }}
      >
        <p className="eyebrow">{recurring ? '重复任务的一次' : '任务'}</p>
        <label className={editor.field}>
          <span className={editor.label}>标题</span>
          <input
            className={editor.input}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </label>

        <div className={editor.row}>
          <label className={editor.field}>
            <span className={editor.label}>日期</span>
            <input className={editor.input} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label className={editor.field}>
            <span className={editor.label}>开始</span>
            <input className={editor.input} type="time" value={start} onChange={(event) => setStart(event.target.value)} />
          </label>
          <label className={editor.field}>
            <span className={editor.label}>结束</span>
            <input className={editor.input} type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
          </label>
        </div>

        {recurring ? (
          <p className={editor.rule}>
            重复规则 <code>{series?.rrule}</code>
          </p>
        ) : null}

        <div className={editor.actions}>
          <button type="submit" className={styles.addBtn} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className={editor.del}
            onClick={() => {
              onSkip();
            }}
          >
            {recurring ? '只删这一次' : '删除'}
          </button>
          <button type="button" className={editor.cancel} onClick={onClose}>
            取消
          </button>
        </div>

        {recurring ? (
          <p className={editor.note}>
            这是 <span className={editor.mono}>{series?.title}</span> 的一次实例，保存后会问你要改哪些。
          </p>
        ) : null}
      </form>

      {askScope ? (
        <RangeChoice
          title={title.trim() === '' ? occurrence.title : title.trim()}
          onPick={(scope) => {
            setAskScope(false);
            void save(scope);
          }}
          onCancel={() => setAskScope(false)}
        />
      ) : null}
    </div>
  );
}
