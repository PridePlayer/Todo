import type { Db } from '../db/types.js';
import { GraphError, OAuthError, refreshAccessToken, type MicrosoftConfig } from '../oauth/microsoft.js';
import type { TokenCipher } from '../oauth/token-cipher.js';
import { findAccountByUser, markNeedsReauth, num, saveTokens, type OauthAccountRow } from '../repo/oauth.js';

/**
 * 令牌管家：取 access token，必要时静默刷新。
 *
 * 关键点是**单飞**（single-flight）：同一用户在同一时刻只允许有一次刷新在飞。
 * 没有这层保护时，定时轮询、用户点"立即同步"、回写队列三方会同时发现令牌过期，
 * 各发一次 refresh。微软会轮换 refresh token，于是后两次用旧 token 刷新直接
 * 拿到 invalid_grant——用户看到"授权失效"，而实际只是自己并发刷新把令牌作废了。
 */

export class NotConnectedError extends Error {
  constructor() {
    super('尚未连接 Microsoft 账号');
    this.name = 'NotConnectedError';
  }
}

export class ReauthRequiredError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super('Outlook 授权已失效，需要重新连接');
    this.name = 'ReauthRequiredError';
    this.reason = reason;
  }
}

/** 提前 5 分钟刷新：宁可多刷一次，也不要在请求飞出去的瞬间过期 */
const REFRESH_AHEAD_MS = 5 * 60 * 1000;

export class GraphTokens {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly db: Db,
    private readonly cfg: MicrosoftConfig,
    private readonly cipher: TokenCipher,
  ) {}

  async accountFor(userId: string): Promise<OauthAccountRow> {
    const account = await findAccountByUser(this.db, userId);
    if (!account) throw new NotConnectedError();
    return account;
  }

  async accessTokenFor(userId: string): Promise<string> {
    const pending = this.inflight.get(userId);
    if (pending) return pending;

    const task = this.resolve(userId).finally(() => this.inflight.delete(userId));
    this.inflight.set(userId, task);
    return task;
  }

  private async resolve(userId: string): Promise<string> {
    const account = await this.accountFor(userId);
    if (account.status === 'needs_reauth') {
      throw new ReauthRequiredError(account.last_error ?? '授权需要重新确认');
    }

    const expiresAt = num(account.token_expires_at) ?? 0;
    if (expiresAt > Date.now() + REFRESH_AHEAD_MS) {
      return this.cipher.decrypt(account.access_token_enc);
    }

    if (!account.refresh_token_enc) {
      await markNeedsReauth(this.db, userId, 'access token 已过期且没有 refresh token');
      throw new ReauthRequiredError('授权已过期，且没有可用于续期的 refresh token');
    }

    try {
      const next = await refreshAccessToken(this.cfg, this.cipher.decrypt(account.refresh_token_enc));
      await saveTokens(this.db, userId, {
        accessTokenEnc: this.cipher.encrypt(next.accessToken),
        refreshTokenEnc: next.refreshToken ? this.cipher.encrypt(next.refreshToken) : null,
        tokenExpiresAt: next.expiresAt,
        scope: next.scope || null,
      });
      return next.accessToken;
    } catch (err) {
      const reauth = err instanceof OAuthError && err.requiresReauth;
      const reason = err instanceof Error ? err.message : '刷新令牌失败';
      await markNeedsReauth(this.db, userId, reason);
      if (reauth) throw new ReauthRequiredError(reason);
      throw err;
    }
  }

  /**
   * 把 Graph 抛上来的 401/403 翻译成"需要重新授权"。
   * 令牌被用户在微软侧撤销时，Graph 返回的是 401，而 token 本身还没到本地记录的过期时间，
   * 所以只能靠这一次真实请求发现。
   */
  async translate<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GraphError && (err.status === 401 || err.status === 403)) {
        await markNeedsReauth(this.db, userId, `Graph ${err.status}: ${err.graphCode}`);
        throw new ReauthRequiredError(`Graph ${err.status}: ${err.graphCode}`);
      }
      throw err;
    }
  }
}
