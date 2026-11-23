import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id，参数取自 OWASP 推荐档（19 MiB / 2 轮 / 1 并行）。
 * 单用户场景下 50ms 左右的哈希耗时完全可接受，换来的是离线爆破成本。
 *
 * 用 @node-rs/argon2 而不是 argon2：前者是 napi-rs 预编译包，
 * 服务器上不需要装 build-essential，升级 Node 也不用重新编译。
 *
 * 注意：不显式传 algorithm —— 该库默认就是 Argon2id，
 * 而它的 Algorithm 是 ambient const enum，在 isolatedModules 下无法引用。
 * 参数本身写在哈希串里（$argon2id$v=19$m=19456,t=2,p=1$...），verify 时从串里读，不依赖这些常量。
 */
const ARGON_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON_OPTIONS);
}

/** 任何异常都视为校验失败，绝不把内部错误泄漏给调用方 */
export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashValue, plain, ARGON_OPTIONS);
  } catch {
    return false;
  }
}

export interface PasswordPolicyResult {
  ok: boolean;
  message?: string;
}

export function checkPasswordPolicy(plain: string): PasswordPolicyResult {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `密码至少 ${MIN_PASSWORD_LENGTH} 位` };
  }
  if (plain.length > 200) {
    return { ok: false, message: '密码过长（上限 200 字符）' };
  }
  return { ok: true };
}
