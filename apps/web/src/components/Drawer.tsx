import {
  MAX_DEPTH,
  QUADRANT_META,
  QUADRANT_ORDER,
  WEEKDAYS,
  buildRrule,
  combineDateTime,
  formatTimeRange,
  parseRrule,
  rruleFromPreset,
  weekdayOf,
  toDateInput,
  toTimeInput,
  type Quadrant,
  type RrulePreset,
  type Weekday,
  type Tag,
  type Task,
  type TaskPatch,
} from '@grid/core';
import { useEffect, useRef, useState } from 'react';
import { Checkbox } from './Checkbox';
import { TagPicker } from './TagPicker';
import { TagChip } from './TagChip';
import styles from './Drawer.module.css';

interface DrawerProps {
  task: Task;
  children: Task[];
  tagMap: Map<string, Tag>;
  onClose: () => void;
  onPatch: (patch: TaskPatch) => Promise<void>;
  onDelete: () => void;
  onToggle: (id: string) => void;
  onCreateChild: (title: string, parentId: string) => Promise<void>;
  onAddTag: (name: string) => Promise<void>;
  onRemoveTag: (tagId: string) => Promise<void>;
  onOpenTask: (id: string) => void;
}

const PRIORITY_LABEL: Record<number, string> = { 0: '无', 1: '低', 2: '中', 3: '高' };
const DAY_MS = 86_400_000;

type RepeatFreq = 'none' | 'daily' | 'weekday' | 'weekly' | 'monthly' | 'monthly-last-workday' | 'yearly' | 'custom';

const WEEKDAY_CN: Record<Weekday, string> = { MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' };

/** 面向 UI 的重复预设。值直接是 core 的 RrulePreset，不另造一套名字 */
const REPEAT_OPTIONS: { key: RrulePreset | 'none'; label: string }[] = [
  { key: 'none', label: '不重复' },
  { key: 'daily', label: '每天' },
  { key: 'weekday', label: '每个工作日' },
  { key: 'weekly', label: '每周（选日）' },
  { key: 'monthly', label: '每月（按当天几号）' },
  { key: 'monthly-last-workday', label: '每月最后一个周五' },
  { key: 'yearly', label: '每年' },
];

export function Drawer({
  task,
  children,
  tagMap,
  onClose,
  onPatch,
  onDelete,
  onToggle,
  onCreateChild,
  onAddTag,
  onRemoveTag,
  onOpenTask,
}: DrawerProps) {
  const titleRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note ?? '');
  const [tagDraft, setTagDraft] = useState('');
  const [childDraft, setChildDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 切到另一个任务时同步草稿，否则会拿上一条的标题去覆盖这一条
  useEffect(() => {
    setTitle(task.title);
    setNote(task.note ?? '');
    setError(null);
  }, [task.id, task.title, task.note]);

  const dateValue = task.dueDate ?? (task.startAt !== null ? toDateInput(task.startAt) : '');
  const startValue = task.startAt !== null ? toTimeInput(task.startAt) : '';
  const endValue = task.endAt !== null ? toTimeInput(task.endAt) : '';
  const range = formatTimeRange(task.startAt, task.endAt);

  /**
   * 反查当前 rrule 属于哪个预设。
   *
   * 判据是"用同一锚点重新生成后字面完全相等"，不是 includes(FREQ)。
   * 后者会把 `FREQ=WEEKLY;BYDAY=MO;COUNT=6` 误判成"每周"，
   * 用户一碰下拉框就把 COUNT 丢了 —— 结束条件静默消失是最难发现的那种数据损坏。
   */
  const repeatAnchor = task.startAt ?? (task.dueDate ? combineDateTime(task.dueDate, '09:00') : Date.now());
  const [repeatFreq, setRepeatFreq] = useState<RepeatFreq>('none');
  const [repeatDays, setRepeatDays] = useState<Weekday[]>([]);
  const [repeatCount, setRepeatCount] = useState<number | null>(null);
  // 次数与截止日期互斥：两条同时写进 RRULE 会让"以先到者为准"变成隐式行为，
  // 用户看到 COUNT=5 和 UNTIL=12-31 无法判断到底停在哪
  const [repeatUntil, setRepeatUntil] = useState<string>('');

  // 切到别的任务时重新解析。三个都做成受控 state 是因为"改周几"要立刻反映到按钮上，
  // 但它们又必须能从 task.rrule 还原 —— 直接算出来的值没法被用户改。
  useEffect(() => {
    const parsed = task.rrule ? parseRrule(task.rrule) : null;
    if (!parsed) {
      setRepeatFreq('none');
      setRepeatDays([]);
      setRepeatCount(null);
      return;
    }
    const days = parsed.byDay ?? [];
    const hasByMonthDay = parsed.byMonthDay !== null && parsed.byMonthDay.length > 0;
    let freq: RepeatFreq = 'custom';
    if (parsed.freq === 'DAILY' && days.length === 0 && !hasByMonthDay && parsed.bySetPos === null) freq = 'daily';
    else if (parsed.freq === 'WEEKLY' && days.join(',') === 'MO,TU,WE,TH,FR' && parsed.bySetPos === null) freq = 'weekday';
    else if (parsed.freq === 'WEEKLY' && days.length > 0 && !hasByMonthDay && parsed.bySetPos === null) freq = 'weekly';
    else if (parsed.freq === 'MONTHLY' && parsed.bySetPos === -1 && days.join(',') === 'FR') freq = 'monthly-last-workday';
    else if (parsed.freq === 'MONTHLY' && hasByMonthDay && days.length === 0 && parsed.bySetPos === null) freq = 'monthly';
    else if (parsed.freq === 'YEARLY' && days.length === 0 && !hasByMonthDay && parsed.bySetPos === null) freq = 'yearly';
    setRepeatFreq(freq);
    setRepeatDays(days);
    setRepeatCount(parsed.count);
    setRepeatUntil(parsed.until ? toDateInput(parsed.until) : '');
  }, [task.id, task.rrule]);

  /**
   * 重拼规则。
   *
   * 只在"语义参数"这一层出入口（buildRrule），不让 UI 拼字符串：
   * BYDAY 的顺序、INTERVAL=1 写不写、UNTIL 的 UTC 格式都容易出错，
   * 而 parseRrule 只能判断语法合法，判断不出"是不是你要的那条"。
   */
  async function commitRepeat(freq: RepeatFreq, days: Weekday[], count: number | null, untilText: string) {
    if (freq === 'none') {
      await onPatch({ rrule: null });
      return;
    }
    if (freq === 'custom') return;
    const anchorDate = new Date(repeatAnchor);
    const until = untilText ? new Date(`${untilText}T23:59:59`).getTime() : null;
    const rule = buildRrule({
      freq: freq === 'daily' ? 'DAILY' : freq === 'monthly' || freq === 'monthly-last-workday' ? 'MONTHLY' : freq === 'yearly' ? 'YEARLY' : 'WEEKLY',
      byDay: freq === 'weekly' ? days : freq === 'weekday' ? ['MO', 'TU', 'WE', 'TH', 'FR'] : freq === 'monthly-last-workday' ? ['FR'] : undefined,
      bySetPos: freq === 'monthly-last-workday' ? -1 : null,
      byMonthDay: freq === 'monthly' ? [anchorDate.getDate()] : undefined,
      count: count && count > 0 ? count : null,
      until,
    });
    await onPatch({ rrule: rule });
  }

  function toggleRepeatDay(day: Weekday) {
    const next = repeatDays.includes(day)
      ? repeatDays.filter((d) => d !== day)
      : [...repeatDays, day].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    setRepeatDays(next);
    void commitRepeat('weekly', next, repeatCount, repeatUntil);
  }

  const canNest = task.depth < MAX_DEPTH - 1;

  async function applyTimes(nextDate: string, nextStart: string, nextEnd: string) {
    if (nextDate === '') {
      await onPatch({ dueDate: null, startAt: null, endAt: null });
      return;
    }
    if (nextStart === '') {
      await onPatch({ dueDate: nextDate, startAt: null, endAt: null });
      return;
    }
    const startAt = combineDateTime(nextDate, nextStart);
    let endAt: number | null = null;
    if (nextEnd !== '') {
      endAt = combineDateTime(nextDate, nextEnd);
      // 结束早于开始 = 跨天，这正是「23:00 – 次日 01:00」的建模方式
      if (endAt <= startAt) endAt += DAY_MS;
    }
    await onPatch({ dueDate: null, startAt, endAt });
  }

  async function commitTitle() {
    const clean = title.trim();
    if (clean === '' || clean === task.title) {
      setTitle(task.title);
      return;
    }
    await onPatch({ title: clean });
  }

  return (
    <aside className={styles.drawer} aria-label="任务详情">
      <header className={styles.head}>
        <span className={styles.crumb}>任务 · 第 {task.depth + 1} 层</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="关闭详情">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      </header>

      <div className={styles.body}>
        <input
          ref={titleRef}
          className={styles.titleInput}
          value={title}
          aria-label="任务标题"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />

        <section className={styles.field}>
          <span className={styles.label}>象限</span>
          <div className={styles.quadrants}>
            {QUADRANT_ORDER.map((quadrant) => (
              <button
                key={quadrant}
                type="button"
                className={styles.quadrant}
                data-on={task.quadrant === quadrant}
                aria-pressed={task.quadrant === quadrant}
                onClick={() => void onPatch({ quadrant: quadrant as Quadrant })}
              >
                <span className={styles.quadrantNo}>{QUADRANT_META[quadrant].no}</span>
                <span className={styles.quadrantName}>{QUADRANT_META[quadrant].title}</span>
              </button>
            ))}
          </div>
        </section>

        <section className={styles.field}>
          <span className={styles.label}>时间</span>
          <div className={styles.timeRow}>
            <input
              type="date"
              className={styles.control}
              value={dateValue}
              aria-label="日期"
              onChange={(event) => void applyTimes(event.target.value, startValue, endValue)}
            />
            <input
              type="time"
              className={styles.control}
              value={startValue}
              aria-label="开始时间"
              onChange={(event) => void applyTimes(dateValue, event.target.value, endValue)}
            />
            <span className={styles.dash} aria-hidden="true">
              –
            </span>
            <input
              type="time"
              className={styles.control}
              value={endValue}
              aria-label="结束时间"
              onChange={(event) => void applyTimes(dateValue, startValue, event.target.value)}
            />
          </div>
          <p className={styles.hint}>
            {range ? `显示为 ${range}` : '只填日期就是全天任务；结束早于开始会自动算成次日'}
          </p>
        </section>

        <section className={styles.field}>
          <span className={styles.label}>重复</span>
          <select
            className={styles.control}
            aria-label="重复规则"
            value={repeatFreq}
            onChange={(event) => {
              const next = event.target.value as RepeatFreq;
              setRepeatFreq(next);
              // 首次切到"每周"默认勾上任务当天的星期，否则用户要多点一次才有结果
              const days = next === 'weekly' && repeatDays.length === 0 ? [weekdayOf(new Date(repeatAnchor))] : repeatDays;
              setRepeatDays(days);
              void commitRepeat(next, days, repeatCount, repeatUntil);
            }}
          >
            {REPEAT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
            {repeatFreq === 'custom' ? (
              <option value="custom" disabled>
                自定义规则（保留原样）
              </option>
            ) : null}
          </select>

          {repeatFreq === 'weekly' || repeatFreq === 'custom' ? (
            <div className={styles.segments} role="group" aria-label="重复的星期">
              {WEEKDAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  className={styles.segment}
                  data-on={repeatDays.includes(day)}
                  aria-pressed={repeatDays.includes(day)}
                  onClick={() => toggleRepeatDay(day)}
                >
                  {WEEKDAY_CN[day]}
                </button>
              ))}
            </div>
          ) : null}

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
            <input
              type="number"
              min={0}
              max={999}
              className={styles.control}
              style={{ width: 72 }}
              value={repeatCount ?? ''}
              placeholder="一直"
              aria-label="重复次数，留空表示一直重复"
              onChange={(event) => {
                const raw = event.target.value.trim();
                setRepeatCount(raw === '' ? null : Math.max(0, Math.min(999, Number(raw) | 0)));
              }}
              onBlur={() => void commitRepeat(repeatFreq, repeatDays, repeatCount, repeatUntil)}
            />
            <span className={styles.hint} style={{ marginTop: 0 }}>次后停止</span>
            <span className={styles.hint} style={{ marginTop: 0 }}>或截止于</span>
            <input
              type="date"
              className={styles.control}
              value={repeatUntil}
              aria-label="重复截止日期，留空表示一直重复"
              onChange={(event) => {
                const value = event.target.value;
                setRepeatUntil(value);
                // 选了截止日期就清空次数，保持互斥
                if (value !== '') setRepeatCount(null);
                void commitRepeat(repeatFreq, repeatDays, value === '' ? repeatCount : null, value);
              }}
            />
          </div>

          <p className={styles.hint}>
            {task.rrule
              ? `规则：${task.rrule}`
              : '重复以开始时间为锚点。改了日期之后要重新选一次重复，才会按新日期算。'}
          </p>
        </section>

        <section className={styles.field}>
          <span className={styles.label}>地点</span>
          <input
            className={styles.control}
            defaultValue={task.location ?? ''}
            placeholder="可留空"
            aria-label="地点"
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== (task.location ?? '')) void onPatch({ location: value || null });
            }}
          />
        </section>

        <section className={styles.field}>
          <span className={styles.label}>优先级</span>
          <div className={styles.segments} role="group" aria-label="优先级">
            {[0, 1, 2, 3].map((level) => (
              <button
                key={level}
                type="button"
                className={styles.segment}
                data-on={task.priority === level}
                aria-pressed={task.priority === level}
                onClick={() => void onPatch({ priority: level })}
              >
                {PRIORITY_LABEL[level]}
              </button>
            ))}
          </div>
        </section>

        <section className={styles.field}>
          <span className={styles.label}>标签</span>
          {/* 用 TagPicker 而不是"输名字回车"：标签多了之后靠记忆拼写会拼错，
              而拼错会静默生成一个新标签，界面上看着像重复项 */}
          <TagPicker
            tagMap={tagMap}
            value={task.tagIds}
            onChange={(next) => void onPatch({ tagIds: next })}
            onCreate={onAddTag}
          />
        </section>

        <section className={styles.field}>
          <span className={styles.label}>备注</span>
          <textarea
            className={styles.note}
            value={note}
            rows={4}
            placeholder="背景、链接、要问的人…"
            aria-label="备注"
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => {
              const next = note.trim() === '' ? null : note;
              if (next !== (task.note ?? null)) void onPatch({ note: next });
            }}
          />
        </section>

        <section className={styles.field}>
          <span className={styles.label}>
            子任务 {children.length > 0 ? `（${children.length}）` : ''}
          </span>

          {children.length > 0 ? (
            <ul className={styles.children}>
              {children.map((child) => (
                <li key={child.id} className={styles.child}>
                  <Checkbox
                    checked={child.completedAt !== null}
                    onChange={() => onToggle(child.id)}
                    label={child.title}
                  />
                  <button
                    type="button"
                    className={styles.childTitle}
                    data-done={child.completedAt !== null}
                    onClick={() => onOpenTask(child.id)}
                  >
                    {child.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {canNest ? (
            <input
              className={styles.control}
              value={childDraft}
              placeholder="加一条子任务，回车确认"
              aria-label="添加子任务"
              onChange={(event) => setChildDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const value = childDraft.trim();
                if (value === '') return;
                setError(null);
                void onCreateChild(value, task.id)
                  .then(() => setChildDraft(''))
                  .catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : '添加失败'),
                  );
              }}
            />
          ) : (
            <p className={styles.limit}>已经是第 {MAX_DEPTH} 层，不能再加子任务（最多 {MAX_DEPTH} 层）</p>
          )}

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>

      <footer className={styles.foot}>
        <button
          type="button"
          className={styles.done}
          onClick={() => onToggle(task.id)}
        >
          {task.completedAt !== null ? '标记为未完成' : '标记完成'}
        </button>
        <button type="button" className={styles.remove} onClick={onDelete}>
          删除
        </button>
      </footer>
    </aside>
  );
}
