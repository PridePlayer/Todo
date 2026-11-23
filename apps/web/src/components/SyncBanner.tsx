import type { CalendarStatus } from '@grid/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { syncNow } from '../sync/engine';
import styles from './SyncBanner.module.css';

/**
 * 日历页顶部的 Outlook 状态条。
 *
 * 为什么不用顶栏那个同步胶囊代替：那个胶囊说的是"GRID 自己的数据有没有推上去"，
 * 而这里说的是"Outlook 那边有没有拉下来"。两件事失败的原因完全不同
 * （一个是网络/服务端，一个是微软授权），混在一个指示器里会让用户无从下手。
 *
 * 轮询间隔 30 秒，与验收要求（Outlook 改动 1 分钟内可见）对齐：
 * 服务端自己也有 30 秒一轮，前端这一轮的作用是"用户正看着日历时立刻拉一次"。
 */

const POLL_MS = 30_000;

export function SyncBanner() {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.calendarStatus());
    } catch {
      // 状态查不到就不显示状态条：这里不该弹错误，日历本身还能用
      setStatus(null);
    }
  }, []);

  const runSync = useCallback(async (silent: boolean) => {
    if (!silent) setBusy(true);
    try {
      const result = await api.calendarSync();
      if (!silent) {
        setNote(
          result.ok
            ? `拉取 ${result.added + result.updated} 条变更${result.pushed > 0 ? `，回写 ${result.pushed} 条` : ''}`
            : (result.error ?? '同步失败'),
        );
      }
      // 服务端刚写进 change_seq 的新事件，客户端要再拉一次才看得到
      if (result.added + result.updated + result.removed > 0) void syncNow();
    } catch {
      if (!silent) setNote('同步失败，请稍后再试');
    } finally {
      if (!silent) setBusy(false);
      void load();
    }
  }, [load]);

  useEffect(() => {
    void load();
    // 首屏立刻拉一次：刚打开日历就看到 30 秒前的状态是很奇怪的
    void runSync(true);

    timer.current = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void runSync(true);
    }, POLL_MS);

    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [load, runSync]);

  if (!status || !status.configured) return null;

  if (!status.connected) {
    return (
      <div className={styles.bar} data-state="idle">
        <span>未连接 Outlook。连上之后，会议会出现在这个日历里。</span>
        <a className={styles.action} href="#settings">
          去设置
        </a>
      </div>
    );
  }

  if (status.reauthRequired) {
    return (
      <div className={styles.bar} data-state="danger" role="alert">
        <span>Outlook 授权已失效，日历停止更新。请重新连接。</span>
        <a className={styles.action} href="#settings">
          重新授权
        </a>
      </div>
    );
  }

  const syncedAt = status.lastSyncAt
    ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(status.lastSyncAt))
    : null;

  return (
    <div className={styles.bar} data-state={status.lastError ? 'warn' : 'ok'}>
      <span className={styles.text}>
        <span className={styles.mono}>{status.email}</span>
        <span className={styles.sep}>·</span>
        {status.lastError ? (
          <span>同步受阻：{status.lastError.slice(0, 60)}</span>
        ) : (
          <span>{syncedAt ? `${syncedAt} 已同步` : '尚未同步'}</span>
        )}
        <span className={styles.sep}>·</span>
        <span>{status.events} 个事件</span>
        {status.pendingWrites > 0 ? (
          <>
            <span className={styles.sep}>·</span>
            <span>{status.pendingWrites} 条回写中</span>
          </>
        ) : null}
        {note ? (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.note}>{note}</span>
          </>
        ) : null}
      </span>
      <button type="button" className={styles.action} disabled={busy} onClick={() => void runSync(false)}>
        {busy ? '同步中…' : '立即同步'}
      </button>
    </div>
  );
}
