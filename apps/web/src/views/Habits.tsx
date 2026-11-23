import {
  HABIT_TYPES,
  computeStreak,
  defaultTarget,
  habitUnit,
  isScheduled,
  progressOf,
  reached,
  type Habit,
  type HabitLog,
  type HabitType,
} from '@grid/core';
import { useMemo, useState } from 'react';
import { archiveHabit, bumpToday, createHabit, setLog, todayKey, toggleCheck } from '../db/habits';
import { useHabitLogs, useHabits } from '../hooks/useStore';
import { HabitDetail } from './HabitDetail';
import styles from './habits.module.css';

const WEEK_LABEL = ['一', '二', '三', '四', '五', '六', '日'];
const TYPE_LABEL: Record<HabitType, string> = { check: '打勾', count: '计数', duration: '时长' };
const STEP: Record<HabitType, number> = { check: 1, count: 1, duration: 5 };

function scheduleText(days: readonly number[]): string {
  if (days.length === 0) return '每天';
  if (days.length === 7) return '每天';
  return `每周${days.map((d) => WEEK_LABEL[d]).join('')}`;
}

/** 该习惯的"达标日期"集合：后续所有统计（连续天数、完成率、热力图）都只吃这一个输入 */
function doneDaysOf(habit: Habit, logs: readonly HabitLog[]): Set<string> {
  const set = new Set<string>();
  for (const log of logs) {
    if (log.habitId !== habit.id) continue;
    if (log.deletedAt !== null) continue;
    if (reached(habit, log.value)) set.add(log.logDate);
  }
  return set;
}

function logsOf(habitId: string, logs: readonly HabitLog[]): HabitLog[] {
  return logs.filter((log) => log.habitId === habitId && log.deletedAt === null);
}

export function HabitsView() {
  const habits = useHabits();
  const logs = useHabitLogs();
  const today = todayKey();

  const [detailId, setDetailId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const byHabit = useMemo(() => {
    const map = new Map<string, HabitLog[]>();
    for (const log of logs ?? []) {
      if (log.deletedAt !== null) continue;
      const bucket = map.get(log.habitId) ?? [];
      bucket.push(log);
      map.set(log.habitId, bucket);
    }
    return map;
  }, [logs]);

  const active = useMemo(() => (habits ?? []).filter((habit) => habit.archivedAt === null), [habits]);
  const archived = useMemo(() => (habits ?? []).filter((habit) => habit.archivedAt !== null), [habits]);

  const detailHabit = detailId === null ? null : ((habits ?? []).find((h) => h.id === detailId) ?? null);

  const todayStats = useMemo(() => {
    let due = 0;
    let done = 0;
    for (const habit of active) {
      if (!isScheduled(today, habit.daysOfWeek)) continue;
      due += 1;
      const log = (byHabit.get(habit.id) ?? []).find((item) => item.logDate === today);
      if (log && reached(habit, log.value)) done += 1;
    }
    return { due, done };
  }, [active, byHabit, today]);

  if (habits === null || logs === null) {
    return <div className={styles.loading}>正在读取本地数据…</div>;
  }

  if (detailHabit) {
    return (
      <HabitDetail
        habit={detailHabit}
        logs={logsOf(detailHabit.id, logs)}
        onBack={() => setDetailId(null)}
      />
    );
  }

  return (
    <div className={styles.view}>
      <header className={styles.head}>
        <div>
          <p className="eyebrow">打卡</p>
          <h1 className={styles.title}>
            {todayStats.done} / {todayStats.due} 项已完成
            <span className={styles.titleSub}>今天</span>
          </h1>
        </div>
        <button type="button" className={styles.primary} onClick={() => setShowForm((prev) => !prev)}>
          {showForm ? '收起' : '新建习惯'}
        </button>
      </header>

      {showForm ? (
        <HabitForm
          onCancel={() => setShowForm(false)}
          onCreate={async (draft) => {
            await createHabit(draft);
            setShowForm(false);
          }}
        />
      ) : null}

      <ul className={styles.list}>
        {active.map((habit) => {
          const own = byHabit.get(habit.id) ?? [];
          const todayLog = own.find((log) => log.logDate === today);
          const value = todayLog?.value ?? 0;
          const done = todayLog !== undefined && reached(habit, value);
          const scheduledToday = isScheduled(today, habit.daysOfWeek);
          const streak = computeStreak(doneDaysOf(habit, own), today);
          const unit = habitUnit(habit);
          const ratio = progressOf(habit, value);
          const editing = editingId === habit.id;

          return (
            <li key={habit.id} className={styles.row} data-done={done} data-off={!scheduledToday}>
              <button
                type="button"
                className={styles.mark}
                aria-label={done ? `取消「${habit.name}」今天的打卡` : `「${habit.name}」今天完成`}
                aria-pressed={done}
                onClick={() => {
                  if (habit.type === 'check') void toggleCheck(habit, today);
                  else if (done) void setLog(habit, today, { value: 0 });
                  else void setLog(habit, today, { value: habit.target });
                }}
              >
                {done ? '✓' : ''}
              </button>

              <div className={styles.main}>
                <button type="button" className={styles.name} onClick={() => setDetailId(habit.id)}>
                  {habit.name}
                </button>
                <span className={styles.meta}>
                  {scheduleText(habit.daysOfWeek)}
                  {habit.type !== 'check' ? ` · 目标 ${habit.target} ${unit}` : ''}
                  {streak.current > 0 ? ` · 连续 ${streak.current} 天` : ''}
                  {scheduledToday ? '' : ' · 今天不必做'}
                </span>
              </div>

              {editing ? (
                <form
                  className={styles.valueForm}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const input = event.currentTarget.elements.namedItem('value') as HTMLInputElement | null;
                    const next = Number(input?.value ?? 0);
                    void setLog(habit, today, { value: Number.isFinite(next) ? next : 0 });
                    setEditingId(null);
                  }}
                >
                  <input
                    name="value"
                    type="number"
                    min={0}
                    step={habit.type === 'duration' ? 1 : 1}
                    defaultValue={value}
                    autoFocus
                    className={styles.number}
                    aria-label={`${habit.name} 今天的值`}
                  />
                  <span className={styles.unit}>{unit}</span>
                  <button type="submit" className={styles.mini}>
                    确定
                  </button>
                </form>
              ) : habit.type === 'check' ? (
                <span className={styles.progressText}>{done ? '已完成' : '未完成'}</span>
              ) : (
                <button type="button" className={styles.progress} onClick={() => setEditingId(habit.id)}>
                  <span className={styles.num}>
                    {value}
                    <span className={styles.slash}>/{habit.target}</span>
                  </span>
                  <span className={styles.unit}>{unit}</span>
                  <span className={styles.bar} aria-hidden="true">
                    <span className={styles.barFill} style={{ width: `${Math.round(ratio * 100)}%` }} />
                  </span>
                </button>
              )}

              <div className={styles.actions}>
                {habit.type !== 'check' && !editing ? (
                  <button
                    type="button"
                    className={styles.mini}
                    disabled={done}
                    onClick={() => void bumpToday(habit, today)}
                    title={`加 ${STEP[habit.type]} ${unit}`}
                  >
                    ＋{STEP[habit.type]}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.ghost}
                  onClick={() => setDetailId(habit.id)}
                  title="查看热力图与统计"
                >
                  详情
                </button>
              </div>
            </li>
          );
        })}

        {active.length === 0 ? (
          <li className={styles.empty}>
            <p className={styles.emptyTitle}>还没有习惯</p>
            <p className={styles.emptyHint}>
              从一个"小到不会失败"的开始：喝 8 杯水、读 10 页、走 6000 步。
              连续天数只认达标的日子，设太难只会让它一直显示 0。
            </p>
          </li>
        ) : null}
      </ul>

      {archived.length > 0 ? (
        <section className={styles.archiveBlock}>
          <button type="button" className={styles.archiveToggle} onClick={() => setShowArchived((prev) => !prev)}>
            已归档（{archived.length}）{showArchived ? '收起' : '展开'}
          </button>
          {showArchived ? (
            <ul className={styles.archiveList}>
              {archived.map((habit) => (
                <li key={habit.id} className={styles.archiveRow}>
                  <span className={styles.archiveName}>{habit.name}</span>
                  <button
                    type="button"
                    className={styles.mini}
                    onClick={() => void archiveHabit(habit.id, false)}
                  >
                    恢复
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <p className={styles.footNote}>
        统计口径：连续天数只认达标的日子，今天还没打不算断；完成率的分母是"这段窗口里该做的天数"，
        起点取习惯创建日。
      </p>
    </div>
  );
}

interface FormProps {
  onCancel: () => void;
  onCreate: (draft: {
    name: string;
    type: HabitType;
    target?: number;
    unit?: string | null;
    daysOfWeek?: number[];
  }) => Promise<void>;
}

function HabitForm({ onCancel, onCreate }: FormProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<HabitType>('check');
  const [target, setTarget] = useState(String(defaultTarget('check')));
  const [unit, setUnit] = useState('');
  const [days, setDays] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggleDay = (day: number): void => {
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        void onCreate({
          name,
          type,
          // check 型的目标恒为 1，交给 createHabit 兜底，这里传什么都没用
          target: Number(target) || undefined,
          unit: unit.trim() === '' ? null : unit.trim(),
          daysOfWeek: [...days],
        })
          .then(() => {
            setName('');
            setDays(new Set());
            setBusy(false);
          })
          .catch(() => setBusy(false));
      }}
    >
      <div className={styles.formRow}>
        <input
          className={styles.input}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="习惯名称，例如「喝水」「阅读」"
          aria-label="习惯名称"
          required
        />
        <select
          className={styles.select}
          value={type}
          onChange={(event) => {
            const next = event.target.value as HabitType;
            setType(next);
            setTarget(String(defaultTarget(next)));
          }}
          aria-label="习惯类型"
        >
          {HABIT_TYPES.map((value) => (
            <option key={value} value={value}>
              {TYPE_LABEL[value]}
            </option>
          ))}
        </select>

        {type !== 'check' ? (
          <>
            <input
              className={styles.number}
              type="number"
              min={1}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              aria-label="目标值"
            />
            {type === 'count' ? (
              <input
                className={styles.unitInput}
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                placeholder="杯"
                aria-label="单位"
                maxLength={4}
              />
            ) : (
              <span className={styles.unit}>分钟</span>
            )}
          </>
        ) : null}
      </div>

      <div className={styles.formRow}>
        <span className={styles.formLabel}>哪几天</span>
        <div className={styles.days} role="group" aria-label="排期">
          {WEEK_LABEL.map((label, index) => (
            <button
              key={label}
              type="button"
              className={styles.dayChip}
              data-on={days.has(index)}
              aria-pressed={days.has(index)}
              onClick={() => toggleDay(index)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className={styles.formHint}>{days.size === 0 ? '不选 = 每天' : scheduleText([...days])}</span>
        <span className={styles.formGrow} />
        <button type="button" className={styles.ghost} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className={styles.primary} disabled={busy || name.trim() === ''}>
          创建
        </button>
      </div>
    </form>
  );
}
