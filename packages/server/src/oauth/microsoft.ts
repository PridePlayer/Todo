import { createHash, randomBytes } from 'node:crypto';

/**
 * Microsoft identity platform v2.0 端点。
 * tenant 用 `common` 时同时支持个人 Microsoft 账号与工作/学校账号；
 * 若要限定单租户，把 MS_TENANT 改成租户 id 或域名。
 */
const AUTHORITY = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** 单次请求的超时。Graph 偶发挂住，不设超时会把 worker 的并发槽全占死。 */
const HTTP_TIMEOUT_MS = 15_000;

export interface MicrosoftConfig {
  clientId: string;
  clientSecret: string;
  tenant: string;
  redirectUri: string;
  scopes: string[];
}

export interface TokenSet {
  accessToken: string;
  /** 微软只在带 offline_access 时下发；轮换时可能为空，调用方需保留旧值 */
  refreshToken: string | null;
  /** epoch ms，已扣除 60s 安全余量，避免「取出即过期」 */
  expiresAt: number;
  scope: string;
  tokenType: string;
}

export class OAuthError extends Error {
  /** 微软返回的 error 字段，如 invalid_grant / invalid_client / interaction_required */
  readonly oauthCode: string;
  /** need_reauth 表示 refresh token 已失效，必须让用户重新授权 */
  readonly requiresReauth: boolean;

  constructor(message: string, oauthCode: string) {
    super(message);
    this.name = 'OAuthError';
    this.oauthCode = oauthCode;
    this.requiresReauth =
      oauthCode === 'invalid_grant' ||
      oauthCode === 'interaction_required' ||
      oauthCode === 'consent_required' ||
      oauthCode === 'invalid_client';
  }
}

export class GraphError extends Error {
  readonly status: number;
  readonly graphCode: string;
  readonly retryAfterSec: number | undefined;

  constructor(message: string, status: number, graphCode: string, retryAfterSec?: number) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.graphCode = graphCode;
    this.retryAfterSec = retryAfterSec;
  }
}

/** PKCE 的 code_verifier：43~128 字符，只允许 unreserved 字符，base64url 恰好满足 */
export function createCodeVerifier(): string {
  return randomBytes(48).toString('base64url');
}

export function codeChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function buildAuthorizeUrl(
  cfg: MicrosoftConfig,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(`${AUTHORITY}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', cfg.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // 固定用 account picker：单用户场景下也避免「浏览器里登着另一个号」导致绑错账号
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeCode(
  cfg: MicrosoftConfig,
  params: { code: string; codeVerifier: string },
): Promise<TokenSet> {
  return requestToken(cfg, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: cfg.redirectUri,
    code_verifier: params.codeVerifier,
    scope: cfg.scopes.join(' '),
  });
}

export async function refreshAccessToken(cfg: MicrosoftConfig, refreshToken: string): Promise<TokenSet> {
  return requestToken(cfg, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: cfg.scopes.join(' '),
  });
}

async function requestToken(cfg: MicrosoftConfig, form: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    ...form,
  });

  let res: Response;
  try {
    res = await fetch(`${AUTHORITY}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthError(
      `连接微软令牌端点失败：${err instanceof Error ? err.message : String(err)}`,
      'network_error',
    );
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 微软偶尔会返回 HTML 错误页（WAF 拦截等），此时 text 前 200 字符足够定位
    throw new OAuthError(`令牌端点返回了非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}`, 'bad_response');
  }

  if (!res.ok) {
    const code = typeof json.error === 'string' ? json.error : 'unknown_error';
    const desc = typeof json.error_description === 'string' ? json.error_description : `HTTP ${res.status}`;
    throw new OAuthError(desc.slice(0, 500), code);
  }

  const accessToken = json.access_token;
  const expiresIn = json.expires_in;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new OAuthError('令牌响应里没有 access_token', 'bad_response');
  }

  const ttlSec = typeof expiresIn === 'number' ? expiresIn : Number(expiresIn ?? 0);
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    // 扣 60s 余量：宁可早 1 分钟刷新，也不要在请求发出去的瞬间过期
    expiresAt: Date.now() + Math.max(0, ttlSec - 60) * 1000,
    scope: typeof json.scope === 'string' ? json.scope : '',
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
  };
}

export interface GraphMe {
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
}

/**
 * 用 access token 读 /me。
 * 这既是「令牌是否真的可用」的探针，也用来拿 account_id 与邮箱做绑定标识。
 */
export async function fetchMe(accessToken: string): Promise<GraphMe> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GraphError(
      `连接 Graph 失败：${err instanceof Error ? err.message : String(err)}`,
      0,
      'network_error',
    );
  }

  if (!res.ok) {
    const retryAfter = res.headers.get('retry-after');
    let graphCode = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: unknown } };
      if (typeof body.error?.code === 'string') graphCode = body.error.code;
    } catch {
      // 非 JSON（如 502 网关页）保留 http_<status>
    }
    throw new GraphError(
      `Graph /me 返回 HTTP ${res.status}（${graphCode}）`,
      res.status,
      graphCode,
      retryAfter ? Number(retryAfter) : undefined,
    );
  }

  const body = (await res.json()) as Record<string, unknown>;
  const id = body.id;
  if (typeof id !== 'string' || id === '') throw new GraphError('Graph /me 响应缺少 id', 0, 'bad_response');

  return {
    id,
    displayName: typeof body.displayName === 'string' ? body.displayName : null,
    mail: typeof body.mail === 'string' ? body.mail : null,
    userPrincipalName: typeof body.userPrincipalName === 'string' ? body.userPrincipalName : null,
  };
}
