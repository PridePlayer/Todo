import {
  ApiError,
  OAUTH_REASON_TEXT,
  type OAuthCallbackReason,
  type OAuthStatus,
  type OAuthVerifyResult,
} from '@grid/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import styles from './OutlookPanel.module.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: OAuthStatus };

type Notice = { kind: 'ok' | 'warn' | 'err'; text: string };

/**
 * Outlook 连接面板。
 *
 * 这个组件存在的意义：后端即使已经能存令牌，用户也必须能在界面上看见
 * 「连了没有、连的是哪个账号、令牌还能不能真的用」。所以它有一个
 * 「验证令牌」按钮，会真的去请求一次 Graph /me，而不是只看数据库里有没有行。
 */
export function OutlookPanel() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<'verify' | 'disconnect' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [verified, setVerified] = useState<OAuthVerifyResult | null>(null);

  const refresh = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const data = await api.oauthStatus();
      setLoad({ status: 'ready', data });
    } catch (err) {
      setLoad({ status: 'error', message: describe(err) });
    }
  }, []);

  useEffect(() => {
    // 回调会带着 ?ms=connected 或 ?ms=error&reason=... 跳回来。
    // 读一次就清洗掉，否则刷新页面会重复提示。
    const params = new URLSearchParams(window.location.search);
    const ms = params.get('ms');
    if (ms === 'connected') {
      setNotice({ kind: 'ok', text: 'Outlook 已连接，令牌已加密落库' });
    } else if (ms === 'error') {
      const reason = params.get('reason') ?? '';
      const known = reason in OAUTH_REASON_TEXT;
      setNotice({
        kind: 'err',
        text: known ? OAUTH_REASON_TEXT[reason as OAuthCallbackReason] : `连接失败（${reason || '未知原因'}）`,
      });
    }
    if (ms) {
      params.delete('ms');
      params.delete('reason');
      const qs = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
    void refresh();
  }, [refresh]);

  const handleVerify = useCallback(async () => {
    setBusy('verify');
    setNotice(null);
    try {
      const result = await api.verifyMicrosoft();
      setVerified(result);
      setNotice({
        kind: 'ok',
        text: result.refreshed
          ? '令牌已自动刷新，并成功读取到账户信息'
          : '令牌可用，已成功读取到账户信息',
      });
      await refresh();
    } catch (err) {
      const reauth = err instanceof ApiError && err.code === 'reauth_required';
      setNotice({ kind: 'err', text: reauth ? '授权已失效，请重新连接 Outlook' : describe(err) });
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleDisconnect = useCallback(async () => {
    setBusy('disconnect');
    setNotice(null);
    try {
      await api.disconnectMicrosoft();
      setConfirming(false);
      setVerified(null);
      setNotice({ kind: 'warn', text: '已断开连接，服务端令牌已删除。微软侧的日历事件没有被改动' });
      await refresh();
    } catch (err) {
      setNotice({ kind: 'err', text: describe(err) });
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  return (
    <section className={styles.wrap} aria-labelledby="outlook-title">
      <div className={styles.head}>
        <h3 className={styles.title} id="outlook-title">
          Outlook 日历
        </h3>
        <StatusPill load={load} />
      </div>

      {notice ? (
        <p className={styles.notice} data-kind={notice.kind} role="status" aria-live="polite">
          {notice.text}
        </p>
      ) : null}

      {load.status === 'loading' ? <p className={styles.muted}>正在读取连接状态…</p> : null}

      {load.status === 'error' ? (
        <div className={styles.muted}>
          {load.message}
          <button type="button" className={styles.ghost} onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : null}

      {load.status === 'ready' && !load.data.configured ? (
        <NotConfigured />
      ) : null}

      {load.status === 'ready' && load.data.configured && !load.data.account ? (
        <div>
          <p className={styles.desc}>
            连接后可在本工具内查看、新建、修改 Outlook 日历事件。只申请三项权限：
            <code className={styles.code}>User.Read</code>
            <code className={styles.code}>Calendars.ReadWrite</code>
            <code className={styles.code}>offline_access</code>
            ，不读邮件、不读联系人。
          </p>
          <a className={styles.primary} href={api.microsoftConnectUrl()}>
            连接 Outlook
          </a>
        </div>
      ) : null}

      {load.status === 'ready' && load.data.account ? (
        <div>
          {/* 邮箱单独一行：塞进四列键值格时，长邮箱会在 @ 前被硬断成两截 */}
          <div className={styles.accountRow}>
            <span className={styles.accountLabel}>账号</span>
            <span className={styles.accountValue} title={load.data.account.email}>
              {load.data.account.email}
            </span>
          </div>

          <dl className={styles.facts}>
            <div>
              <dt>账号状态</dt>
              <dd data-state={load.data.account.status}>{statusText(load.data.account.status)}</dd>
            </div>
            <div>
              <dt>访问令牌</dt>
              <dd className={styles.mono}>{expiryText(load.data.account.tokenExpiresAt)}</dd>
            </div>
            <div>
              <dt>上次验活</dt>
              <dd className={styles.mono}>{clockText(load.data.account.lastVerifiedAt)}</dd>
            </div>
          </dl>

          {load.data.account.lastError ? (
            <p className={styles.lastError}>最近一次错误：{load.data.account.lastError}</p>
          ) : null}

          {verified ? (
            <p className={styles.muted}>
              最近一次验活读到：{verified.me.displayName ?? '（无显示名）'}
              {verified.me.email ? ` · ${verified.me.email}` : ''}
            </p>
          ) : null}

          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => void handleVerify()} disabled={busy !== null}>
              {busy === 'verify' ? '验证中…' : '验证令牌'}
            </button>
            <a className={styles.ghostBtn} href={api.microsoftConnectUrl()}>
              重新授权
            </a>
            {confirming ? (
              <>
                <button
                  type="button"
                  className={styles.danger}
                  onClick={() => void handleDisconnect()}
                  disabled={busy !== null}
                >
                  {busy === 'disconnect' ? '断开中…' : '确认断开'}
                </button>
                <button type="button" className={styles.ghostBtn} onClick={() => setConfirming(false)}>
                  取消
                </button>
              </>
            ) : (
              <button type="button" className={styles.ghostBtn} onClick={() => setConfirming(true)}>
                断开
              </button>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StatusPill({ load }: { load: LoadState }) {
  let text = '读取中';
  let state = 'idle';
  if (load.status === 'error') {
    text = '状态未知';
    state = 'err';
  } else if (load.status === 'ready') {
    if (!load.data.configured) {
      text = '未配置';
      state = 'idle';
    } else if (load.data.account) {
      text = load.data.account.status === 'active' ? '已连接' : '需重新授权';
      state = load.data.account.status === 'active' ? 'ok' : 'warn';
    } else {
      text = '未连接';
      state = 'idle';
    }
  }
  return (
    <span className={styles.pill} data-state={state}>
      {text}
    </span>
  );
}

function NotConfigured() {
  return (
    <div>
      <p className={styles.desc}>
        服务端还没填 Microsoft 应用凭据，所以这里不能发起授权。它不影响登录、待办与打卡。
      </p>
      <ol className={styles.steps}>
        <li>
          在 Azure 门户注册应用，重定向 URI 填 <code className={styles.code}>/api/oauth/microsoft/callback</code> 的完整地址
        </li>
        <li>
          把 <code className={styles.code}>MS_CLIENT_ID</code>、<code className={styles.code}>MS_CLIENT_SECRET</code> 写进服务器{' '}
          <code className={styles.code}>.env</code>
        </li>
        <li>
          生成 <code className={styles.code}>TOKEN_ENC_KEY</code>：<code className={styles.code}>openssl rand -base64 32</code>
        </li>
        <li>重启服务，刷新本页</li>
      </ol>
    </div>
  );
}

function statusText(status: string): string {
  if (status === 'active') return '正常';
  if (status === 'needs_reauth') return '需要重新授权';
  if (status === 'revoked') return '已撤销';
  return status;
}

function clockText(epochMs: number | null): string {
  if (!epochMs) return '从未';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs));
}

function expiryText(epochMs: number | null): string {
  if (!epochMs) return '未知';
  const diffMin = Math.round((epochMs - Date.now()) / 60000);
  if (diffMin <= 0) return '已过期';
  if (diffMin < 60) return `${diffMin} 分钟后过期`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return `${hours} 小时${mins > 0 ? ` ${mins} 分` : ''}后过期`;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return '未知错误';
}
