import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomToken, safeEqual } from '../util/crypto.js';

export const CSRF_COOKIE = 'csrf';
export const CSRF_HEADER = 'x-csrf-token';
const CSRF_MAX_AGE_S = 8 * 60 * 60;

/**
 * 双提交校验：服务端不下发签名，只要求「Cookie 里的值 == 请求头里的值」。
 * 攻击者能让浏览器带上 Cookie，但读不到 Cookie 内容，也设不了自定义头，所以过不了这一关。
 */
export function issueCsrfToken(req: FastifyRequest, reply: FastifyReply, secure: boolean): string {
  const existing = req.cookies[CSRF_COOKIE];
  if (existing && existing.length >= 16) return existing;

  const token = randomToken(32);
  reply.setCookie(CSRF_COOKIE, token, {
    path: '/',
    httpOnly: false, // 前端必须能读出来塞进请求头
    sameSite: 'lax',
    secure,
    maxAge: CSRF_MAX_AGE_S,
  });
  return token;
}

export function verifyCsrfToken(req: FastifyRequest): boolean {
  const cookieValue = req.cookies[CSRF_COOKIE];
  const headerValue = req.headers[CSRF_HEADER];
  if (typeof cookieValue !== 'string' || typeof headerValue !== 'string') return false;
  return safeEqual(cookieValue, headerValue);
}
