import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { HttpError } from '../http/errors.js';
import { resolveDeviceToken, type DeviceScope } from './device-token.js';
import { resolveSession } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * 本轮响应必须带上的新设备令牌。
     *
     * 设备令牌临期时会在校验过程中被静默轮换，新令牌只能通过响应头交回客户端；
     * 而校验发生在 handler 之前的任意位置（每个路由各自调用），所以这里挂在 request 上，
     * 由 app.ts 的 onSend 钩子统一写头——否则每个 handler 都要记得写一次，漏一处就是
     * "那台设备第二天突然要求重新登录"。
     */
    deviceRotatedToken?: string;
  }
}

export interface Authed {
  userId: string;
  /** 这次请求是靠 Cookie 会话还是 Bearer 设备令牌进来的 */
  via: 'session' | 'device';
  deviceTokenId: string | null;
  /**
   * 这把凭据能做什么。
   *
   * Cookie 会话与 full 设备令牌都是 'full'；只有桌面小组件那枚
   * 只读令牌是 'widget'，且它只在 /api/widget/summary 上被显式放行。
   */
  scope: DeviceScope;
}

/**
 * 统一鉴权入口。
 *
 * 两条通道并存，是因为两端的能力不一样：
 *   Web   有浏览器帮着带 Cookie，也有 SameSite 兜 CSRF；
 *   Android 没有 Cookie 罐，也没有 SameSite，所以用 `Authorization: Bearer grd_…`。
 *
 * 顺序上先看 Authorization：带了 Bearer 却无效的请求**不应该**再退化去试 Cookie。
 * 否则"App 令牌过期了，但同一台设备上恰好有个有效 Cookie"会让 App 继续能用，
 * 用户永远看不到"设备授权已过期"，而那正是 A8/A9 要验的东西。
 */
export async function authenticate(db: Db, env: AppEnv, req: FastifyRequest): Promise<Authed> {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const raw = header.slice('bearer '.length).trim();
    const device = await resolveDeviceToken(db, raw);
    if (!device) {
      // 用独立 code：App 收到这个要提示"设备授权已过期，请重新登录"，
      // 而不是像 Web 那样静默跳登录页（App 里根本没有登录页可回）
      throw new HttpError(401, 'device_expired', '设备授权已过期，请重新登录');
    }
    if (device.rotated) req.deviceRotatedToken = device.rotated.token;
    return { userId: device.userId, via: 'device', deviceTokenId: device.id, scope: device.scope };
  }

  const raw = req.cookies[env.cookieName];
  const userId = typeof raw === 'string' ? await resolveSession(db, raw, env.sessionTtlMs) : null;
  if (!userId) throw new HttpError(401, 'unauthenticated', '请先登录');
  // 浏览器会话没有 scope 概念，它等价于全权
  return { userId, via: 'session', deviceTokenId: null, scope: 'full' };
}

/**
 * 只需要 userId 的调用点用这个（同步、日历、打卡三条路由都是如此）。
 *
 * **默认拒绝**：小组件令牌在这里被挡掉，只被允许走 /api/widget/* 那条显式放行的路。
 * 反过来写（默认放行、例外拒绝）的话，以后新增任何一个路由都会自动对小组件令牌敞开，
 * 而这种漏洞不会有人注意到 —— 它不会报错，只会静默多开一扇门。
 */
export async function requireUser(db: Db, env: AppEnv, req: FastifyRequest): Promise<string> {
  const authed = await authenticate(db, env, req);
  if (authed.scope !== 'full') {
    throw new HttpError(403, 'scope_forbidden', '这个令牌只能读小组件摘要，不能访问该接口');
  }
  return authed.userId;
}
