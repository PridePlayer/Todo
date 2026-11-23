import {
  WEEKDAYS,
  formatRrule,
  type Occurrence,
  type OccurrencePatch,
  type Task,
  type Weekday,
} from '@grid/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RangeChoice, type EditScope } from '../../components/RangeChoice';
import { SyncBanner } from '../../components/SyncBanner';
import { deleteCalEvent, patchCalEvent } from '../../db/cal';
import { repo } from '../../db/repo';
import { useOccurrences } from '../../hooks/useOccurrences';
import { useTasks } from '../../hooks/useStore';
import { AgendaView } from './AgendaView';
import { MonthView } from './MonthView';
import { TimeGrid } from './TimeGrid';
import {
  addDays,
  dayStart,
  formatDayLabel,
  formatMonthLabel,
  monthStart,
  shiftAnchor,
  snap,
  weekStart,
  windowOf,
  type CalendarMode,
} from './geometry';
import { EventEditor } from './EventEditor';
import styles from './calendar.module.css';

const MODES: { key: CalendarMode; label: string }[] = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'list', label: '列表' },
];

type Preset = 'none' | 'daily' | 'weekday' | 'weekly' | 'monthly' | 'yearly';

interface PendingScope {
  occurrence: Occurrence;
  patch: OccurrencePatch;
  title: string;
}

export function CalendarView() {
  // 手机上 7 列并排，每列只剩 40px：时间标签和标题都被截成两个字，
  // 周视图在那里不是"密"而是"读不出来"。默认降到日视图，用户想切还是能切。
  //
  // 这里必须写 globalThis 而不是 window：下面有个 `const window = useMemo(...)`（时间窗口），
  // 同名的 const 在整个函数体里都处于 TDZ，直接写 window.innerWidth 会抛
  // "Cannot access 'window' before initialization"，整个视图白屏。
  const [mode, setMode] = useState<CalendarMode>(() =>
    globalThis.innerWidth !== undefined && globalThis.innerWidth < 640 ? 'day' : 'week',
  );
  const [anchor, setAnchor] = useState(() => dayStart(Date.now()));
  const [editing, setEditing] = useState<Occurrence | null>(null);
  const [pending, setPending] = useState<PendingScope | null>(null);

  const window = useMemo(() => windowOf(anchor, mode), [anchor, mode]);
  const { occurrences, loading } = useOccurrences(window.from, window.to);
  const tasks = useTasks();

  const seriesOf = useCallback(
    (occurrence: Occurrence): Task | null =>
      (tasks ?? []).find((task) => task.id === occurrence.seriesId && task.deletedAt === null) ?? null,
    [tasks],
  );

  /** 拖拽/拉伸的落点：是否重复决定是直接改，还是先问范围 */
  const applyOccurrence = useCallback(
    (occurrence: Occurrence, patch: OccurrencePatch) => {
      // Outlook 事件：直接改本地并发回写，没有"改哪几次"的问题——
      // 重复事件在 UI 上是只读的，能拖的一定是单次事件
      if (occurrence.kind === 'event') {
        if (occurrence.origin?.readOnly) return;
        void patchCalEvent(occurrence.seriesId, patch);
        return;
      }
      const series = seriesOf(occurrence);
      if (!series) return;
      if (series.rrule === null) {
        void repo.patch(series.id, patch);
        return;
      }
      setPending({ occurrence, patch, title: series.title });
    },
    [seriesOf],
  );

  const handleMove = useCallback(
    (occurrence: Occurrence, deltaMs: number) => {
      applyOccurrence(occurrence, {
        startAt: occurrence.start + deltaMs,
        endAt: occurrence.end + deltaMs,
      });
    },
    [applyOccurrence],
  );

  const handleResize = useCallback(
    (occurrence: Occurrence, deltaMs: number) => {
      const end = Math.max(occurrence.start + 15 * 60 * 1000, occurrence.end + deltaMs);
      applyOccurrence(occurrence, { endAt: end });
    },
    [applyOccurrence],
  );

  const resolveScope = useCallback(
    async (scope: EditScope) => {
      if (!pending) return;
      const { occurrence, patch } = pending;
      setPending(null);
      if (scope === 'all') await repo.patch(occurrence.seriesId, patch);
      else await repo.editOccurrence(occurrence.seriesId, occurrence.originalStart, scope, patch);
    },
    [pending],
  );

  const label =
    mode === 'month'
      ? formatMonthLabel(monthStart(anchor))
      : mode === 'week'
        ? `${formatDayLabel(weekStart(anchor))} – ${formatDayLabel(addDays(weekStart(anchor), 6))}`
        : formatDayLabel(anchor);

  const days = mode === 'day' ? [dayStart(anchor)] : mode === 'week'
    ? Array.from({ length: 7 }, (_, index) => addDays(weekStart(anchor), index))
    : [];

  return (
    <div className={styles.view}>
      <header className={styles.head}>
        <div>
          <p className="eyebrow">日历</p>
          <h1 className={styles.title}>{label}</h1>
        </div>
        <div className={styles.headTools}>
          <button type="button" className={styles.navBtn} onClick={() => setAnchor(shiftAnchor(anchor, mode, -1))} aria-label="上一段">
            ←
          </button>
          <button type="button" className={styles.navBtn} onClick={() => setAnchor(dayStart(Date.now()))}>
            今天
          </button>
          <button type="button" className={styles.navBtn} onClick={() => setAnchor(shiftAnchor(anchor, mode, 1))} aria-label="下一段">
            →
          </button>
          <div className={styles.segmented}>
            {MODES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={styles.seg}
                data-on={mode === item.key}
                aria-pressed={mode === item.key}
                onClick={() => setMode(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <SyncBanner />

      <NewEventBar anchor={anchor} onCreated={(day) => setAnchor(day)} />

      {loading ? <p className={styles.empty}>正在展开重复规则…</p> : null}

      {!loading && mode !== 'month' && mode !== 'list' ? (
        <TimeGrid
          days={days}
          occurrences={occurrences}
          onMove={handleMove}
          onResize={handleResize}
          onOpen={setEditing}
          onPickDay={(day) => {
            setAnchor(day);
            setMode('day');
          }}
        />
      ) : null}

      {!loading && mode === 'month' ? (
        <MonthView
          gridStart={window.from}
          monthAnchor={anchor}
          occurrences={occurrences}
          onOpen={setEditing}
          onPickDay={(day) => {
            setAnchor(day);
            setMode('day');
          }}
        />
      ) : null}

      {!loading && mode === 'list' ? (
        <AgendaView
          from={window.from}
          to={window.to}
          occurrences={occurrences}
          onOpen={setEditing}
          onSkip={(occurrence) => {
            if (occurrence.kind === 'event') {
              if (!occurrence.origin?.readOnly) void deleteCalEvent(occurrence.seriesId);
              return;
            }
            const series = seriesOf(occurrence);
            if (!series) return;
            if (series.rrule === null) void repo.softDelete(series.id);
            else void repo.skipOccurrence(series.id, occurrence.originalStart);
          }}
        />
      ) : null}

      {editing ? (
        <EventEditor
          occurrence={editing}
          series={seriesOf(editing)}
          readOnly={editing.origin?.readOnly === true}
          webLink={editing.origin?.webLink ?? null}
          onClose={() => setEditing(null)}
          onApply={async (patch, scope) => {
            setEditing(null);
            if (editing.kind === 'event') {
              await patchCalEvent(editing.seriesId, patch);
              return;
            }
            // scope 为 null = 这条本来就不重复，直接改母体
            if (!scope) {
              await repo.patch(editing.seriesId, patch);
              return;
            }
            if (scope === 'all') await repo.patch(editing.seriesId, patch);
            else await repo.editOccurrence(editing.seriesId, editing.originalStart, scope, patch);
          }}
          onSkip={() => {
            const target = editing;
            setEditing(null);
            if (target.kind === 'event') {
              // 删的是 Outlook 侧的会议，几秒后由回写队列落到 Graph
              if (!target.origin?.readOnly) void deleteCalEvent(target.seriesId);
              return;
            }
            const series = seriesOf(target);
            if (!series) return;
            if (series.rrule === null) void repo.softDelete(series.id);
            else void repo.skipOccurrence(series.id, target.originalStart);
          }}
        />
      ) : null}

      {pending ? (
        <RangeChoice
          title={pending.title}
          onPick={(scope) => void resolveScope(scope)}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 新建条。
 *
 * 重复用"选择器 + 星期开关"而不是让用户填 RRULE：语法错误的规则一旦写进库，
 * 每次展开都会抛错，症状是整页白屏——这类输入不该交给手打。
 */
function NewEventBar({ anchor, onCreated }: { anchor: number; onCreated: (day: number) => void }) {
  const [title, setTitle] = useState('');
  const [preset, setPreset] = useState<Preset>('none');
  const [time, setTime] = useState('09:00');
  const [durationMin, setDurationMin] = useState(60);
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 星期开关默认跟着 anchor 那天走：在周三新建"每周"，直觉上就是每周三
    const day = WEEKDAYS[(new Date(anchor).getDay() + 6) % 7]!;
    setWeekdays([day]);
  }, [anchor]);

  async function submit(): Promise<void> {
    const text = title.trim();
    if (text === '' || busy) return;
    setBusy(true);
    try {
      const [hour, minute] = time.split(':').map(Number);
      const base = new Date(anchor);
      base.setHours(hour ?? 9, minute ?? 0, 0, 0);
      const startAt = base.getTime();
      const endAt = startAt + durationMin * 60 * 1000;
      const task = await repo.create({ title: text, startAt, endAt, quadrant: 1 });
      const rule = ruleOf(preset, startAt, weekdays);
      if (rule) await repo.setRrule(task.id, rule);
      setTitle('');
      onCreated(base.getTime());
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={styles.newBar}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        className={styles.newInput}
        value={title}
        placeholder="新建安排，回车保存"
        aria-label="事件标题"
        onChange={(event) => setTitle(event.target.value)}
      />
      <input
        className={styles.select}
        type="time"
        value={time}
        aria-label="开始时间"
        onChange={(event) => setTime(event.target.value)}
      />
      <select
        className={styles.select}
        value={durationMin}
        aria-label="时长"
        onChange={(event) => setDurationMin(Number(event.target.value))}
      >
        <option value={30}>30 分钟</option>
        <option value={60}>1 小时</option>
        <option value={90}>1.5 小时</option>
        <option value={120}>2 小时</option>
      </select>
      <select
        className={styles.select}
        value={preset}
        aria-label="重复"
        onChange={(event) => setPreset(event.target.value as Preset)}
      >
        <option value="none">不重复</option>
        <option value="daily">每天</option>
        <option value="weekday">工作日</option>
        <option value="weekly">每周</option>
        <option value="monthly">每月</option>
        <option value="yearly">每年</option>
      </select>
      {preset === 'weekly' || preset === 'weekday' ? (
        <div className={styles.days}>
          {WEEKDAYS.map((day, index) => (
            <button
              key={day}
              type="button"
              className={styles.day}
              data-on={weekdays.includes(day)}
              aria-pressed={weekdays.includes(day)}
              onClick={() =>
                setWeekdays((prev) =>
                  prev.includes(day) ? prev.filter((item) => item !== day) : [...prev, day].sort(
                    (a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b),
                  ),
                )
              }
              title={['周一', '周二', '周三', '周四', '周五', '周六', '周日'][index]}
            >
              {['一', '二', '三', '四', '五', '六', '日'][index]}
            </button>
          ))}
        </div>
      ) : null}
      <button type="submit" className={styles.addBtn} disabled={busy || title.trim() === ''}>
        添加
      </button>
      <span className={styles.hint}>拖拽改时间 · 按住 Alt 以 15 分钟微调</span>
    </form>
  );
}

function ruleOf(preset: Preset, anchor: number, weekdays: Weekday[]): string | null {
  const date = new Date(anchor);
  switch (preset) {
    case 'daily':
      return formatRrule({ freq: 'DAILY', interval: 1, byDay: null, byMonthDay: null, bySetPos: null, count: null, until: null });
    case 'weekday':
      return formatRrule({
        freq: 'WEEKLY',
        interval: 1,
        byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
        byMonthDay: null,
        bySetPos: null,
        count: null,
        until: null,
      });
    case 'weekly': {
      const days = weekdays.length > 0 ? weekdays : [WEEKDAYS[(date.getDay() + 6) % 7]!];
      return formatRrule({
        freq: 'WEEKLY',
        interval: 1,
        byDay: days,
        byMonthDay: null,
        bySetPos: null,
        count: null,
        until: null,
      });
    }
    case 'monthly':
      return formatRrule({
        freq: 'MONTHLY',
        interval: 1,
        byDay: null,
        byMonthDay: [date.getDate()],
        bySetPos: null,
        count: null,
        until: null,
      });
    case 'yearly':
      return formatRrule({
        freq: 'YEARLY',
        interval: 1,
        byDay: null,
        byMonthDay: null,
        bySetPos: null,
        count: null,
        until: null,
      });
    case 'none':
    default:
      return null;
  }
}

/** 供别处使用的"下一段的时间"计算（M4 日历联动会用到） */
export function nextOccurrenceStart(occurrences: readonly Occurrence[], after: number): number | null {
  const next = occurrences.filter((item) => item.start > after).sort((a, b) => a.start - b.start)[0];
  return next?.start ?? null;
}

export { snap };
