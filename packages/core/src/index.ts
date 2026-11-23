// @grid/core —— 双端共享层。
//
// 纪律：本包内不允许出现 window / document / localStorage / expo-* / node:* 的引用。
// 它必须能在浏览器、React Native、Node 三种运行时里同时被求值。
// 数据库访问一律通过上层注入，保证同一套同步引擎能跑在 IndexedDB 与 SQLite 上。

export {
  sessionUserSchema,
  type SessionUser,
} from './models/user.js';

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
} from './models/session.js';

export {
  ApiError,
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
} from './api/client.js';

export { ulid, isUlid, ULID_LENGTH } from './id.js';

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
} from './models/task.js';

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
} from './quadrant.js';

export { DepthLimitError, type TaskStore, type TaskPatch } from './repo/types.js';

export {
  hlcSchema,
  syncOpSchema,
  syncPushRequestSchema,
  syncPushResponseSchema,
  syncOpResultSchema,
  syncPullRequestSchema,
  syncPullResponseSchema,
  syncChangeSchema,
  syncConflictSchema,
  compareHlc,
  SYNC_TABLES,
  SYNC_ACTIONS,
  SYNC_OP_STATUS,
  HLC_MAX_SKEW_MS,
  type Hlc,
  type SyncOp,
  type SyncAction,
  type SyncTable,
  type SyncOpStatus,
  type SyncOpResult,
  type SyncConflict,
  type SyncChange,
  type SyncPushRequest,
  type SyncPushResponse,
  type SyncPullResponse,
} from './models/sync.js';

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
} from './models/oauth.js';

export {
  recurExceptionSchema,
  recurExceptionKindSchema,
  exceptionKey,
  type RecurException,
  type RecurExceptionKind,
} from './models/recur-exception.js';

export {
  CAL_SYNC_STATES,
  calEventSchema,
  calendarSourceSchema,
  calendarStatusSchema,
  calendarSyncResultSchema,
  calendarSourceOptionSchema,
  type CalEvent,
  type CalSyncState,
  type CalendarSource,
  type CalendarStatus,
  type CalendarSyncResult,
  type CalendarSourceOption,
} from './models/calendar.js';

export {
  deviceTokenSchema,
  deviceTokenListSchema,
  issuedDeviceTokenSchema,
  deviceLoginResponseSchema,
  daysLeft,
  deviceTokenState,
  type DeviceTokenInfo,
  type IssuedDeviceToken,
  type DeviceLoginResponse,
  type DeviceTokenState,
} from './models/device.js';

export {
  systemTimeZone,
  toIanaTimeZone,
  parseZonedDateTime,
  formatZonedDateTime,
  dateKeyInZone,
} from './time.js';

export {
  HABIT_TYPES,
  habitSchema,
  newHabitSchema,
  defaultTarget,
  habitUnit,
  type Habit,
  type HabitType,
  type NewHabit,
} from './models/habit.js';

export {
  habitLogSchema,
  reached,
  progressOf,
  type HabitLog,
} from './models/habit-log.js';

export {
  dayNumber,
  dateKeyOfDayNumber,
  addDaysKey,
  daysBetween,
  isDateKey,
  weekdayOfKey,
  eachDayKey,
  isScheduled,
  weekStartKey,
} from './habit/date.js';

export { habitLogId, isHabitLogId } from './habit/log-id.js';

export { computeStreak, type StreakInfo } from './habit/streak.js';

export { completionRate, rateBuckets, formatRate, type RateInfo } from './habit/rate.js';

export {
  levelOf,
  heatmapWeeks,
  countReached,
  type HeatLevel,
  type HeatCell,
  type HeatInput,
} from './habit/heatmap.js';

export {
  parseRrule,
  formatRrule,
  rruleFromPreset,
  buildRrule,
  describeRrule,
  toIcalDate,
  weekdayOf,
  weekdayIndex,
  RruleError,
  WEEKDAYS,
  type Freq,
  type Rule,
  type RruleInput,
  type Weekday,
  type RrulePreset,
} from './recurrence/rrule.js';

export {
  expandSeries,
  expandTasks,
  rawStarts,
  durationOf,
  type Occurrence,
  type OccurrenceKind,
  type OccurrenceOrigin,
  type SeriesLike,
  type RecurExceptionLike,
  type ExceptionKind,
} from './recurrence/expand.js';

export {
  planThisOnly,
  planSkip,
  planAll,
  planThisAndFollowing,
  lastStartBefore,
  partitionExceptions,
  type OccurrencePatch,
  type ExceptionDraft,
  type SplitPlan,
} from './recurrence/exception.js';
