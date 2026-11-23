/**
 * ULID 生成器：26 字符、字典序即时间序。
 *
 * 为什么不用 crypto.randomUUID()：
 * 1. UUIDv4 无序，`ORDER BY id` 拿不到「最近创建」，而本地列表默认就按创建时间排；
 * 2. 服务端主键是 CHAR(26)，长度必须一致，M2 同步时不能再转一次；
 * 3. ULID 前 10 位是毫秒时间戳，肉眼能看出创建时间，排查同步问题时会省很多事。
 *
 * Crockford base32：去掉了 I / L / O / U，避免和 1 / 0 混淆。
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(ms: number, len: number): string {
  let out = '';
  let rest = ms;
  for (let i = 0; i < len; i++) {
    out = ENCODING[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ENCODING[bytes[i]! % 32];
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now, TIME_LEN) + encodeRandom(RANDOM_LEN);
}

export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;

export function isUlid(value: string): boolean {
  return value.length === ULID_LENGTH && /^[0-9A-HJKMNP-TV-Z]+$/.test(value);
}
