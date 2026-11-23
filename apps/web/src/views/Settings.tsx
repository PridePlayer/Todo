import type { SessionUser } from '@grid/core';
import { useCallback, useEffect, useState } from 'react';
import { db } from '../db/dexie';
import { OutlookPanel } from './OutlookPanel';
import { SyncPanel } from './SyncPanel';
import styles from './Settings.module.css';

interface Health {
  ok: boolean;
  db: 'up' | 'down';
  driver: string;
  rssMB: number;
  uptimeS: number;
  version: string;
}

interface SettingsProps {
  user: SessionUser;
}

/**
 * 设置页：收容那些"不属于某个视图"的东西——本地数据、服务端探活、Outlook 连接。
 * M0 的那套验收清单已经从主界面挪到这里，因为它是工程信息，不该占着四象限的位置。
 */
export function Settings({ user }: SettingsProps) {
  const [health, setHealth] = useState<Health | null>(null);
  const [probing, setProbing] = useState(false);
  const [storage, setStorage] = useState<{ tasks: number; tags: number; usage: string } | null>(null);

  const refresh = useCallback(async () => {
    setProbing(true);
    try {
      const res = await fetch('/api/healthz', { headers: { accept: 'application/json' } });
      setHealth((await res.json()) as Health);
    } catch {
      setHealth(null);
    } finally {
      setProbing(false);
    }
  }, []);

  const refreshStorage = useCallback(async () => {
    const [tasks, tags] = await Promise.all([db.tasks.count(), db.tags.count()]);
    let usage = '未知';
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      const used = estimate.usage ?? 0;
      usage = used > 1024 * 1024 ? `${(used / 1024 / 1024).toFixed(1)} MB` : `${Math.round(used / 1024)} KB`;
    }
    setStorage({ tasks, tags, usage });
  }, []);

  useEffect(() => {
    void refresh();
    void refreshStorage();
  }, [refresh, refreshStorage]);

  return (
    <div className={styles.page}>
      <p className="eyebrow">设置</p>
      <h1 className={styles.title}>本机数据与连接</h1>

      <section className={styles.section} aria-labelledby="storage-title">
        <div className={styles.sectionHead}>
          <h2 className={styles.h2} id="storage-title">
            本地数据
          </h2>
          <button type="button" className={styles.ghost} onClick={() => void refreshStorage()}>
            刷新
          </button>
        </div>
        <p className={styles.lead}>
          待办存在这台设备的 IndexedDB 里（库名 <code className={styles.code}>grid</code>），
          M1 阶段完全离线可用，不经过服务器。M2 接同步后，本地库仍是唯一读源，服务端只是另一端。
        </p>
        <dl className={styles.kv}>
          <div>
            <dt>待办条数</dt>
            <dd className={styles.mono}>{storage ? storage.tasks : '—'}</dd>
          </div>
          <div>
            <dt>标签数</dt>
            <dd className={styles.mono}>{storage ? storage.tags : '—'}</dd>
          </div>
          <div>
            <dt>占用空间</dt>
            <dd className={styles.mono}>{storage ? storage.usage : '—'}</dd>
          </div>
        </dl>
        <button
          type="button"
          className={styles.danger}
          onClick={() => {
            const ok = window.confirm(
              '清空本机全部待办、子任务与标签？此操作只影响这台设备，无法撤销。',
            );
            if (!ok) return;
            void db.delete().then(async () => {
              await db.open();
              await refreshStorage();
              window.location.reload();
            });
          }}
        >
          清空本机数据
        </button>
      </section>

      <section className={styles.section} aria-labelledby="health-title">
        <div className={styles.sectionHead}>
          <h2 className={styles.h2} id="health-title">
            服务端探活
          </h2>
          <button type="button" className={styles.ghost} onClick={() => void refresh()} disabled={probing}>
            {probing ? '探测中…' : '重新探活'}
          </button>
        </div>
        {health ? (
          <dl className={styles.kv}>
            <div>
              <dt>数据库</dt>
              <dd data-state={health.db}>{health.db === 'up' ? '在线' : '离线'}</dd>
            </div>
            <div>
              <dt>驱动</dt>
              <dd className={styles.mono}>{health.driver}</dd>
            </div>
            <div>
              <dt>进程内存</dt>
              <dd className={styles.mono}>{health.rssMB} MB</dd>
            </div>
            <div>
              <dt>已运行</dt>
              <dd className={styles.mono}>{formatUptime(health.uptimeS)}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd className={styles.mono}>v{health.version}</dd>
            </div>
          </dl>
        ) : (
          <p className={styles.muted}>探测失败：服务端没起来也不影响本地待办。</p>
        )}
        <p className={styles.muted}>当前账号：{user.email}</p>
      </section>

      <SyncPanel />

      <OutlookPanel />

      <section className={styles.section}>
        <h2 className={styles.h2}>进度</h2>
        <ul className={styles.progress}>
          <li data-done="true">M0 认证、会话、锁定、迁移、部署脚本</li>
          <li data-done="true">M0b Outlook 授权通道（PKCE + 令牌加密落库）</li>
          <li data-done="true">M1 待办与四象限（纯本地 IndexedDB）</li>
          <li data-done="true">M2 同步内核：change_seq、操作队列、冲突解决</li>
          <li>M3 重复规则与子任务编辑三选项</li>
          <li>M4 Outlook 日历增量同步与回写</li>
        </ul>
      </section>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
