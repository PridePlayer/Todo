import { ApiError, type SessionUser } from '@grid/core';
import { useId, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import styles from './Login.module.css';

interface LoginProps {
  onSuccess: (user: SessionUser) => void;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'invalid_credentials':
      case 'locked':
        return err.message;
      case 'csrf_failed':
        return '页面状态已过期，正在刷新，请再点一次登录';
      case 'network_error':
        return '连不上服务端，请确认 API 已启动';
      case 'bad_origin':
        return '访问来源不被允许，请用 http://localhost:5173 打开';
      default:
        return err.message;
    }
  }
  return '登录失败，请稍后重试';
}

export function Login({ onSuccess }: LoginProps) {
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const emailRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    try {
      const { user } = await api.login(email, password);
      onSuccess(user);
    } catch (err) {
      setError(describeError(err));
      // csrf 失效时顺手刷新一次 token，避免用户连点两次都失败
      if (err instanceof ApiError && err.code === 'csrf_failed') {
        void api.session().catch(() => undefined);
      }
      setPending(false);
      emailRef.current?.focus();
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <p className="eyebrow">GRID · 自托管</p>

        <h1 className={styles.title}>登录</h1>
        <p className={styles.lead}>待办、日历与打卡合一。数据只存在你自己的服务器上。</p>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={emailId}>
              邮箱
            </label>
            <input
              ref={emailRef}
              id={emailId}
              className={styles.input}
              type="email"
              name="email"
              inputMode="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              placeholder="you@example.com"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={passwordId}>
              密码
            </label>
            <input
              id={passwordId}
              className={styles.input}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              placeholder="••••••••••••"
            />
          </div>

          {error ? (
            <p className={styles.error} id={errorId} role="alert">
              {error}
            </p>
          ) : null}

          <button className={styles.submit} type="submit" disabled={pending || !email || !password}>
            {pending ? '验证中…' : '登录'}
          </button>
        </form>

        <p className={styles.foot}>
          忘记密码：在服务器执行 <code className={styles.code}>pnpm reset:password --email 你的邮箱</code>
        </p>
      </div>
    </main>
  );
}
