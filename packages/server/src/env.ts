import fs from 'node:fs';
import { z } from 'zod';
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
});

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

  return {
    nodeEnv: raw.NODE_ENV,
    isProd,
    host: raw.HOST,
    port: raw.PORT,
    dbUrl: raw.DB_URL,
    appOrigin: raw.APP_ORIGIN.replace(/\/$/, ''),
    cookieSecure: raw.COOKIE_SECURE,
    cookieName: raw.COOKIE_SECURE ? '__Host-grid_s' : 'grid_s',
    logLevel: raw.LOG_LEVEL,
    sessionTtlDays: raw.SESSION_TTL_DAYS,
    sessionTtlMs: raw.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}
