import type { FastifyReply } from 'fastify';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSec: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * 错误体形状固定为 { error: { code, message, retryAfterSec? } }。
 * 客户端按 code 分支，message 只用于显示。
 */
export function sendError(reply: FastifyReply, err: HttpError): FastifyReply {
  const body: { error: { code: string; message: string; retryAfterSec?: number } } = {
    error: { code: err.code, message: err.message },
  };
  if (err.retryAfterSec !== undefined) {
    body.error.retryAfterSec = err.retryAfterSec;
    reply.header('retry-after', String(err.retryAfterSec));
  }
  return reply.status(err.status).send(body);
}
