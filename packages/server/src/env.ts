import fs from 'node:fs';
import { z } from 'zod';
import { parseEncKey } from './oauth/token-cipher.js';
import { envFile } from './paths.js';

/**
 * .env 只在存在时加载，不覆盖已有环境变量（生产用 systemd EnvironmentFile 注入）。
 * Node 20.12+ 自带 process.loadEnvFile，不需要 dotenv 依赖。
 */
function loadEnvFileOnce(): void {
  if (!fs.existsSync(envFile)) return;
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.error(`[env] 无法解析 ${envFile}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// 未设置时按 false 处理（开发默认），显式写 true/1 才开启
const boolish = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  DB_URL: z.string().min(3).default('sqlite:./.data/grid.db'),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: boolish,
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

  // ── Microsoft Graph（M0 后新增，未配置时 OAuth 功能整体关闭，服务照常启动） ──
  MS_CLIENT_ID: z.string().trim().optional(),
  MS_CLIENT_SECRET: z.string().trim().optional(),
  MS_TENANT: z.string().trim().default('common'),
  MS_REDIRECT_URI: z.string().trim().optional(),
  MS_SCOPES: z.string().trim().default('offline_access User.Read Calendars.ReadWrite'),
  TOKEN_ENC_KEY: z.string().trim().optional(),
});

export interface OAuthEnv {
  /** false 时所有 /api/oauth/* 一律 503，前端显示「未配置」而不是报错弹窗 */
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  tenant: string;
  redirectUri: string;
  scopes: string[];
  /** 用于加解密令牌；enabled 时必有值 */
  encKey: Buffer | null;
}

export interface AppEnv {
  nodeEnv: 'development' | 'production' | 'test';
  isProd: boolean;
  host: string;
  port: number;
  dbUrl: string;
  appOrigin: string;
  cookieSecure: boolean;
  cookieName: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  sessionTtlDays: number;
  sessionTtlMs: number;
  oauth: OAuthEnv;
}

export function loadEnv(): AppEnv {
  loadEnvFileOnce();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    console.error(`[env] 环境变量校验失败：\n${lines.join('\n')}\n请对照 .env.example 修正 .env`);
    process.exit(1);
  }
  const raw = parsed.data;
  const isProd = raw.NODE_ENV === 'production';

  // 生产必须 Secure，否则 __Host- 前缀会被浏览器直接丢弃（而你会以为是登录 bug）
  if (isProd && !raw.COOKIE_SECURE) {
    console.error('[env] 生产环境 COOKIE_SECURE 必须为 true');
    process.exit(1);
  }

  const appOrigin = raw.APP_ORIGIN.replace(/\/$/, '');
  const oauth = resolveOAuthEnv(raw, appOrigin, isProd);

  return {
    nodeEnv: raw.NODE_ENV,
    isProd,
    host: raw.HOST,
    port: raw.PORT,
    dbUrl: raw.DB_URL,
    appOrigin,
    cookieSecure: raw.COOKIE_SECURE,
    cookieName: raw.COOKIE_SECURE ? '__Host-grid_s' : 'grid_s',
    logLevel: raw.LOG_LEVEL,
    sessionTtlDays: raw.SESSION_TTL_DAYS,
    sessionTtlMs: raw.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    oauth,
  };
}

/**
 * OAuth 配置的解析原则：**能不配就不阻塞启动**。
 *
 * M0/M1 阶段没有 Azure 应用也能开发；但一旦配了 client_id 却没配密钥，
 * 那就是真正的配置错误——宁可启动失败，也不要在用户点「连接」时才抛 500。
 */
function resolveOAuthEnv(
  raw: {
    MS_CLIENT_ID?: string | undefined;
    MS_CLIENT_SECRET?: string | undefined;
    MS_TENANT: string;
    MS_REDIRECT_URI?: string | undefined;
    MS_SCOPES: string;
    TOKEN_ENC_KEY?: string | undefined;
  },
  appOrigin: string,
  isProd: boolean,
): OAuthEnv {
  const clientId = raw.MS_CLIENT_ID ?? '';
  const clientSecret = raw.MS_CLIENT_SECRET ?? '';
  const redirectUri = (raw.MS_REDIRECT_URI ?? '').trim() || `${appOrigin}/api/oauth/microsoft/callback`;
  const scopes = raw.MS_SCOPES.split(/\s+/).filter(Boolean);
  const disabled: OAuthEnv = {
    enabled: false,
    clientId,
    clientSecret,
    tenant: raw.MS_TENANT,
    redirectUri,
    scopes,
    encKey: null,
  };

  if (!clientId && !clientSecret && !raw.TOKEN_ENC_KEY) {
    console.warn('[env] 未配置 Microsoft OAuth（MS_CLIENT_ID / MS_CLIENT_SECRET），Outlook 相关接口返回 503');
    return disabled;
  }

  const missing: string[] = [];
  if (!clientId) missing.push('MS_CLIENT_ID');
  if (!clientSecret) missing.push('MS_CLIENT_SECRET');
  if (missing.length > 0) {
    console.error(
      `[env] Microsoft OAuth 配置不完整，缺少：${missing.join('、')}。\n` +
        '要么三项都配齐，要么把 MS_CLIENT_ID / MS_CLIENT_SECRET / TOKEN_ENC_KEY 全部留空。',
    );
    process.exit(1);
  }

  if (!raw.TOKEN_ENC_KEY) {
    console.error(
      '[env] 配了 MS_CLIENT_ID 但没配 TOKEN_ENC_KEY，令牌无法加密存储，拒绝启动。\n' +
        '生成方式：openssl rand -base64 32',
    );
    process.exit(1);
  }

  let encKey: Buffer;
  try {
    encKey = parseEncKey(raw.TOKEN_ENC_KEY);
  } catch (err) {
    console.error(`[env] TOKEN_ENC_KEY 无效：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (isProd && !redirectUri.startsWith('https://')) {
    console.error(
      `[env] 生产环境 MS_REDIRECT_URI 必须是 https：当前为 ${redirectUri}。\n` +
        '微软只对 http://localhost 放行，公网 HTTP 回调会被直接拒绝。',
    );
    process.exit(1);
  }

  // 没有 offline_access 就拿不到 refresh_token，access_token 一小时后失效且无法续期
  if (!scopes.includes('offline_access')) {
    console.warn('[env] MS_SCOPES 缺少 offline_access，将拿不到 refresh_token（一小时后需重新授权）');
  }

  return { enabled: true, clientId, clientSecret, tenant: raw.MS_TENANT, redirectUri, scopes, encKey };
}
