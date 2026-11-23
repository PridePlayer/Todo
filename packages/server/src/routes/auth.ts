import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { issueCsrfToken, verifyCsrfToken } from '../auth/csrf.js';
import { clearFailures, getLockState, lockoutPolicy, registerFailure } from '../auth/lockout.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, deleteExpiredSessions, deleteSession, resolveSession } from '../auth/session.js';
import type { Db } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { HttpError } from '../http/errors.js';
import { findUserByEmail, findUserById, toPublicUser } from '../repo/users.js';
import { randomToken, sha256Hex } from '../util/crypto.js';

export interface AuthOptions {
  db: Db;
  env: AppEnv;
}

const loginBodySchema = z.object({
  email: z.string().trim().min(3).max(255),
  password: z.string().min(1).max(200),
});

export const authRoutes: FastifyPluginAsync<AuthOptions> = async (app, opts) => {
  const { db, env } = opts;

  // 用户不存在时也跑一次真实哈希校验，让「邮箱不存在」和「密码错误」耗时一致，
  // 否则响应时间就是一个账号枚举接口。
  const dummyHash = await hashPassword(randomToken(16));

  function cookieOptions() {
    return {
      path: '/',
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: env.cookieSecure,
      maxAge: Math.floor(env.sessionTtlMs / 1000),
    };
  }

  app.get('/auth/session', async (req, reply) => {
    const csrfToken = issueCsrfToken(req, reply, env.cookieSecure);
    const rawToken = req.cookies[env.cookieName];
    const userId = typeof rawToken === 'string' ? await resolveSession(db, rawToken, env.sessionTtlMs) : null;

    if (!userId) {
      return { user: null, csrfToken };
    }

    const user = await findUserById(db, userId);
    if (!user) {
      // 会话有效但用户已被删除：清掉脏 cookie，别让前端卡在半登录态
      reply.clearCookie(env.cookieName, { path: '/', secure: env.cookieSecure });
      return { user: null, csrfToken };
    }

    return { user: toPublicUser(user), csrfToken };
  });

  app.post('/auth/login', async (req, reply) => {
    if (!verifyCsrfToken(req)) {
      throw new HttpError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
    }

    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', '请输入邮箱和密码');
    }
    const { email, password } = parsed.data;

    // 先查锁定，再做任何密码运算 —— 锁定期内连哈希都不该跑
    const lockState = await getLockState(db, email);
    if (lockState.locked && lockState.lockedUntil) {
      const retryAfterSec = Math.max(1, Math.ceil((lockState.lockedUntil - Date.now()) / 1000));
      throw new HttpError(
        429,
        'locked',
        `连续 ${lockoutPolicy.MAX_FAILURES} 次密码错误，已锁定 ${lockoutPolicy.LOCK_MINUTES} 分钟`,
        retryAfterSec,
      );
    }

    const user = await findUserByEmail(db, email);
    const ok = user ? await verifyPassword(user.password_hash, password) : await verifyPassword(dummyHash, password);

    if (!user || !ok) {
      const next = await registerFailure(db, email);
      const message = next.locked
        ? `邮箱或密码不正确。已达失败上限，账号锁定 ${lockoutPolicy.LOCK_MINUTES} 分钟`
        : `邮箱或密码不正确（还可尝试 ${next.remainingAttempts} 次）`;
      throw new HttpError(401, 'invalid_credentials', message);
    }

    await clearFailures(db, email);
    await deleteExpiredSessions(db);

    const { token } = await createSession(db, user.id, env.sessionTtlMs, {
      userAgent: req.headers['user-agent'] ?? undefined,
      ipHash: req.ip ? sha256Hex(req.ip) : undefined,
    });
    reply.setCookie(env.cookieName, token, cookieOptions());

    req.log.info({ userId: user.id }, 'login ok');
    return { user: toPublicUser(user) };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (!verifyCsrfToken(req)) {
      throw new HttpError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
    }
    const rawToken = req.cookies[env.cookieName];
    if (typeof rawToken === 'string') {
      await deleteSession(db, rawToken);
    }
    reply.clearCookie(env.cookieName, { path: '/', secure: env.cookieSecure });
    return reply.status(204).send();
  });
};
