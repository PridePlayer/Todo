import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser } from '../auth/require.js';
import type { Db, Row } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { HttpError } from '../http/errors.js';
import { VERSION } from '../version.js';

interface Deps {
  db: Db;
  env: AppEnv;
}

/**
 * 用户自己那份数据的导出清单。
 *
 * 刻意**不包含** oauth_account / session / device_token / op_applied：
 * 那些是运行态，不是数据。把加密后的 refresh_token 塞进出口文件，
 * 等于让一份「下载下来存桌面」的 JSON 变成账号接管材料。
 *
 * conflict_log 是有意包含的——它是历史，用户排查"为什么这条被改了"要靠它。
 */
const EXPORT_TABLES = [
  'task',
  'tag',
  'list',
  'recur_exception',
  'calendar_source',
  'cal_event',
  'habit',
  'habit_log',
  'conflict_log',
] as const;

/** 单表上限。正常用户量级远低于此，纯粹是防止某天表炸了把内存打满 */
const MAX_ROWS_PER_TABLE = 50_000;

export async function exportRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { db, env } = deps;
  const requireUserId = (req: FastifyRequest): Promise<string> => requireUser(db, env, req);

  /**
   * GET /api/export —— 整份用户数据，一个 JSON 文件。
   *
   * 用 GET 而不是 POST：要让浏览器/App 直接下载，GET 最省事，
   * 而且它是只读操作，重放无害。写操作才有 CSRF 顾虑。
   * 走 Cookie 会话（网页）或 Bearer 设备令牌（App）都能进。
   */
  app.get('/export', async (req, reply) => {
    const userId = await requireUserId(req);

    const user = await db.query<Row>('SELECT id, email, created_at FROM app_user WHERE id = ?', [userId]);
    if (!user[0]) throw new HttpError(401, 'unauthenticated', '账号不存在');

    const tables: Record<string, Row[]> = {};
    const counts: Record<string, number> = {};
    const truncated: string[] = [];

    for (const table of EXPORT_TABLES) {
      // 按主键排序而不是 change_seq：conflict_log 没有那一列。
      // id 是 ULID，字典序≈时间序，导出的文件 diff 起来更稳定。
      const rows = await db.query<Row>(
        `SELECT * FROM ${table} WHERE user_id = ? ORDER BY id ASC LIMIT ${MAX_ROWS_PER_TABLE + 1}`,
        [userId],
      );
      if (rows.length > MAX_ROWS_PER_TABLE) {
        tables[table] = rows.slice(0, MAX_ROWS_PER_TABLE);
        counts[table] = MAX_ROWS_PER_TABLE;
        truncated.push(table);
      } else {
        tables[table] = rows;
        counts[table] = rows.length;
      }
    }

    const exportedAt = Date.now();
    const body = {
      format: 'grid-backup',
      formatVersion: 1,
      exportedAt,
      server: { version: VERSION, driver: db.driver },
      account: { id: String(user[0].id), email: String(user[0].email), createdAt: Number(user[0].created_at) },
      counts,
      truncated,
      tables,
    };

    const stamp = formatStamp(exportedAt);
    const json = JSON.stringify(body);

    // inline=1 用于调试和"我就想看一眼"，其余情况触发下载
    const inline = (req.query as { inline?: string } | undefined)?.inline === '1';
    return reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename="grid-backup-${stamp}.json"`,
      )
      .type('application/json; charset=utf-8')
      .send(json);
  });

  /** 只取数量，给设置页显示"你现在有多少数据"，不发整个文件 */
  app.get('/export/stats', async (req) => {
    const userId = await requireUserId(req);
    const counts: Record<string, number> = {};
    for (const table of EXPORT_TABLES) {
      const rows = await db.query<{ c: unknown }>(
        `SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`,
        [userId],
      );
      counts[table] = Number(rows[0]?.c ?? 0);
    }
    return { counts, tables: EXPORT_TABLES };
  });
}

/** 2026-11-24-2204，只用于文件名，不进数据库 */
function formatStamp(ts: number): string {
  const d = new Date(ts + 8 * 3600 * 1000); // 固定东八区：服务器可能是 UTC，文件名给人看的
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
