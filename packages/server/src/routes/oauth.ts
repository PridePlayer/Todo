import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { resolveSession } from '../auth/session.js';
import { verifyCsrfToken } from '../auth/csrf.js';
import type { Db } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { HttpError } from '../http/errors.js';
import {
  buildAuthorizeUrl,
  codeChallengeOf,
  createCodeVerifier,
  exchangeCode,
  fetchMe,
  GraphError,
  OAuthError,
  refreshAccessToken,
  type MicrosoftConfig,
} from '../oauth/microsoft.js';
import { TokenCipher } from '../oauth/token-cipher.js';
import {
  consumeState,
  createState,
  deleteAccount,
  deleteExpiredStates,
  findAccountByUser,
  markNeedsReauth,
  num,
  saveTokens,
  touchVerified,
  upsertAccount,
} from '../repo/oauth.js';
import { randomToken, sha256Hex, ulid } from '../util/crypto.js';

export interface OAuthOptions {
  db: Db;
  env: AppEnv;
}

/** state 有效期。够走完微软登录，又不至于长期留在表里。 */
const STATE_TTL_MS = 10 * 60 * 1000;

export const oauthRoutes: FastifyPluginAsync<OAuthOptions> = async (app, opts) => {
  const { db, env } = opts;

  const cfg: MicrosoftConfig | null = env.oauth.enabled
    ? {
        clientId: env.oauth.clientId,
        clientSecret: env.oauth.clientSecret,
        tenant: env.oauth.tenant,
        redirectUri: env.oauth.redirectUri,
        scopes: env.oauth.scopes,
      }
    : null;
  const cipher = env.oauth.encKey ? new TokenCipher(env.oauth.encKey) : null;

  /** 三个浏览器导航型接口（start / callback）出错时必须跳回前端，不能吐 JSON */
  function backToApp(reply: FastifyReply, reason: string): FastifyReply {
    return reply.redirect(`${env.appOrigin}/?ms=error&reason=${encodeURIComponent(reason)}`);
  }

  async function currentUserId(req: FastifyRequest): Promise<string> {
    const raw = req.cookies[env.cookieName];
    const userId = typeof raw === 'string' ? await resolveSession(db, raw, env.sessionTtlMs) : null;
    if (!userId) throw new HttpError(401, 'unauthenticated', '登录已过期，请重新登录');
    return userId;
  }

  function requireReady(): { cfg: MicrosoftConfig; cipher: TokenCipher } {
    if (!cfg || !cipher) {
      throw new HttpError(
        503,
        'oauth_not_configured',
        '服务端未配置 Microsoft OAuth：请在 .env 填写 MS_CLIENT_ID、MS_CLIENT_SECRET、TOKEN_ENC_KEY 后重启',
      );
    }
    return { cfg, cipher };
  }

  /**
   * Graph 调用失败必须翻译成业务错误。
   * 不翻译的后果是：令牌被撤销时用户看到「服务端异常，请查看服务日志」——
   * 他会以为是自家后端的 bug，而真正该做的是点「重新授权」。
   */
  async function callGraph<T>(fn: () => Promise<T>, db: Db, userId: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GraphError) {
        if (err.status === 401 || err.status === 403) {
          await markNeedsReauth(db, userId, `Graph ${err.status}: ${err.graphCode}`);
          throw new HttpError(409, 'reauth_required', '微软侧拒绝了当前令牌（可能已被撤销或权限被收回），请重新连接 Outlook');
        }
        if (err.status === 429) {
          throw new HttpError(503, 'graph_rate_limited', '微软接口限流，请稍后再试', err.retryAfterSec ?? 30);
        }
        if (err.status === 0) {
          throw new HttpError(504, 'graph_unreachable', '服务器连不上 Microsoft Graph，请检查出站网络');
        }
        throw new HttpError(502, 'graph_error', `读取账户信息失败（${err.graphCode}），请稍后重试`);
      }
      throw err;
    }
  }

  // ───────────────────────── 状态查询 ─────────────────────────
  app.get('/oauth/microsoft', async (req) => {
    // 未登录也返回结构，前端据此决定渲染「请先登录」还是「去连接」
    const raw = req.cookies[env.cookieName];
    const userId = typeof raw === 'string' ? await resolveSession(db, raw, env.sessionTtlMs) : null;

    if (!userId) {
      return {
        configured: env.oauth.enabled,
        scopes: env.oauth.scopes,
        account: null,
      };
    }

    const row = await findAccountByUser(db, userId);
    return {
      configured: env.oauth.enabled,
      scopes: env.oauth.scopes,
      account: row
        ? {
            email: row.email ?? row.display_name ?? row.account_id,
            displayName: row.display_name,
            accountId: row.account_id,
            status: row.status,
            scope: row.scope,
            tokenExpiresAt: num(row.token_expires_at),
            lastVerifiedAt: num(row.last_verified_at),
            lastError: row.last_error,
            connectedAt: num(row.created_at),
          }
        : null,
    };
  });

  // ───────────────────────── 第一步：跳微软 ─────────────────────────
  app.get('/oauth/microsoft/start', async (req, reply) => {
    if (!cfg || !cipher) return backToApp(reply, 'not_configured');

    const raw = req.cookies[env.cookieName];
    const userId = typeof raw === 'string' ? await resolveSession(db, raw, env.sessionTtlMs) : null;
    // 这里是顶层导航，用户可能在新标签页直接打开这个地址，所以跳回登录而不是 401
    if (!userId) return backToApp(reply, 'unauthenticated');

    const state = randomToken(32);
    const codeVerifier = createCodeVerifier();

    await deleteExpiredStates(db);
    await createState(db, {
      stateHash: sha256Hex(state),
      userId,
      codeVerifier,
      redirectUri: cfg.redirectUri,
      ttlMs: STATE_TTL_MS,
    });

    req.log.info({ userId, redirectUri: cfg.redirectUri, scopes: cfg.scopes }, 'oauth start');
    return reply.redirect(buildAuthorizeUrl(cfg, { state, codeChallenge: codeChallengeOf(codeVerifier) }));
  });

  // ───────────────────────── 第二步：微软回调 ─────────────────────────
  /**
   * 这个路由是 GET 且由微软跳转过来，带不了 CSRF 头。
   * 防重放完全依赖 state：一次性、10 分钟过期、只存 SHA-256。
   */
  app.get('/oauth/microsoft/callback', async (req, reply) => {
    if (!cfg || !cipher) return backToApp(reply, 'not_configured');

    const q = req.query as Record<string, string | undefined>;

    // 先把 state 消费掉再判断其他分支：微软无论是成功还是拒绝，都会原样带回 state。
    // 若把 error 判断放在前面，用户点「取消」后这条 state 会一直留到 10 分钟过期。
    const state = q.state;
    if (typeof state !== 'string' || state === '') {
      return backToApp(reply, 'missing_params');
    }

    const row = await consumeState(db, sha256Hex(state));
    if (!row) return backToApp(reply, 'state_invalid');
    if ((num(row.expires_at) ?? 0) <= Date.now()) return backToApp(reply, 'state_expired');

    // 发起授权的人与当前浏览器会话必须是同一个，否则会把日历绑到另一个账号上
    const rawSession = req.cookies[env.cookieName];
    const sessionUserId =
      typeof rawSession === 'string' ? await resolveSession(db, rawSession, env.sessionTtlMs) : null;
    if (sessionUserId !== row.user_id) return backToApp(reply, 'session_changed');

    if (q.error) {
      // 只映射成固定短码，绝不把 error_description 回显到 URL（可能被注入到页面文本）
      req.log.warn({ error: q.error }, 'oauth callback returned error');
      return backToApp(reply, q.error === 'access_denied' ? 'denied' : 'consent_failed');
    }

    const code = q.code;
    if (typeof code !== 'string' || code === '') return backToApp(reply, 'missing_params');

    let tokens;
    try {
      tokens = await exchangeCode(cfg, { code, codeVerifier: row.code_verifier });
    } catch (err) {
      req.log.error({ err: err instanceof Error ? err.message : err }, 'oauth code exchange failed');
      return backToApp(reply, err instanceof OAuthError ? 'code_rejected' : 'exchange_failed');
    }

    let me;
    try {
      me = await fetchMe(tokens.accessToken);
    } catch (err) {
      req.log.error({ err: err instanceof Error ? err.message : err }, 'graph /me failed after exchange');
      // 拿到 token 但读不了 /me：多半是权限未授予（管理员未同意），仍然存下来但标记异常
      return backToApp(reply, 'graph_failed');
    }

    await upsertAccount(db, {
      id: ulid(),
      userId: row.user_id,
      accountId: me.id,
      email: me.mail ?? me.userPrincipalName,
      displayName: me.displayName,
      tenantId: null,
      scope: tokens.scope,
      accessTokenEnc: cipher.encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? cipher.encrypt(tokens.refreshToken) : null,
      tokenExpiresAt: tokens.expiresAt,
    });

    req.log.info(
      { userId: row.user_id, accountId: me.id, hasRefresh: Boolean(tokens.refreshToken) },
      'oauth connected',
    );
    return reply.redirect(`${env.appOrigin}/?ms=connected`);
  });

  // ───────────────────────── 断开 ─────────────────────────
  app.post('/oauth/microsoft/disconnect', async (req, reply) => {
    if (!verifyCsrfToken(req)) throw new HttpError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
    const userId = await currentUserId(req);
    await deleteAccount(db, userId);
    req.log.info({ userId }, 'oauth disconnected');
    return reply.status(204).send();
  });

  // ───────────────────────── 验活：证明令牌真的能用 ─────────────────────────
  /**
   * 与「有没有记录」不同，这个接口真的拿 token 去请求一次 Graph。
   * 令牌快过期时先静默刷新，刷新失败才要求重新授权。
   */
  app.get('/oauth/microsoft/verify', async (req) => {
    const { cfg: readyCfg, cipher: readyCipher } = requireReady();
    const userId = await currentUserId(req);

    const account = await findAccountByUser(db, userId);
    if (!account) throw new HttpError(404, 'not_connected', '尚未连接 Microsoft 账号');

    const expiresAt = num(account.token_expires_at) ?? 0;
    let accessToken = readyCipher.decrypt(account.access_token_enc);
    let refreshed = false;

    if (expiresAt <= Date.now() + 60_000) {
      if (!account.refresh_token_enc) {
        await markNeedsReauth(db, userId, 'access token 已过期且没有 refresh token');
        throw new HttpError(409, 'reauth_required', '授权已过期，请重新连接 Outlook');
      }
      try {
        const next = await refreshAccessToken(readyCfg, readyCipher.decrypt(account.refresh_token_enc));
        accessToken = next.accessToken;
        await saveTokens(db, userId, {
          accessTokenEnc: readyCipher.encrypt(next.accessToken),
          refreshTokenEnc: next.refreshToken ? readyCipher.encrypt(next.refreshToken) : null,
          tokenExpiresAt: next.expiresAt,
          scope: next.scope || null,
        });
        refreshed = true;
        req.log.info({ userId }, 'oauth access token refreshed');
      } catch (err) {
        const reauth = err instanceof OAuthError && err.requiresReauth;
        await markNeedsReauth(db, userId, err instanceof Error ? err.message : 'refresh failed');
        req.log.warn({ userId, reauth }, 'oauth refresh failed');
        throw new HttpError(
          409,
          'reauth_required',
          reauth ? '授权已失效，请重新连接 Outlook' : '刷新令牌失败，请稍后重试或重新连接',
        );
      }
    }

    const me = await callGraph(() => fetchMe(accessToken), db, userId);
    await touchVerified(db, userId);

    const after = await findAccountByUser(db, userId);
    return {
      ok: true,
      refreshed,
      me: { id: me.id, email: me.mail ?? me.userPrincipalName, displayName: me.displayName },
      tokenExpiresAt: after ? num(after.token_expires_at) : null,
    };
  });
};
