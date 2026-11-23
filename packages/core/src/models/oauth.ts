import { z } from 'zod';

/**
 * Microsoft Graph 绑定的对外视图。
 *
 * 这里**刻意不包含任何令牌字段**——令牌只存在于服务端密文列里，
 * 连加密后的密文都不下发给客户端，避免密文被离线爆破。
 */
export const oauthAccountSchema = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  accountId: z.string(),
  /** active | needs_reauth | revoked —— 用宽松字符串，服务端可扩展状态而不破坏旧客户端 */
  status: z.string(),
  scope: z.string().nullable(),
  /** epoch ms；access token 到期时间，前端用来显示「X 分钟后过期」 */
  tokenExpiresAt: z.number().nullable(),
  lastVerifiedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  connectedAt: z.number().nullable(),
});

export type OAuthAccount = z.infer<typeof oauthAccountSchema>;

export const oauthStatusSchema = z.object({
  /** 服务端是否配齐了 MS_CLIENT_ID / MS_CLIENT_SECRET / TOKEN_ENC_KEY */
  configured: z.boolean(),
  scopes: z.array(z.string()),
  account: oauthAccountSchema.nullable(),
});

export type OAuthStatus = z.infer<typeof oauthStatusSchema>;

export const oauthVerifyResultSchema = z.object({
  ok: z.boolean(),
  /** true 表示这次验活顺带刷新了 access token */
  refreshed: z.boolean(),
  me: z.object({
    id: z.string(),
    email: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  tokenExpiresAt: z.number().nullable(),
});

export type OAuthVerifyResult = z.infer<typeof oauthVerifyResultSchema>;

/** 回调后跳回前端时带的短码，前端用它决定提示文案（不含微软原文，防注入） */
export const OAUTH_CALLBACK_REASONS = [
  'not_configured',
  'unauthenticated',
  'denied',
  'consent_failed',
  'missing_params',
  'state_invalid',
  'state_expired',
  'session_changed',
  'code_rejected',
  'exchange_failed',
  'graph_failed',
] as const;

export type OAuthCallbackReason = (typeof OAUTH_CALLBACK_REASONS)[number];

export const OAUTH_REASON_TEXT: Record<OAuthCallbackReason, string> = {
  not_configured: '服务端还没配置 Microsoft 凭据，先在 .env 里补齐再试',
  unauthenticated: '登录状态已失效，请重新登录后再连接',
  denied: '你在微软页面上取消了授权',
  consent_failed: '微软返回了授权错误（可能是账号类型或管理员未同意）',
  missing_params: '回调地址缺少 code 或 state，可能是手工改过链接',
  state_invalid: '这次授权请求已失效（state 不匹配或已被使用），请重新点连接',
  state_expired: '授权超时（超过 10 分钟），请重新点连接',
  session_changed: '授权过程中登录账号发生了变化，请重新点连接',
  code_rejected: '授权码被微软拒绝（通常是用得太慢或已被使用），请重试',
  exchange_failed: '换取令牌失败，请检查服务器网络能否访问 login.microsoftonline.com',
  graph_failed: '拿到令牌但读不到账户信息，通常是 Graph 权限未授予',
};
