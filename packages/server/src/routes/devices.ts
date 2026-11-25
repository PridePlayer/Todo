import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyCsrfToken } from '../auth/csrf.js';
import {
  issueDeviceToken,
  issueWidgetToken,
  listDeviceTokens,
  purgeDeviceToken,
  revokeDeviceToken,
} from '../auth/device-token.js';
import { authenticate, requireUser } from '../auth/require.js';
import type { Db } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { HttpError } from '../http/errors.js';

interface Deps {
  db: Db;
  env: AppEnv;
}

const createBody = z.object({
  /** 设备名，只用于在设置页区分「Pixel 8」「旧手机」 */
  label: z.string().trim().max(64).optional(),
});

/**
 * 设备令牌管理（docs/01 S-02、docs/06 A7~A9）。
 *
 * 一条贯穿始终的规则：**只有 Cookie 会话能签发新令牌**。
 *
 * 理由不是洁癖：设备令牌 180 天有效，而被吊销时不会连带撤销它派生出来的令牌。
 * 若允许"令牌签发令牌"，一个被偷走的令牌就能不断给自己续命，
 * 用户点「注销此设备」之后仍然能被偷偷拿回来——那这个按钮就是假的。
 */
export async function deviceRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { db, env } = deps;

  function requireSession(req: FastifyRequest): Promise<string> {
    return authenticate(db, env, req).then((authed) => {
      if (authed.via !== 'session') {
        throw new HttpError(403, 'session_required', '签发设备令牌需要网页端登录状态');
      }
      return authed.userId;
    });
  }

  app.get('/devices', async (req) => {
    const userId = await requireUser(db, env, req);
    return { tokens: await listDeviceTokens(db, userId) };
  });

  app.post('/devices', async (req) => {
    if (!verifyCsrfToken(req)) throw new HttpError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
    const userId = await requireSession(req);
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, 'invalid_body', '设备名过长');

    const issued = await issueDeviceToken(db, userId, parsed.data.label);
    req.log.info({ userId, deviceTokenId: issued.id }, 'device token issued');
    // 明文只出现这一次。服务端事后无法重建（只存 SHA-256）
    return {
      id: issued.id,
      token: issued.token,
      label: issued.label,
      expiresAt: issued.expiresAt,
    };
  });

  app.post('/devices/rotate', async (req) => {
    // 主动轮换：App 启动时发现"快到期了"可以提前换，不必等下一次请求触发静默轮换
    const authed = await authenticate(db, env, req);
    // 必须挡：这里签的是 full 令牌，放行 widget 令牌就等于让它一步提权成全权。
    if (authed.scope !== 'full') {
      throw new HttpError(403, 'scope_forbidden', '小组件令牌不能轮换主令牌');
    }
    const list = await listDeviceTokens(db, authed.userId);
    const current = list.find((item) => item.id === authed.deviceTokenId);
    const issued = await issueDeviceToken(db, authed.userId, current?.label ?? '未命名设备');
    return { id: issued.id, token: issued.token, expiresAt: issued.expiresAt };
  });

  /**
   * 签发桌面小组件的只读令牌（docs/11 §3）。
   *
   * 为什么这里允许设备令牌调用，而 POST /devices 只允许 Cookie 会话：
   * 那条规则的目的是「被偷的令牌不能凭空给自己续命」。而签发 widget 令牌
   * 不会延长任何现有凭据的寿命 —— 它是权限更小的新一把，且签发前会吊销旧的。
   * 被偷的 full 令牌本来就能读全部数据，多给它一把只读令牌不扩大实质权限。
   *
   * 反过来（要求必须是 Cookie 会话）在这条产品线上行不通：RN 里没有 Cookie 罐，
   * App 从头到尾只持设备令牌，那小组件就永远拿不到令牌。
   */
  app.post('/devices/widget-token', async (req) => {
    const authed = await authenticate(db, env, req);
    if (authed.scope !== 'full') {
      throw new HttpError(403, 'scope_forbidden', '小组件令牌不能再签发新令牌');
    }
    const issued = await issueWidgetToken(db, authed.userId);
    req.log.info({ userId: authed.userId, deviceTokenId: issued.id }, 'widget token issued');
    // 明文只出现这一次，之后服务端只能靠 SHA-256 比对
    return { token: issued.token, expiresAt: issued.expiresAt };
  });

  app.delete('/devices/:id', async (req) => {
    if (!verifyCsrfToken(req)) throw new HttpError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
    const userId = await requireUser(db, env, req);
    const id = (req.params as { id?: string }).id ?? '';
    const purge = (req.query as { purge?: string }).purge === '1';

    if (purge) {
      // 只清已失效的记录（见 purgeDeviceToken 的注释）
      const ok = await purgeDeviceToken(db, userId, id);
      if (!ok) throw new HttpError(409, 'still_valid', '这个设备令牌仍然有效，请先注销再移除记录');
      req.log.info({ userId, deviceTokenId: id }, 'device token purged');
      return { revoked: true, purged: true };
    }

    const ok = await revokeDeviceToken(db, userId, id);
    if (!ok) throw new HttpError(404, 'not_found', '没有这个设备令牌');
    req.log.info({ userId, deviceTokenId: id }, 'device token revoked');
    return { revoked: true, purged: false };
  });
}
