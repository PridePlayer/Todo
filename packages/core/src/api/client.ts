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
  deviceLoginResponseSchema,
  deviceTokenListSchema,
  issuedDeviceTokenSchema,
  type DeviceLoginResponse,
  type DeviceTokenInfo,
  type IssuedDeviceToken,
} from '../models/device.js';
import {
  calendarStatusSchema,
  calendarSyncResultSchema,
  type CalendarStatus,
  type CalendarSyncResult,
} from '../models/calendar.js';
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
  /**
   * 设备令牌提供者（Android 端）。
   *
   * 返回 null 时退回 Cookie 会话（Web 端），所以一个客户端类能同时服务两端。
   * 每次请求都重新取，是因为令牌会静默轮换：缓存成局部变量的话，
   * 轮换后旧值会一直用到下一次冷启动。
   */
  authToken?: () => string | null;
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
  /** Outlook 日历的同步状态（连接、最近同步、日历源开关） */
  calendarStatus(): Promise<CalendarStatus>;
  /** 立即拉一次 Outlook 增量。日历页打开时每 30 秒调一次 */
  calendarSync(): Promise<CalendarSyncResult>;
  /** 单个日历源的显示/同步开关 */
  calendarPatchSource(id: string, patch: { isVisible?: boolean; isSynced?: boolean }): Promise<void>;
  /** 新建一条日程并写进 Outlook（需要已连接且存在可写日历） */
  calendarCreateEvent(body: {
    title: string;
    startAt: number;
    endAt: number;
    location?: string | null;
  }): Promise<{ ok: boolean; msEventId: string; calendarId: string; calendarName: string }>;
  /** 重新发现日历列表（用户新建/删除了日历） */
  calendarRefreshSources(): Promise<{ sources: { id: string; name: string; isVisible: boolean; isSynced: boolean; canEdit: boolean }[] }>;
  /** App 设备登录：一步拿到长效令牌，不落 Cookie（Android 端专用） */
  deviceLogin(email: string, password: string, label?: string): Promise<DeviceLoginResponse>;
  /** 本账号的全部设备令牌（含已吊销/已过期，设置页要显示"已失效"） */
  listDevices(): Promise<{ tokens: DeviceTokenInfo[] }>;
  /** 签发新令牌。明文只出现这一次，服务端只存 SHA-256 */
  createDevice(label?: string): Promise<IssuedDeviceToken>;
  /** 注销某台设备：立即失效，不等过期 */
  revokeDevice(id: string, purge?: boolean): Promise<void>;
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
      // 每次请求现取：令牌轮换后不需要重启 App
      const bearer = options.authToken?.() ?? null;
      if (bearer) headers.set('authorization', `Bearer ${bearer}`);

      res = await doFetch(`${baseUrl}${path}`, {
        ...init,
        method,
        headers,
        // Bearer 模式下没有 Cookie 可带。RN 的 fetch 对 credentials 虽然宽容，
        // 但 'include' 会让某些中间层以为这是浏览器请求并尝试处理 Cookie。
        credentials: bearer ? 'omit' : 'include',
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

    async calendarCreateEvent(body) {
      return request('/calendar/events', {
        method: 'POST',
        body: JSON.stringify(body),
        parse: z.object({
          ok: z.boolean(),
          msEventId: z.string(),
          calendarId: z.string(),
          calendarName: z.string(),
        }),
      });
    },

    async calendarStatus() {
      return request('/calendar/status', { parse: calendarStatusSchema });
    },

    async calendarSync() {
      return request('/calendar/sync', { method: 'POST', parse: calendarSyncResultSchema });
    },

    async calendarPatchSource(id, patch) {
      await request(`/calendar/sources/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
        parse: z.object({ ok: z.boolean(), isVisible: z.boolean(), isSynced: z.boolean() }),
      });
    },

    async calendarRefreshSources() {
      return request('/calendar/sources/refresh', {
        method: 'POST',
        parse: z.object({
          sources: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              isVisible: z.boolean(),
              isSynced: z.boolean(),
              canEdit: z.boolean(),
            }),
          ),
        }),
      });
    },

    async deviceLogin(email, password, label) {
      return request('/auth/device-login', {
        method: 'POST',
        body: JSON.stringify({ email, password, label }),
        parse: deviceLoginResponseSchema,
      });
    },

    async listDevices() {
      return request('/devices', { parse: deviceTokenListSchema });
    },

    async createDevice(label) {
      return request('/devices', {
        method: 'POST',
        body: JSON.stringify({ label }),
        parse: issuedDeviceTokenSchema,
      });
    },

    async revokeDevice(id, purge = false) {
      await request(`/devices/${encodeURIComponent(id)}${purge ? '?purge=1' : ''}`, {
        method: 'DELETE',
        parse: z.object({ revoked: z.boolean(), purged: z.boolean().optional() }),
      });
    },

    currentCsrfToken() {
      return csrfToken;
    },
  };
}
