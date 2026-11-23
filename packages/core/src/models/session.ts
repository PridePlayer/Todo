import { z } from 'zod';
import { sessionUserSchema } from './user.js';

/**
 * GET /api/auth/session 的响应。
 * user 为 null 表示未登录；csrfToken 未登录也会下发，否则登录请求本身过不了 CSRF 校验。
 */
export const sessionResponseSchema = z.object({
  user: sessionUserSchema.nullable(),
  csrfToken: z.string().min(16),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const loginResponseSchema = z.object({
  user: sessionUserSchema,
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * 统一的错误体。code 是稳定的机器可读值，message 才给人看。
 * 客户端按 code 分支（locked / invalid_credentials / csrf_failed），不要按 message 分支。
 */
export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryAfterSec: z.number().int().nonnegative().optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** 会话有效期（天），服务端与客户端共用，避免两边写死两套数字 */
export const SESSION_TTL_DAYS = 30;
/** 绝对上限：无论怎么续期，90 天后必须重新登录 */
export const SESSION_ABSOLUTE_MAX_DAYS = 90;
/** 连续失败多少次触发锁定 */
export const LOGIN_MAX_FAILURES = 5;
/** 锁定时长（分钟） */
export const LOGIN_LOCK_MINUTES = 10;
