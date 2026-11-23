import { buildApp } from './app.js';
import { createDb, runMigrations } from './db/index.js';
import { loadEnv } from './env.js';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const env = loadEnv();
  const db = createDb(env.dbUrl);

  const app = await buildApp({ env, db, startedAt });

  const reachable = await db.ping();
  if (!reachable) {
    app.log.fatal(
      { db: db.label },
      '数据库连不上。检查 .env 里的 DB_URL；本地开发默认用 sqlite:./.data/grid.db，不需要装任何数据库',
    );
    await db.close();
    process.exit(1);
  }

  // 迁移随启动执行：幂等且只增不改，避免「忘了跑 db:migrate 导致接口 500」这类事故。
  // 生产部署脚本里仍显式跑一次 db:migrate，正常情况下是 no-op。
  const ran = await runMigrations(db, (msg) => app.log.info(msg));

  await app.listen({ host: env.host, port: env.port });

  app.log.info(
    {
      version: '0.1.0',
      db: db.label,
      origin: env.appOrigin,
      cookie: env.cookieName,
      migrationsApplied: ran.length,
      node: process.version,
    },
    `GRID API 已启动 → http://${env.host}:${env.port}/api/healthz`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, '收到退出信号，开始收尾');
    try {
      await app.close();
      await db.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '退出时出错');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[fatal] 启动失败：', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
