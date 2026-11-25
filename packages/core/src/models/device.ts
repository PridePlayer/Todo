import { z } from 'zod';

/**
 * Android 设备令牌（docs/02 §5.3）。
 *
 * 与 Web 的 Cookie 会话是两套凭据：App 用 `Authorization: Bearer grd_…`，
 * 180 天有效、临期静默轮换、可在设置页单独注销。
 *
 * 令牌明文只在**签发那一次**的响应里出现，之后服务端只有 SHA-256。
 * 所以设置页在"生成令牌"之外，不提供"再显示一次"——给不出来是设计，不是缺陷。
 */
export const deviceTokenSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
  expiresAt: z.number().int(),
  revokedAt: z.number().int().nullable(),
  rotatedTo: z.string().nullable(),
  /**
   * 令牌权限。旧数据没有这个字段，缺省按 full —— 服务端库里那一列是可空的，
   * 迁移不回填，两边必须用同一个缺省值，否则设置页会把老设备显示成"受限"。
   */
  scope: z.enum(['full', 'widget']).default('full'),
});

export type DeviceTokenInfo = z.infer<typeof deviceTokenSchema>;

export const deviceTokenListSchema = z.object({
  tokens: z.array(deviceTokenSchema),
});

export const issuedDeviceTokenSchema = z.object({
  id: z.string(),
  token: z.string(),
  label: z.string().optional(),
  expiresAt: z.number().int(),
});

export type IssuedDeviceToken = z.infer<typeof issuedDeviceTokenSchema>;

export const deviceLoginResponseSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), createdAt: z.number() }),
  device: issuedDeviceTokenSchema,
});

export type DeviceLoginResponse = z.infer<typeof deviceLoginResponseSchema>;

/** 令牌剩余天数：设置页要显示"还有 N 天到期"，负数表示已过期 */
export function daysLeft(expiresAt: number, now: number = Date.now()): number {
  return Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
}

export type DeviceTokenState = 'active' | 'expiring' | 'expired' | 'revoked';

/** 剩余 7 天内标 expiring：与服务端静默轮换的窗口一致，用户看到的和系统做的是同一件事 */
export function deviceTokenState(token: DeviceTokenInfo, now: number = Date.now()): DeviceTokenState {
  if (token.revokedAt !== null) return 'revoked';
  if (token.expiresAt <= now) return 'expired';
  if (token.expiresAt - now <= 7 * 24 * 60 * 60 * 1000) return 'expiring';
  return 'active';
}
