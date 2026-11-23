import type { SessionUser } from '@grid/core';
import { useEffect, useState } from 'react';
import { useSyncStatus } from '../hooks/useSync';
import { startAutoSync, syncNow, type SyncStatus } from '../sync/engine';
import { AllTasksView } from '../views/AllTasks';
import { CalendarView } from '../views/calendar/CalendarView';
import { QuadrantView } from '../views/Quadrant';
import { Settings } from '../views/Settings';
import styles from './AppShell.module.css';

type ViewKey = 'quadrant' | 'calendar' | 'all' | 'settings';

const VIEWS: { key: ViewKey; label: string; title: string; path: string }[] = [
  {
    key: 'quadrant',
    label: '四象限',
    title: '四象限',
    path: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  },
  {
    key: 'calendar',
    label: '日历',
    title: '日历',
    path: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  },
  {
    key: 'all',
    label: '全部待办',
    title: '全部待办',
    path: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  },
  {
    key: 'settings',
    label: '设置',
    title: '设置',
    path: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 006 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 14.6H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 8a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 009 3.1V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8v.1a1.6 1.6 0 001.5 1h.1a2 2 0 110 4H21a1.6 1.6 0 00-1.5 1z',
  },
];

interface AppShellProps {
  user: SessionUser;
  onLogout: () => void;
}

function todayLabel(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date());
}

/**
 * 顶栏同步胶囊。
 *
 * 文案优先级刻意如此：离线且有待推送 > 同步中 > 失败 > 有待推送 > 已同步。
 * "离线"必须压过"待同步"——只说"3 条待同步"会让人以为网络正常、只是在排队，
 * 而用户此刻真正需要知道的是"这些改动一台服务器都没到"。
 */
function syncLabel(status: SyncStatus): { text: string; state: string } {
  if (status.phase === 'syncing') return { text: '同步中…', state: 'busy' };
  if (status.phase === 'offline') {
    return {
      text: status.pending > 0 ? `离线 · ${status.pending} 条待同步` : '离线',
      state: 'warn',
    };
  }
  if (status.phase === 'error') return { text: status.message ?? '同步失败', state: 'warn' };
  if (status.pending > 0) return { text: `${status.pending} 条待同步`, state: 'warn' };
  if (status.failed > 0) return { text: `${status.failed} 条被拒`, state: 'warn' };
  return { text: '已同步', state: 'ok' };
}

function SyncPill() {
  const status = useSyncStatus();
  const { text, state } = syncLabel(status);
  return (
    <button
      type="button"
      className={styles.pill}
      data-state={state}
      title={status.lastSyncAt ? `上次同步：${new Date(status.lastSyncAt).toLocaleTimeString('zh-CN')}` : '尚未同步'}
      onClick={() => void syncNow()}
    >
      {text}
    </button>
  );
}

export function AppShell({ user, onLogout }: AppShellProps) {
  const [view, setView] = useState<ViewKey>('quadrant');
  const status = useSyncStatus();
  const active = VIEWS.find((item) => item.key === view) ?? VIEWS[0]!;

  // 自动同步的生命周期跟着登录态走：登出后引擎必须停，否则清空本地库之后
  // 30 秒心跳还会拿着已失效的会话去撞接口
  useEffect(() => startAutoSync(), []);

  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="主导航">
        <span className={styles.logo} aria-hidden="true" />
        {VIEWS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={item.key === view ? `${styles.railBtn} ${styles.railOn}` : styles.railBtn}
            aria-label={item.label}
            aria-current={item.key === view ? 'page' : undefined}
            title={item.label}
            onClick={() => setView(item.key)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={item.path} />
            </svg>
          </button>
        ))}
      </nav>

      <div className={styles.body}>
        <header className={styles.topbar}>
          <h1 className={styles.topTitle}>{active.title}</h1>
          <span className={styles.date}>{todayLabel()}</span>
          <div className={styles.topRight}>
            <SyncPill />
            {status.conflicts > 0 ? (
              <button
                type="button"
                className={styles.pill}
                data-state="warn"
                title="字段级冲突待裁决，点开处理"
                onClick={() => setView('settings')}
              >
                {status.conflicts} 处冲突
              </button>
            ) : null}
            <span className={styles.email} title={user.email}>
              {user.email}
            </span>
            <button type="button" className={styles.ghost} onClick={onLogout}>
              登出
            </button>
          </div>
        </header>

        <main className={styles.content}>
          {view === 'quadrant' ? <QuadrantView /> : null}
          {view === 'calendar' ? <CalendarView /> : null}
          {view === 'all' ? <AllTasksView /> : null}
          {view === 'settings' ? <Settings user={user} /> : null}
        </main>

        <nav className={styles.mobtab} aria-label="底部导航">
          {VIEWS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={styles.mobBtn}
              data-on={item.key === view}
              aria-current={item.key === view ? 'page' : undefined}
              onClick={() => setView(item.key)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={item.path} />
              </svg>
              {item.label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
