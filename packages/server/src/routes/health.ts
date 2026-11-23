import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/types.js';

export interface HealthOptions {
  db: Db;
  startedAt: number;
  version: string;
}

/**
 * 唯一的探活入口。它必须满足两个性质：
 *  1. 廉价 —— 只做 SELECT 1，不碰业务表
 *  2. 说人话 —— 顺带报 rssMB，这是判断 2C2G 撑不撑得住的唯一真实数据点
 */
export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, opts) => {
  app.get('/healthz', async (_req, reply) => {
    const dbUp = await opts.db.ping();
    return reply
      .status(dbUp ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({
        ok: dbUp,
        db: dbUp ? 'up' : 'down',
        driver: opts.db.driver,
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        uptimeS: Math.round((Date.now() - opts.startedAt) / 1000),
        version: opts.version,
        now: Date.now(),
      });
  });
};
