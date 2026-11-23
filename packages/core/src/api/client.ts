import { z } from 'zod';
import { oauthStatusSchema, oauthVerifyResultSchema, type OAuthStatus, type OAuthVerifyResult } from '../models/oauth.js';
import {
  apiErrorBodySchema,
  loginResponseSchema,
  sessionResponseSchema,
  type LoginResponse,
  type SessionResponse,
} from '../models/session.js';
import {
  syncPullResponseSchema,
  syncPushResponseSchema,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse,
} from '../models/sync.js';

/**
 * 客户端唯一允许抛的业务错误。
 * 上层按 `code` 分支，不解析 message（message 会随文案调整而变）。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSec: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export interface ApiClientOptions {
  /** 默认走同源 /api，由 Vite proxy 或 nginx 转发 */
  baseUrl?: string;
  /** 便于测试注入；默认用全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  session(): Promise<SessionResponse>;
  login(email: string, password: string): Promise<LoginResponse>;
  logout(): Promise<void>;
  /** Microsoft 绑定状态。未登录也会返回 configured，便于前端先渲染壳 */
  oauthStatus(): Promise<OAuthStatus>;
  /** 断开绑定：只删服务端密文与本地记录，不动微软侧的日历数据 */
  disconnectMicrosoft(): Promise<void>;
  /** 真拿 access token 请求一次 Graph /me，证明令牌可用；快过期会先静默刷新 */
  verifyMicrosoft(): Promise<OAuthVerifyResult>;
  /** 连接入口。必须用顶层导航（window.location.assign），fetch 跳不过去微软登录页 */
  microsoftConnectUrl(): string;
  /** 增量拉取。cursor=0 表示全量（"全量重建"就走这条） */
  syncPull(body: { cursor: number; limit?: number }): Promise<SyncPullResponse>;
  /** 推送本地操作队列。服务端逐条给结果，不做批量事务 */
  syncPush(body: SyncPushRequest): Promise<SyncPushResponse>;
  /** 服务端水位与条数，设置页用来对照"两边是不是真的收敛了" */
  syncState(): Promise<SyncServerState>;
  /** 当前持有的 CSRF token（调试用） */
  currentCsrfToken(): string | null;
}

export interface SyncServerState {
  serverCursor: number;
  tasks: number;
  tags: number;
  conflicts: number;
}

const syncStateSchema = z.object({
  serverCursor: z.number().int(),
  tasks: z.number().int(),
  tags: z.number().int(),
  conflicts: z.number().int(),
});

const CSRF_HEADER = 'x-csrf-token';

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '/api';
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let csrfToken: string | null = null;

  async function request<S extends z.ZodTypeAny>(
    path: string,
    init: RequestInit & { parse: S },
  ): Promise<z.infer<S>> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    // 双提交 CSRF：只有非幂等方法需要
    if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
      headers.set(CSRF_HEADER, csrfToken);
    }

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        ...init,
        method,
        headers,
        credentials: 'include',
      });
    } catch {
      throw new ApiError(0, 'network_error', '网络不可用，请检查连接', undefined);
    }

    if (!res.ok) {
      let code = 'http_error';
      let message = `请求失败（HTTP ${res.status}）`;
      let retryAfterSec: number | undefined;
      try {
        const parsed = apiErrorBodySchema.safeParse(await res.json());
        if (parsed.success) {
          code = parsed.data.error.code;
          message = parsed.data.error.message;
          retryAfterSec = parsed.data.error.retryAfterSec;
        }
      } catch {
        // 非 JSON 错误体（例如 nginx 502 页面）保持默认
      }
      throw new ApiError(res.status, code, message, retryAfterSec);
    }

    if (res.status === 204) return init.parse.parse(undefined) as z.infer<S>;

    const body: unknown = await res.json();
    const parsed = init.parse.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(0, 'bad_response', '服务端返回了无法识别的数据结构');
    }
    return parsed.data;
  }

  return {
    async session() {
      const data = await request('/auth/session', { parse: sessionResponseSchema });
      csrfToken = data.csrfToken;
      return data;
    },

    async login(email, password) {
      const data = await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        parse: loginResponseSchema,
      });
      return data;
    },

    async logout() {
      await doFetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: csrfToken ? { [CSRF_HEADER]: csrfToken } : {},
      });
      csrfToken = null;
    },

    async oauthStatus() {
      return request('/oauth/microsoft', { parse: oauthStatusSchema });
    },

    async disconnectMicrosoft() {
      // 204 走 request 的 parse(undefined) 分支，z.void() 正好接受
      await request('/oauth/microsoft/disconnect', { method: 'POST', parse: z.void() });
    },

    async verifyMicrosoft() {
      return request('/oauth/microsoft/verify', { parse: oauthVerifyResultSchema });
    },

    microsoftConnectUrl() {
      return `${baseUrl}/oauth/microsoft/start`;
    },

    async syncPull(body) {
      return request('/sync/pull', {
        method: 'POST',
        body: JSON.stringify({ cursor: body.cursor, limit: body.limit ?? 200 }),
        parse: syncPullResponseSchema,
      });
    },

    async syncPush(body) {
      return request('/sync/push', {
        method: 'POST',
        body: JSON.stringify(body),
        parse: syncPushResponseSchema,
      });
    },

    async syncState() {
      return request('/sync/state', { parse: syncStateSchema });
    },

    currentCsrfToken() {
      return csrfToken;
    },
  };
}
