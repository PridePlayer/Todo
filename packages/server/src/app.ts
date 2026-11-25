import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Db } from './db/types.js';
import type { AppEnv } from './env.js';
import { HttpError, sendError } from './http/errors.js';
import type { GraphTokens } from './graph/token.js';
import { authRoutes } from './routes/auth.js';
import { calendarRoutes } from './routes/calendar.js';
import { deviceRoutes } from './routes/devices.js';
import { exportRoutes } from './routes/export.js';
import { habitRoutes } from './routes/habits.js';
import { healthRoutes } from './routes/health.js';
import { oauthRoutes } from './routes/oauth.js';
import { syncRoutes } from './routes/sync.js';
import { widgetRoutes } from './routes/widget.js';
import { VERSION } from './version.js';

export interface AppDeps {
  env: AppEnv;
  db: Db;
  startedAt: number;
  /** 未配置 Microsoft OAuth 时为 null：日历接口返回 503，其余功能照常 */
  tokens?: GraphTokens | null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 开发环境放宽到本机任意端口：否则用 127.0.0.1 打开页面会被自己的 Origin 校验挡在门外，
 * 而这种「明明密码对却登不上」最浪费时间。生产只认 APP_ORIGIN 精确匹配。
 */
function isAllowedOrigin(origin: string, env: AppEnv): boolean {
  if (origin === env.appOrigin) return true;
  if (env.isProd) return false;
  try {
    const { hostname, protocol } = new URL(origin);
    return (protocol === 'http:' || protocol === 'https:') &&
      (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
  } catch {
    return false;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env, db } = deps;

  const app = Fastify({
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    logger: {
      level: env.logLevel,
      base: { svc: 'grid' },
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          '*.password',
          '*.access_token',
          '*.refresh_token',
          '*.code_verifier',
        ],
        censor: '[redacted]',
      },
    },
  });

  await app.register(cookie);
  await app.register(helmet, {
    // API 只返回 JSON，CSP 由 nginx 在 HTML 响应上设置
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  // 注意顺序：错误处理器与 404 必须在注册路由**之前**设置。
  // Fastify 的封装上下文在注册那一刻继承当时的处理器，放到后面注册的路由会退回默认序列化，
  // 表现为「业务错误被包成 Fastify 的 statusCode/code/error 三件套」——很难一眼看出原因。
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: `没有这个接口：${req.method} ${req.url}` },
    });
  });

  app.setErrorHandler((error: FastifyError | HttpError, req, reply) => {
    if (error instanceof HttpError) {
      return sendError(reply, error);
    }
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) {
      req.log.error({ err: error }, 'unhandled error');
      return reply.status(500).send({ error: { code: 'internal_error', message: '服务端异常，请查看服务日志' } });
    }
    return reply.status(statusCode).send({
      error: { code: error.code ?? 'bad_request', message: error.message },
    });
  });

  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !isAllowedOrigin(origin, env)) {
      throw new HttpError(403, 'bad_origin', '请求来源不被允许');
    }
  });

  // 设备令牌临期时会静默轮换，新令牌只能通过响应头交回客户端。
  // 放在钩子里而不是每个 handler 里：漏一处的症状是"那台设备第二天突然要求重新登录"，
  // 而那种 bug 只在 173 天后才出现，根本对不上因果。
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.deviceRotatedToken) {
      reply.header('x-device-token', req.deviceRotatedToken);
      // 客户端换了令牌，就不要让任何中间层缓存这次响应
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  await app.register(healthRoutes, { prefix: '/api', db, startedAt: deps.startedAt, version: VERSION });
  await app.register(authRoutes, { prefix: '/api', db, env });
  await app.register(oauthRoutes, { prefix: '/api', db, env });
  await app.register(syncRoutes, { prefix: '/api', db, env });
  await app.register(calendarRoutes, { prefix: '/api', db, env, tokens: deps.tokens ?? null });
  await app.register(habitRoutes, { prefix: '/api', db, env });
  await app.register(deviceRoutes, { prefix: '/api', db, env });
  await app.register(widgetRoutes, { prefix: '/api', db, env });
  await app.register(exportRoutes, { prefix: '/api', db, env });

  return app;
}
