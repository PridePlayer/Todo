import type { SessionUser } from '@grid/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import styles from './app.module.css';
import { clearClientState } from './logout';
import { Home } from './views/Home';
import { Login } from './views/Login';

type BootState =
  | { status: 'loading' }
  | { status: 'anon' }
  | { status: 'auth'; user: SessionUser }
  | { status: 'error'; message: string };

export function App() {
  const [boot, setBoot] = useState<BootState>({ status: 'loading' });

  const restore = useCallback(async () => {
    setBoot({ status: 'loading' });
    try {
      const { user } = await api.session();
      setBoot(user ? { status: 'auth', user } : { status: 'anon' });
    } catch {
      setBoot({ status: 'error', message: '连不上服务端，请确认 API 已启动' });
    }
  }, []);

  useEffect(() => {
    void restore();
  }, [restore]);

  const handleLoggedIn = useCallback((user: SessionUser) => {
    setBoot({ status: 'auth', user });
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 服务端已挂掉也必须完成本地清理，否则等于没登出
    }
    await clearClientState();
    setBoot({ status: 'anon' });
  }, []);

  if (boot.status === 'loading') {
    return (
      <div className={styles.center} role="status" aria-live="polite">
        <span className={styles.spinner} aria-hidden="true" />
        <span>载入中</span>
      </div>
    );
  }

  if (boot.status === 'error') {
    return (
      <div className={styles.center}>
        <p className={styles.bootError}>{boot.message}</p>
        <button type="button" className={styles.retry} onClick={() => void restore()}>
          重试
        </button>
      </div>
    );
  }

  if (boot.status === 'anon') {
    return <Login onSuccess={handleLoggedIn} />;
  }

  return <Home user={boot.user} onLogout={() => void handleLogout()} />;
}
