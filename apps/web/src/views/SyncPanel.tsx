import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ConflictRow, OutboxOp } from '../db/dexie';
import { useSyncStatus } from '../hooks/useSync';
import {
  discardFailedOps,
  dismissConflicts,
  listConflicts,
  listFailedOps,
  readLocalCursor,
  rebuildFromServer,
  resolveConflict,
  retryFailedOps,
  syncNow,
} from '../sync/engine';
import styles from './Settings.module.css';

/**
 * 同步面板。
 *
 * 放在设置页而不是主界面：它回答的是"两边到底一不一致"这种工程问题，
 * 但又是排查问题时的第一现场——所以每个数字都必须是可直接对照的原始值
 * （游标 vs 服务端水位），而不是包装成"状态良好"的一句话。
 */
export function SyncPanel() {
  const status = useSyncStatus();
  const [cursor, setCursor] = useState<number | null>(null);
  const [server, setServer] = useState<{ serverCursor: number; tasks: number; tags: number; conflicts: number } | null>(null);
  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [failed, setFailed] = useState<OutboxOp[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setCursor(await readLocalCursor());
    setConflicts(await listConflicts());
    setFailed(await listFailedOps());
    try {
      setServer(await api.syncState());
    } catch {
      setServer(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, status.lastSyncAt, status.pending, status.conflicts, status.failed]);

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(true);
      setNote(null);
      try {
        await action();
        await refresh();
      } catch (error) {
        setNote(error instanceof Error ? error.message : `${label}失败`);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const consistent = cursor !== null && server !== null && cursor >= server.serverCursor;

  return (
    <section className={styles.section} aria-labelledby="sync-title">
      <div className={styles.sectionHead}>
        <h2 className={styles.h2} id="sync-title">
          同步
        </h2>
        <div className={styles.rowActions}>
          <button type="button" className={styles.ghost} onClick={() => void run('同步', async () => { await syncNow(); })} disabled={busy}>
            {busy ? '处理中…' : '立即同步'}
          </button>
          <button
            type="button"
            className={styles.ghost}
            onClick={() => {
              const ok = window.confirm(
                '全量重建会用服务端数据覆盖本机：先确保没有未同步的改动。继续？',
              );
              if (ok) void run('重建', rebuildFromServer);
            }}
            disabled={busy}
          >
            全量重建
          </button>
        </div>
      </div>

      <p className={styles.lead}>
        本地库始终是唯一读源，服务端只是另一台设备。写入先落本地并进入操作队列，
        同步周期固定为「推 → 拉 → 应用 → 还有就继续拉」。
        游标追平服务端水位 = 两边已经收敛。
      </p>

      <dl className={styles.kv}>
        <div>
          <dt>待推送</dt>
          <dd className={styles.mono}>{status.pending}</dd>
        </div>
        <div>
          <dt>本地游标</dt>
          <dd className={styles.mono}>{cursor ?? '—'}</dd>
        </div>
        <div>
          <dt>服务端水位</dt>
          <dd className={styles.mono} data-state={consistent ? 'up' : 'down'}>
            {server ? server.serverCursor : '—'}
          </dd>
        </div>
        <div>
          <dt>服务端待办</dt>
          <dd className={styles.mono}>{server ? server.tasks : '—'}</dd>
        </div>
        <div>
          <dt>上次同步</dt>
          <dd className={styles.mono}>
            {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString('zh-CN') : '—'}
          </dd>
        </div>
        <div>
          <dt>冲突待决</dt>
          <dd className={styles.mono} data-state={status.conflicts > 0 ? 'down' : 'up'}>
            {status.conflicts}
          </dd>
        </div>
      </dl>

      {note ? <p className={styles.muted}>{note}</p> : null}

      {failed.length > 0 ? (
        <>
          <div className={styles.sectionHead}>
            <h3 className={styles.h2}>被拒绝的操作 · {failed.length}</h3>
            <div className={styles.rowActions}>
              <button type="button" className={styles.ghost} onClick={() => void run('重试', retryFailedOps)} disabled={busy}>
                全部重试
              </button>
              <button type="button" className={styles.ghost} onClick={() => void run('丢弃', discardFailedOps)} disabled={busy}>
                全部丢弃
              </button>
            </div>
          </div>
          <ul className={styles.conflictList}>
            {failed.slice(0, 10).map((op) => (
              <li key={op.opId}>
                <code className={styles.code}>{op.action}</code>
                <span className={styles.mono}>{op.id}</span>
                <span className={styles.muted}>{op.error ?? '未知原因'}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {conflicts.length > 0 ? (
        <>
          <div className={styles.sectionHead}>
            <h3 className={styles.h2}>冲突待决 · {conflicts.length}</h3>
            <button type="button" className={styles.ghost} onClick={() => void run('忽略', dismissConflicts)} disabled={busy}>
              全部忽略
            </button>
          </div>
          <p className={styles.muted}>
            同一字段在两端都改了。合并时已按 HLC 自动裁过一次，这里只记录败者，供你切回。
          </p>
          <ul className={styles.conflictList}>
            {conflicts.map((row) => (
              <li key={row.id}>
                <code className={styles.code}>{row.field}</code>
                <span className={styles.mono} title={row.local}>
                  本地 {preview(row.local)}
                </span>
                <span className={styles.mono} title={row.remote}>
                  远端 {preview(row.remote)}
                </span>
                <span className={styles.rowActions}>
                  <button type="button" className={styles.ghost} onClick={() => void run('裁决', () => resolveConflict(row.id, 'local'))} disabled={busy}>
                    用本地
                  </button>
                  <button type="button" className={styles.ghost} onClick={() => void run('裁决', () => resolveConflict(row.id, 'remote'))} disabled={busy}>
                    用远端
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className={styles.muted}>
        协议：操作队列 + 字段级合并 + HLC 定序（docs/03 §7）
      </p>
    </section>
  );
}

/** JSON 值裁成一行短预览：冲突值可能是 10000 字的 note，直接渲染会把页面撑爆 */
function preview(json: string): string {
  let text = json;
  try {
    const value = JSON.parse(json) as unknown;
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    /* 保持原文 */
  }
  if (text === undefined || text === null) return '空';
  if (text === '') return '（空串）';
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}
