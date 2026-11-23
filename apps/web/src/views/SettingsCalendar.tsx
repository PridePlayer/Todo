import type { CalendarStatus } from '@grid/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { syncNow } from '../sync/engine';
import { loadCalendarStatus, patchSourceEverywhere } from '../sync/calendar';
import styles from './SettingsCalendar.module.css';

/**
 * 设置页的"日历"一节。
 *
 * 与 OutlookPanel 的分工：那个管**账号**（连接/验活/断开），这个管**日历**（
 * 哪些日历要显示、哪些要同步、上次同步到几点）。
 * 合成一张卡片的后果是"我只想关掉节假日"却要先理解授权状态。
 */
export function SettingsCalendar() {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus(await loadCalendarStatus());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function syncNowClick(): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      const result = await api.calendarSync();
      setNote(
        result.ok
          ? `拉取 ${result.added} 新增 / ${result.updated} 变更 / ${result.removed} 取消`
          : (result.error ?? '同步失败'),
      );
      // 服务端刚写了 change_seq，本机要再拉一次增量才看得到
      void syncNow();
    } catch {
      setNote('同步失败，请检查网络');
    } finally {
      setBusy(false);
      void load();
    }
  }

  async function refreshSources(): Promise<void> {
    setBusy(true);
    try {
      const res = await api.calendarRefreshSources();
      setNote(`已发现 ${res.sources.length} 个日历`);
      void syncNow();
    } catch {
      setNote('刷新日历列表失败');
    } finally {
      setBusy(false);
      void load();
    }
  }

  async function toggle(id: string, patch: { isVisible?: boolean; isSynced?: boolean }): Promise<void> {
    // 先本地生效再请求：勾一下要看到日历立刻消失，等 200ms 的往返会让人觉得没点上
    setStatus((prev) =>
      prev
        ? { ...prev, sources: prev.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) }
        : prev,
    );
    await patchSourceEverywhere(id, patch);
  }

  if (!status) {
    return (
      <section className={styles.section}>
        <h2 className={styles.h2}>日历</h2>
        <p className={styles.muted}>正在读取日历状态…</p>
      </section>
    );
  }

  if (!status.configured) {
    return null;
  }

  if (!status.connected) {
    return (
      <section className={styles.section}>
        <h2 className={styles.h2}>日历</h2>
        <p className={styles.muted}>还没有连接 Outlook。连接后会议会自动出现在日历视图里。</p>
        <a className={styles.primary} href={api.microsoftConnectUrl()}>
          连接 Outlook
        </a>
      </section>
    );
  }

  const syncedAt = status.lastSyncAt
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(status.lastSyncAt))
    : '尚未同步';

  return (
    <section className={styles.section}>
      <div className={styles.head}>
        <h2 className={styles.h2}>日历</h2>
        <button type="button" className={styles.ghost} onClick={() => void syncNowClick()} disabled={busy}>
          {busy ? '同步中…' : '立即同步'}
        </button>
        <button type="button" className={styles.ghost} onClick={() => void refreshSources()} disabled={busy}>
          刷新日历列表
        </button>
      </div>

      {status.reauthRequired ? (
        <p className={styles.danger} role="alert">
          授权已失效，日历停止更新。<a href={api.microsoftConnectUrl()}>重新连接</a>
        </p>
      ) : null}
      {!status.reauthRequired && status.lastError ? (
        <p className={styles.warn}>同步受阻：{status.lastError}</p>
      ) : null}
      {note ? <p className={styles.muted}>{note}</p> : null}

      <dl className={styles.kv}>
        <div>
          <dt>上次同步</dt>
          <dd>{syncedAt}</dd>
        </div>
        <div>
          <dt>本地事件</dt>
          <dd>{status.events}</dd>
        </div>
        <div>
          <dt>待回写</dt>
          <dd data-warn={status.pendingWrites > 0}>{status.pendingWrites}</dd>
        </div>
        <div>
          <dt>回写失败</dt>
          <dd data-danger={status.deadWrites > 0}>{status.deadWrites}</dd>
        </div>
      </dl>

      <ul className={styles.sources}>
        {status.sources.map((source) => (
          <li key={source.id} className={styles.source}>
            <span className={styles.swatch} data-key={source.colorKey} aria-hidden="true" />
            <span className={styles.name}>
              {source.name}
              {source.canEdit ? null : <span className={styles.badge}>只读</span>}
            </span>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={source.isSynced}
                onChange={(event) => void toggle(source.id, { isSynced: event.target.checked })}
              />
              同步
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={source.isVisible}
                onChange={(event) => void toggle(source.id, { isVisible: event.target.checked })}
              />
              显示
            </label>
          </li>
        ))}
      </ul>
      <p className={styles.hint}>
        「同步」决定要不要从 Outlook 拉这个日历；「显示」只是在本机日历里藏起来。节假日与生日默认都关着。
      </p>
    </section>
  );
}
