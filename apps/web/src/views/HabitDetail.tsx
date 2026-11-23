import {
  computeStreak,
  dateKeyInZone,
  formatRate,
  habitUnit,
  heatmapWeeks,
  rateBuckets,
  reached,
  type Habit,
  type HabitLog,
} from '@grid/core';
import { useMemo, useState } from 'react';
import { Heatmap } from '../components/Heatmap';
import { archiveHabit, deleteHabit, deleteLog, setLog, todayKey } from '../db/habits';
import styles from './habits.module.css';

const WEEK_LABEL = ['一', '二', '三', '四', '五', '六', '日'];

function scheduleText(days: readonly number[]): string {
  if (days.length === 0 || days.length === 7) return '每天';
  return `每周${days.map((d) => WEEK_LABEL[d]).join('')}`;
}

interface HabitDetailProps {
  habit: Habit;
  /** 该习惯的记录（已排除墓碑） */
  logs: HabitLog[];
  onBack: () => void;
}

export function HabitDetail({ habit, logs, onBack }: HabitDetailProps) {
  const today = todayKey();
  const unit = habitUnit(habit);

  const [pickDate, setPickDate] = useState(today);
  const [pickValue, setPickValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const derived = useMemo(() => {
    const byDate = new Map<string, HabitLog>();
    const doneDays = new Set<string>();
    for (const log of logs) {
      if (log.deletedAt !== null) continue;
      byDate.set(log.logDate, log);
      if (reached(habit, log.value)) doneDays.add(log.logDate);
    }

    const streak = computeStreak(doneDays, today);
    const createdKey = dateKeyInZone(habit.createdAt);
    const rates = rateBuckets({ doneDays, daysOfWeek: habit.daysOfWeek, to: today, createdKey });

    const cells = heatmapWeeks({
      today,
      weeks: 12,
      target: habit.target,
      daysOfWeek: habit.daysOfWeek,
      logs: new Map(
        [...byDate.entries()].map(([date, log]) => [date, { value: log.value, backfilled: log.backfilled }]),
      ),
    });

    const recent = [...logs]
      .filter((log) => log.deletedAt === null)
      .sort((a, b) => (a.logDate < b.logDate ? 1 : a.logDate > b.logDate ? -1 : 0))
      .slice(0, 14);

    return { byDate, streak, rates, cells, recent, createdKey };
  }, [habit, logs, today]);

  const picked = derived.byDate.get(pickDate);

  return (
    <div className={styles.detail}>
      <header className={styles.detailHead}>
        <button type="button" className={styles.back} onClick={onBack}>
          ← 返回
        </button>
        <div className={styles.detailTitleBox}>
          <h1 className={styles.detailTitle}>{habit.name}</h1>
          <p className={styles.meta}>
            {scheduleText(habit.daysOfWeek)}
            {habit.type !== 'check' ? ` · 目标 ${habit.target} ${unit}` : ' · 打勾型'}
            {` · 创建于 ${derived.createdKey}`}
          </p>
        </div>
        <div className={styles.detailActions}>
          <button type="button" className={styles.ghost} onClick={() => void archiveHabit(habit.id, true)}>
            归档
          </button>
          <button
            type="button"
            className={styles.ghost}
            data-danger="true"
            onClick={() => {
              if (!window.confirm(`删除「${habit.name}」及其全部打卡记录？`)) return;
              void deleteHabit(habit.id).then(onBack);
            }}
          >
            删除
          </button>
        </div>
      </header>

      <section className={styles.statRow}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>当前连续</span>
          <span className={styles.statValue}>
            {derived.streak.current}
            <span className={styles.statUnit}>天</span>
          </span>
          <span className={styles.statHint}>
            {derived.streak.doneToday ? '今天已达标' : '今天还没达标（不算断）'}
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>最长连续</span>
          <span className={styles.statValue}>
            {derived.streak.longest}
            <span className={styles.statUnit}>天</span>
          </span>
          <span className={styles.statHint}>
            {derived.streak.lastDone ? `最近一次 ${derived.streak.lastDone}` : '还没有达标记录'}
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>近 7 天</span>
          <span className={styles.statValue}>{formatRate(derived.rates.week.rate)}</span>
          <span className={styles.statHint}>
            {derived.rates.week.done}/{derived.rates.week.expected} 项
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>近 30 天</span>
          <span className={styles.statValue}>{formatRate(derived.rates.month.rate)}</span>
          <span className={styles.statHint}>
            {derived.rates.month.done}/{derived.rates.month.expected} 项
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>全部</span>
          <span className={styles.statValue}>{formatRate(derived.rates.all.rate)}</span>
          <span className={styles.statHint}>
            {derived.rates.all.done}/{derived.rates.all.expected} 项
          </span>
        </div>
      </section>

      <section className={styles.block}>
        <h2 className={styles.blockTitle}>近 12 周</h2>
        <Heatmap
          weeks={derived.cells}
          target={habit.target}
          unit={unit}
          selected={pickDate}
          onPick={(date) => {
            setPickDate(date);
            const log = derived.byDate.get(date);
            setPickValue(log ? String(log.value) : '');
            setError(null);
          }}
        />
      </section>

      <section className={styles.block}>
        <h2 className={styles.blockTitle}>补记 / 修改某一天</h2>
        <form
          className={styles.recordForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (pickDate > today) {
              setError('不能给将来的日子打卡');
              return;
            }
            const value = Number(pickValue);
            if (!Number.isFinite(value) || value < 0) {
              setError('值必须是不小于 0 的数字');
              return;
            }
            setError(null);
            void setLog(habit, pickDate, { value });
          }}
        >
          <input
            className={styles.dateInput}
            type="date"
            value={pickDate}
            max={today}
            onChange={(event) => {
              const date = event.target.value;
              setPickDate(date);
              const log = derived.byDate.get(date);
              setPickValue(log ? String(log.value) : '');
            }}
            aria-label="日期"
          />
          <input
            className={styles.number}
            type="number"
            min={0}
            value={pickValue}
            placeholder="0"
            onChange={(event) => setPickValue(event.target.value)}
            aria-label="记录值"
          />
          <span className={styles.unit}>{unit}</span>
          <button type="submit" className={styles.primary}>
            {picked ? '更新' : '记录'}
          </button>
          {picked ? (
            <button
              type="button"
              className={styles.ghost}
              onClick={() => {
                void deleteLog(picked.id);
                setPickValue('');
              }}
            >
              删除这条
            </button>
          ) : null}
          <span className={styles.formHint}>
            {pickDate < today ? '补记会在热力图上画成空心环' : '当天记录是实心'}
          </span>
        </form>
        {error ? <p className={styles.error}>{error}</p> : null}
      </section>

      <section className={styles.block}>
        <h2 className={styles.blockTitle}>最近记录</h2>
        {derived.recent.length === 0 ? (
          <p className={styles.formHint}>还没有任何记录。</p>
        ) : (
          <ul className={styles.recordList}>
            {derived.recent.map((log) => (
              <li key={log.id} className={styles.recordRow}>
                <button
                  type="button"
                  className={styles.recordDate}
                  onClick={() => {
                    setPickDate(log.logDate);
                    setPickValue(String(log.value));
                  }}
                >
                  {log.logDate}
                  <span className={styles.recordWeekday}>{WEEK_LABEL[(new Date(`${log.logDate}T00:00:00`).getDay() + 6) % 7]}</span>
                </button>
                <span className={styles.recordValue}>
                  {log.value} {unit}
                </span>
                <span className={styles.recordFlag} data-on={reached(habit, log.value)}>
                  {reached(habit, log.value) ? '达标' : '未达标'}
                </span>
                {log.backfilled ? <span className={styles.recordBackfill}>补记</span> : <span />}
                <button type="button" className={styles.ghost} onClick={() => void deleteLog(log.id)}>
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
