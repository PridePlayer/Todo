import type { SessionUser } from '@grid/core';
import { useCallback, useEffect, useState } from 'react';
import styles from './Home.module.css';

interface HomeProps {
  user: SessionUser;
  onLogout: () => void;
}

interface Health {
  ok: boolean;
  db: 'up' | 'down';
  driver: string;
  rssMB: number;
  uptimeS: number;
  version: string;
}

const CHECKS = [
  { label: '邮箱密码登录', detail: 'argon2id 校验，会话写进 HttpOnly Cookie，前端拿不到会话值' },
  { label: '刷新保持登录', detail: '服务端只存会话 id 的 SHA-256，30 天滑动续期、90 天绝对上限' },
  { label: '连错 5 次锁定 10 分钟', detail: '失败计数落库，重启服务不会清零' },
  { label: '登出清理本地数据', detail: '删掉全部 IndexedDB 库 + localStorage + sessionStorage' },
];

const NEXT_SLICE = [
  '四象限拖拽（Alt+↑ 键盘迁移）',
  '三层子任务与撤销',
  '快速新增：按 N 连续录入',
  '全部待办列表 + 筛选排序',
];

const RAIL_ITEMS = [
  { key: 'today', label: '今天', path: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4' },
  { key: 'quad', label: '四象限', path: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z' },
  { key: 'calendar', label: '日历', path: 'M3 4h18v17H3zM3 9h18' },
  { key: 'habits', label: '打卡', path: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2' },
  { key: 'all', label: '全部待办', path: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' },
];

function todayLabel(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date());
}

export function Home({ user, onLogout }: HomeProps) {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const probe = useCallback(async () => {
    setProbing(true);
    try {
      const res = await fetch('/api/healthz', { headers: { accept: 'application/json' } });
      const body = (await res.json()) as Health;
      setHealth(body);
      setHealthError(null);
    } catch {
      setHealth(null);
      setHealthError('探活失败');
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="主导航">
        <span className={styles.logo} aria-hidden="true" />
        {RAIL_ITEMS.map((item, index) => (
          <button
            key={item.key}
            type="button"
            className={index === 0 ? `${styles.railBtn} ${styles.railOn}` : styles.railBtn}
            aria-label={item.label}
            aria-current={index === 0 ? 'page' : undefined}
            disabled={index !== 0}
            title={index === 0 ? item.label : `${item.label}（M1 起可用）`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={item.path} />
            </svg>
          </button>
        ))}
      </nav>

      <div className={styles.body}>
        <header className={styles.topbar}>
          <h1 className={styles.topTitle}>今天</h1>
          <span className={styles.date}>{todayLabel()}</span>
          <div className={styles.topRight}>
            <span className={styles.pill} data-state={health?.ok ? 'ok' : 'warn'}>
              {health?.ok ? '已连接' : healthError ? '服务异常' : '探活中'}
            </span>
            <span className={styles.email} title={user.email}>
              {user.email}
            </span>
            <button type="button" className={styles.ghost} onClick={onLogout}>
              登出
            </button>
          </div>
        </header>

        <main className={styles.main}>
          <p className="eyebrow">M0 · 地基</p>
          <h2 className={styles.h2}>骨架已就绪</h2>
          <p className={styles.lead}>
            这一片只做「能登录的空壳」：认证、会话、锁定、迁移、部署链路全部打通。
            待办、日历、打卡从下一片开始，不会出现「后端做完但界面上看不见」的情况。
          </p>

          <section className={styles.section} aria-labelledby="checks-title">
            <h3 className={styles.h3} id="checks-title">
              本片验收项
            </h3>
            <ul className={styles.checks}>
              {CHECKS.map((item) => (
                <li key={item.label} className={styles.check}>
                  <span className={styles.tick} aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M4 12.5l5 5L20 6.5" />
                    </svg>
                  </span>
                  <span>
                    <strong className={styles.checkLabel}>{item.label}</strong>
                    <span className={styles.checkDetail}>{item.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.section} aria-labelledby="health-title">
            <div className={styles.sectionHead}>
              <h3 className={styles.h3} id="health-title">
                服务端探活
              </h3>
              <button type="button" className={styles.ghost} onClick={() => void probe()} disabled={probing}>
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
              <p className={styles.muted}>{healthError ?? '正在探测…'}</p>
            )}
          </section>

          <section className={styles.section} aria-labelledby="next-title">
            <h3 className={styles.h3} id="next-title">
              下一片 M1 · 待办与四象限（纯本地）
            </h3>
            <ul className={styles.next}>
              {NEXT_SLICE.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className={styles.muted}>M1 不碰网络，数据只进 IndexedDB，先把交互手感做对。</p>
          </section>
        </main>
      </div>
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
