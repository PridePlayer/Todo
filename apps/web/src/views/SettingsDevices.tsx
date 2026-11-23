import { deviceTokenState, daysLeft, type DeviceTokenInfo } from '@grid/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import styles from './SettingsDevices.module.css';

/**
 * 设备令牌（Android 端的凭据）。
 *
 * 这一块的存在感必须比看起来更强：令牌是 180 天的长效钥匙，而页面上只有
 * 一行"已登录设备"。所以这里刻意做三件事：
 *   1. 明文令牌只显示一次，且明确写出"现在不复制就再也拿不到了"——
 *      否则用户会以为下次还能看到，然后关掉页面。
 *   2. 每行都显示"最近使用"和"剩余天数"。用户据此判断哪台是废弃设备该注销，
 *      而不是靠猜设备名。
 *   3. 注销是立即生效（不等过期），文案里写清楚。
 */

const STATE_TEXT: Record<ReturnType<typeof deviceTokenState>, string> = {
  active: '有效',
  expiring: '即将到期',
  expired: '已过期',
  revoked: '已注销',
};

function fmtDate(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(ts));
}

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export function SettingsDevices() {
  const [tokens, setTokens] = useState<DeviceTokenInfo[] | null>(null);
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listDevices();
      setTokens(data.tokens);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取设备列表失败');
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className={styles.section}>
      <header className={styles.head}>
        <h2 className={styles.h2}>设备令牌</h2>
        <p className={styles.hint}>
          Android 端用这把钥匙访问数据，有效期 180 天，到期前会自动续一把新的，不需要重新输密码。
        </p>
      </header>

      <form
        className={styles.createRow}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setCopied(false);
          void api
            .createDevice(label.trim() === '' ? undefined : label.trim())
            .then(async (data) => {
              setIssued(data.token);
              setLabel('');
              await refresh();
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : '签发失败'))
            .finally(() => setBusy(false));
        }}
      >
        <input
          className={styles.input}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="设备名，例如「Pixel 8」"
          aria-label="设备名"
          maxLength={64}
        />
        <button type="submit" className={styles.primary} disabled={busy}>
          生成新令牌
        </button>
      </form>

      {issued ? (
        <div className={styles.issued}>
          <p className={styles.issuedTitle}>这是唯一一次显示，现在不复制就再也拿不到了</p>
          <div className={styles.tokenRow}>
            <code className={styles.token}>{issued}</code>
            <button
              type="button"
              className={styles.ghost}
              onClick={() => {
                void navigator.clipboard?.writeText(issued).then(() => setCopied(true));
              }}
            >
              {copied ? '已复制' : '复制'}
            </button>
            <button type="button" className={styles.ghost} onClick={() => setIssued(null)}>
              关闭
            </button>
          </div>
          <p className={styles.issuedHint}>
            服务端只保存它的 SHA-256，所以无法再还原。填到 App 的登录框里即可，之后不必再输密码。
          </p>
        </div>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}

      {tokens === null ? (
        <p className={styles.hint}>读取中…</p>
      ) : tokens.length === 0 ? (
        <p className={styles.hint}>还没有任何设备令牌。上面的按钮生成一把，填进 App 就行。</p>
      ) : (
        <ul className={styles.list}>
          {tokens.map((token) => {
            const state = deviceTokenState(token);
            const left = daysLeft(token.expiresAt);
            return (
              <li key={token.id} className={styles.row} data-state={state}>
                <span className={styles.label}>{token.label}</span>
                <span className={styles.meta}>
                  签发 {fmtDate(token.createdAt)} · 最近使用{' '}
                  {state === 'revoked' ? '—' : fmtRelative(token.lastSeenAt)}
                </span>
                <span className={styles.state} data-state={state}>
                  {STATE_TEXT[state]}
                  {state === 'active' || state === 'expiring' ? ` · 剩 ${left} 天` : ''}
                </span>
                {state === 'revoked' || state === 'expired' ? (
                  <button
                    type="button"
                    className={styles.ghost}
                    title="这条令牌已经不能用了，移除只是清理列表"
                    onClick={() => void api.revokeDevice(token.id, true).then(refresh)}
                  >
                    移除记录
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.ghost}
                    onClick={() => {
                      if (!window.confirm(`注销「${token.label}」？该设备会立刻失去访问权限。`)) return;
                      void api.revokeDevice(token.id).then(refresh);
                    }}
                  >
                    注销此设备
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
