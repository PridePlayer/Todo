import type { Db } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { TokenCipher } from '../oauth/token-cipher.js';
import type { MicrosoftConfig } from '../oauth/microsoft.js';
import { GraphTokens } from './token.js';

/**
 * Graph 运行时上下文的唯一构造点。
 *
 * 之前 cfg / cipher 是在 oauth 路由里各自 new 的，再加一个令牌管家就会出现
 * 第二、第三份副本——其中一份的 cipher 用了别的 key，症状是"有的接口能读令牌、有的报解密失败"。
 */
export interface GraphContext {
  cfg: MicrosoftConfig;
  cipher: TokenCipher;
  tokens: GraphTokens;
}

export function createGraphContext(db: Db, env: AppEnv): GraphContext | null {
  if (!env.oauth.enabled || !env.oauth.encKey) return null;
  const cfg: MicrosoftConfig = {
    clientId: env.oauth.clientId,
    clientSecret: env.oauth.clientSecret,
    tenant: env.oauth.tenant,
    redirectUri: env.oauth.redirectUri,
    scopes: env.oauth.scopes,
  };
  const cipher = new TokenCipher(env.oauth.encKey);
  return { cfg, cipher, tokens: new GraphTokens(db, cfg, cipher) };
}
