import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Microsoft Graph 的 access / refresh token 一律以密文入库。
 *
 * 算法：AES-256-GCM。选它而不是 AES-CBC，是因为 GCM 自带完整性校验——
 * 密文被改一个字节，解密会直接抛错，而不是悄悄返回一段乱码去请求微软。
 *
 * 存储格式：`v1.<iv>.<tag>.<ciphertext>`，四段都用 base64url。
 * 带版本前缀是为了以后换密钥/换算法能平滑迁移：解密时按第一段分派。
 */
const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM 推荐 96 bit
const KEY_BYTES = 32; // AES-256

/**
 * 解析 TOKEN_ENC_KEY。允许两种写法：
 *   - `openssl rand -base64 32` 的 base64（44 字符，含结尾 =）
 *   - 64 位十六进制
 * 长度不对就抛错，由调用方在启动阶段转成「退出并打印人话」。
 */
export function parseEncKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('TOKEN_ENC_KEY 为空');

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    key = Buffer.from(trimmed, 'base64');
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENC_KEY 长度不对：解出 ${key.length} 字节，需要 ${KEY_BYTES} 字节。\n` +
        '生成方式：openssl rand -base64 32',
    );
  }
  return key;
}

/** 生成一个新的密钥（CLI 与文档都用同一条命令的等价物） */
export function generateEncKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

export class TokenCipher {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error(`密钥必须是 ${KEY_BYTES} 字节`);
    this.#key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
      '.',
    );
  }

  /**
   * 解密失败必须抛错，绝不返回空串。
   * 返回空串的后果是：拿空 token 去请求 Graph，收到 401，然后被误判成
   * 「用户需要重新授权」——而真实原因是密钥换了。这会把排查方向带偏。
   */
  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 4) throw new Error('密文格式不正确（应为 v1.iv.tag.ct 四段）');

    const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
    if (!safeEqStr(version, VERSION)) {
      throw new Error(`不认识的密文版本：${version}。可能是升级后未迁移的旧数据`);
    }

    const decipher = createDecipheriv(ALGO, this.#key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  }
}

function safeEqStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
