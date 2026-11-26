import type { SessionUser } from '@grid/core';
import { useCallback, useEffect, useState } from 'react';
import { TaskImporter } from '../components/TaskImporter';
import { db } from '../db/dexie';
import { OutlookPanel } from './OutlookPanel';
import { SettingsCalendar } from './SettingsCalendar';
import { SettingsDevices } from './SettingsDevices';
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

/** 导出统计里想展示给用户看的表（其余是内部表，说了也没意义） */
const EXPORT_LABELS: Record<string, string> = {
  task: '待办',
  tag: '标签',
  list: '清单',
  recur_exception: '重复例外',
  calendar_source: '日历源',
  cal_event: '日程',
  habit: '打卡项',
  habit_log: '打卡记录',
  conflict_log: '冲突记录',
};

/**
 * 设置页：收容那些"不属于某个视图"的东西——本地数据、服务端探活、Outlook 连接。
 * M0 的那套验收清单已经从主界面挪到这里，因为它是工程信息，不该占着四象限的位置。
 */
export function Settings({ user }: SettingsProps) {
  const [health, setHealth] = useState<Health | null>(null);
  const [probing, setProbing] = useState(false);
  const [storage, setStorage] = useState<{ tasks: number; tags: number; usage: string } | null>(null);
  const [exportStats, setExportStats] = useState<Record<string, number> | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

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

  /** 服务端那头的全量数据量。失败不弹窗——离线时设置页其它部分仍要能用 */
  const loadExportStats = useCallback(async () => {
    try {
      const res = await fetch('/api/export/stats', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { counts: Record<string, number> };
      setExportStats(data.counts);
      setExportError(null);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '读取失败');
    }
  }, []);

  useEffect(() => {
    void loadExportStats();
  }, [loadExportStats]);

  const exportTotal = exportStats
    ? Object.values(exportStats).reduce((sum, n) => sum + n, 0)
    : null;

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

      <section className={styles.section} aria-labelledby="backup-title">
        <div className={styles.sectionHead}>
          <h2 className={styles.h2} id="backup-title">
            备份与导出
          </h2>
          <button type="button" className={styles.ghost} onClick={() => void loadExportStats()}>
            刷新
          </button>
        </div>
        <p className={styles.lead}>
          服务器每 6 小时自动备份一次（本机留 14 天，每周另有归档）。
          下面这个按钮是<strong>最后一道保险</strong>：把你在服务端的全部数据导出成一个 JSON 文件，
          存到本机或网盘。服务器整个没了，有这个文件也还能把数据捞回来。
        </p>
        {exportError ? (
          <p className={styles.muted}>读取服务端数据量失败（{exportError}）：离线时导出不可用，但本地待办不受影响。</p>
        ) : (
          <dl className={styles.kv}>
            {exportStats
              ? Object.entries(EXPORT_LABELS).map(([table, label]) => (
                  <div key={table}>
                    <dt>{label}</dt>
                    <dd className={styles.mono}>{exportStats[table] ?? 0}</dd>
                  </div>
                ))
              : null}
            {exportTotal !== null ? (
              <div>
                <dt>合计</dt>
                <dd className={styles.mono}>{exportTotal}</dd>
              </div>
            ) : null}
          </dl>
        )}
        <div className={styles.actions}>
          {/*
            用 <a download> 而不是 fetch：让浏览器自己处理下载，
            几 MB 的 JSON 不必先进 JS 内存再拼 Blob。
          */}
          <a className={styles.linkGhost} href="/api/export" download>
            导出全部数据（JSON）
          </a>
          <a className={styles.linkGhost} href="/api/export?inline=1" target="_blank" rel="noreferrer">
            先看一眼前面的样子
          </a>
        </div>
        <p className={styles.muted}>
          导出的文件包含已删除的待办（标记为墓碑），这样恢复时才不会出现「父任务回来了、子任务没了」。
          文件里有你的日历与打卡历史，等于一份完整的隐私副本，别丢到公开的地方。
        </p>
      </section>

      <section className={styles.section} aria-labelledby="import-title">
        <div className={styles.sectionHead}>
          <h2 className={styles.h2} id="import-title">
            批量导入任务
          </h2>
        </div>
        <TaskImporter />
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

      <SettingsCalendar />

      <SettingsDevices />

      <section className={styles.section}>
        <h2 className={styles.h2}>进度</h2>
        <ul className={styles.progress}>
          <li data-done="true">M0 认证、会话、锁定、迁移、部署脚本</li>
          <li data-done="true">M0b Outlook 授权通道（PKCE + 令牌加密落库）</li>
          <li data-done="true">M1 待办与四象限（纯本地 IndexedDB）</li>
          <li data-done="true">M2 同步内核：change_seq、操作队列、冲突解决</li>
          <li data-done="true">M3 自建日历：日/周/月/列表 + 重复规则三选项</li>
          <li data-done="true">M4 Outlook 日历：按日历 delta 增量 + 单次事件回写</li>
          <li data-done="true">M5 每日打卡：三种类型、连续天数、热力图、补卡</li>
          <li>M6 Android App（离线建任务 + 本地提醒）</li>
          <li>M7 甘特只读 + 打磨 + 备份</li>
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
