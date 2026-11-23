import { isDateKey } from '@grid/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser as authenticateRequest } from '../auth/require.js';
import type { Db, Row } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { HttpError } from '../http/errors.js';
import { rowToPayload } from '../sync/task-map.js';

interface Deps {
  db: Db;
  env: AppEnv;
}

/** 一次最多回 180 天：热力图 12 周 = 84 天，留一倍余量，再多就没人看了 */
const MAX_DAYS = 180;
const DEFAULT_DAYS = 90;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD' 减若干天，纯 UTC 算术（不受时区/夏令时影响） */
function shiftDays(dateKey: string, delta: number): string {
  const ts = Date.parse(`${dateKey}T00:00:00Z`) + delta * 86_400_000;
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 打卡的读取接口。
 *
 * 为什么打卡需要一个专门接口，而不是全靠 /sync/pull：
 *   1. 打卡的读放大比别的表都高——一年 365 行/习惯，五年就是两千行。手机上
 *      桌面小组件、每日提醒每次醒来都全量 pull 一遍是浪费流量和电。
 *   2. 这个接口的数据形状是"习惯 + 最近 N 天记录"，正好是热力图和连续天数
 *      需要的全部输入，客户端不必自己再筛一遍（筛错了的症状是统计数字微妙的差一）。
 *
 * 它**只读**：写入一律走 /sync/push，否则会出现两条写路径各自维护 merge 规则，
 * 而两条路径的合并语义迟早会分叉（比如这里忘了取 max，就会把打卡数字相加）。
 */
export async function habitRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { db, env } = deps;

  // 统一鉴权：Cookie 会话（Web）与 Bearer 设备令牌（Android）都从这里进
  const requireUser = (req: FastifyRequest): Promise<string> => authenticateRequest(db, env, req);

  app.get('/habits/summary', async (req) => {
    const userId = await requireUser(req);
    const query = req.query as Record<string, string | undefined>;

    // 日期一律由客户端给：服务端时区与用户所在时区可能不同（部署在 UTC 机器上很常见），
    // 服务端自己算"今天"会在跨零点前后差一天，症状是"晚上 11 点打的卡显示在明天"
    const today = query.today && isDateKey(query.today) ? query.today : todayKey();
    const days = Math.min(MAX_DAYS, Math.max(1, Math.trunc(Number(query.days ?? DEFAULT_DAYS)) || DEFAULT_DAYS));
    const from = shiftDays(today, -(days - 1));

    const habits = await db.query<Row>(
      'SELECT * FROM habit WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC',
      [userId],
    );
    const logs = await db.query<Row>(
      'SELECT * FROM habit_log WHERE user_id = ? AND deleted_at IS NULL AND log_date >= ? AND log_date <= ? ORDER BY log_date ASC',
      [userId, from, today],
    );

    return {
      today,
      from,
      to: today,
      habits: habits.map((row) => ({ ...rowToPayload('habit', row), rev: Number(row.rev) })),
      logs: logs.map((row) => ({ ...rowToPayload('habit_log', row), rev: Number(row.rev) })),
    };
  });
}
