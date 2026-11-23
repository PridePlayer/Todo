// @grid/core —— 双端共享层。
//
// 纪律：本包内不允许出现 window / document / localStorage / expo-* / node:* 的引用。
// 它必须能在浏览器、React Native、Node 三种运行时里同时被求值。
// 数据库访问一律通过上层注入，保证同一套同步引擎能跑在 IndexedDB 与 SQLite 上。

export {
  sessionUserSchema,
  type SessionUser,
} from './models/user';

export {
  apiErrorBodySchema,
  loginResponseSchema,
  sessionResponseSchema,
  SESSION_ABSOLUTE_MAX_DAYS,
  SESSION_TTL_DAYS,
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_FAILURES,
  type ApiErrorBody,
  type LoginResponse,
  type SessionResponse,
} from './models/session';

export {
  ApiError,
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
} from './api/client';

export {
  oauthAccountSchema,
  oauthStatusSchema,
  oauthVerifyResultSchema,
  OAUTH_CALLBACK_REASONS,
  OAUTH_REASON_TEXT,
  type OAuthAccount,
  type OAuthStatus,
  type OAuthVerifyResult,
  type OAuthCallbackReason,
} from './models/oauth';
