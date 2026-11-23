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

export { ulid, isUlid, ULID_LENGTH } from './id';

export {
  MAX_DEPTH,
  QUADRANTS,
  taskSchema,
  newTaskSchema,
  tagSchema,
  listSchema,
  isOverdue,
  type Task,
  type NewTask,
  type Tag,
  type TaskList,
  type Quadrant,
} from './models/task';

export {
  quadrantOf,
  flagsOf,
  QUADRANT_META,
  QUADRANT_ORDER,
  shiftQuadrant,
  toDateInput,
  toTimeInput,
  combineDateTime,
  formatTimeRange,
  formatDateLabel,
  taskMetaText,
  compareTasks,
  compareSubtasks,
  visible,
  type QuadrantMeta,
} from './quadrant';

export { DepthLimitError, type TaskStore, type TaskPatch } from './repo/types';

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
