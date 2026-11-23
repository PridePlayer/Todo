import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID（26 字符，字典序 = 时间序）。
 * 用业务 id 而不是自增主键：多表自增 id 会互相交叉，做增量同步游标时必然漏行。
 */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i += 1) {
    rand += CROCKFORD[bytes[i]! % 32];
  }
  return time + rand;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 32 字节随机，Base64URL。用于会话 id、CSRF token、设备令牌 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function requestId(): string {
  return randomUUID();
}

/** 定长字符串的恒时比较，避免通过响应时间侧信道猜 token */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
