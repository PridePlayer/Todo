import {
  combineDateTime,
  rruleFromPreset,
  buildRrule,
  type RrulePreset,
  type Tag,
  type Weekday,
  WEEKDAYS,
  weekdayOf,
} from '@grid/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { repo } from '../db/repo';
import { useTags } from '../hooks/useStore';
import { TagPicker } from './TagPicker';
import styles from './Fab.module.css';

type Kind = 'task' | 'event';

const KIND_LABEL: Record<Kind, string> = { task: '待办', event: '日程' };

const REPEAT_LABEL: { key: RrulePreset | 'none'; label: string }[] = [
  { key: 'none', label: '不重复' },
  { key: 'daily', label: '每天' },
  { key: 'weekday', label: '工作日' },
  { key: 'weekly', label: '每周' },
  { key: 'monthly', label: '每月' },
  { key: 'yearly', label: '每年' },
];

/**
 * 全局悬浮新建。
 *
 * 刻意做得很"轻"：一个卡片浮在右下角，不遮背景、不锁滚动、Esc 就关。
 * 新建是最高频动作，但**不该要求先跑到某个视图**才能开始 ——
 * 在日历里看到一个空档、在甘特上发现一段空窗，都该能就地记一笔。
 */
export function Fab() {
  const tagMap = useTags();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('task');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [repeat, setRepeat] = useState<RrulePreset | 'none'>('none');
  const [repeatDays, setRepeatDays] = useState<Weekday[]>([]);
  const [repeatUntil, setRepeatUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // 打开时自动聚焦标题，省一次点击
  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  const suggestions = useMemo(() => [...tagMap.values()], [tagMap]);

  function reset() {
    setTitle('');
    setDate('');
    setStartTime('');
    setEndTime('');
    setLocation('');
    setTagIds([]);
    setRepeat('none');
    setRepeatDays([]);
    setRepeatUntil('');
  }

  async function submit() {
    const trimmed = title.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    try {
      const anchor = date ? combineDateTime(date, startTime || '09:00') : Date.now();
      const rrule =
        repeat === 'none'
          ? null
          : buildRrule({
              freq: repeat === 'daily' ? 'DAILY' : repeat === 'monthly' ? 'MONTHLY' : repeat === 'yearly' ? 'YEARLY' : 'WEEKLY',
              byDay: repeat === 'weekly' ? (repeatDays.length > 0 ? repeatDays : [weekdayOf(new Date(anchor))]) : repeat === 'weekday' ? ['MO', 'TU', 'WE', 'TH', 'FR'] : undefined,
              byMonthDay: repeat === 'monthly' ? [new Date(anchor).getDate()] : undefined,
              until: repeatUntil ? new Date(`${repeatUntil}T23:59:59`).getTime() : null,
            });

      await repo.create({
        title: trimmed,
        quadrant: 4,
        dueDate: date || null,
        startAt: kind === 'event' && date && startTime ? combineDateTime(date, startTime) : null,
        endAt: kind === 'event' && date && startTime && endTime ? combineDateTime(date, endTime) : null,
        location: location.trim() || null,
        tagIds,
        rrule,
      });
      reset();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      {open ? (
        <div className={styles.card} role="dialog" aria-label="快速新建">
          <div className={styles.kinds} role="group" aria-label="类型">
            {(['task', 'event'] as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                className={styles.kind}
                data-on={kind === k}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>

          <input
            ref={titleRef}
            className={styles.title}
            value={title}
            placeholder={kind === 'task' ? '要做什么？' : '什么安排？'}
            aria-label="标题"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
              if (event.key === 'Escape') setOpen(false);
            }}
          />

          <div className={styles.grid}>
            <label className={styles.field}>
              <span className={styles.label}>日期</span>
              <input type="date" className={styles.control} value={date} onChange={(e) => setDate(e.target.value)} />
            </label>

            {kind === 'event' ? (
              <>
                <label className={styles.field}>
                  <span className={styles.label}>开始</span>
                  <input type="time" className={styles.control} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>结束</span>
                  <input type="time" className={styles.control} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                </label>
              </>
            ) : null}

            <label className={styles.field}>
              <span className={styles.label}>地点</span>
              <input
                className={styles.control}
                value={location}
                placeholder="可留空"
                onChange={(e) => setLocation(e.target.value)}
              />
            </label>
          </div>

          <div className={styles.field}>
            <span className={styles.label}>标签</span>
            <TagPicker
              tagMap={tagMap}
              value={tagIds}
              onChange={setTagIds}
              onCreate={async (name) => {
                const tag: Tag = await repo.ensureTag(name);
                if (!tagIds.includes(tag.id)) setTagIds([...tagIds, tag.id]);
              }}
            />
          </div>

          <div className={styles.grid}>
            <label className={styles.field}>
              <span className={styles.label}>重复</span>
              <select className={styles.control} value={repeat} onChange={(e) => setRepeat(e.target.value as RrulePreset | 'none')}>
                {REPEAT_LABEL.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            {repeat === 'weekly' ? (
              <div className={styles.field}>
                <span className={styles.label}>星期</span>
                <div className={styles.days}>
                  {WEEKDAYS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={styles.day}
                      data-on={repeatDays.includes(d)}
                      aria-pressed={repeatDays.includes(d)}
                      onClick={() =>
                        setRepeatDays((prev) =>
                          prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)),
                        )
                      }
                    >
                      {{ MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' }[d]}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {repeat !== 'none' ? (
              <label className={styles.field}>
                <span className={styles.label}>截止</span>
                <input
                  type="date"
                  className={styles.control}
                  value={repeatUntil}
                  placeholder="留空一直重复"
                  onChange={(e) => setRepeatUntil(e.target.value)}
                />
              </label>
            ) : null}
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.ghost} onClick={() => setOpen(false)}>
              取消
            </button>
            <button type="button" className={styles.primary} onClick={() => void submit()} disabled={title.trim() === ''}>
              创建
            </button>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className={styles.fab}
        aria-label="快速新建"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>
    </div>
  );
}
