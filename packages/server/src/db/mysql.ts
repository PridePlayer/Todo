import mysql from 'mysql2/promise';
import type { Db, Row, SqlExecutor } from './types.js';

interface ParsedMysqlUrl {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * 自己解析而不是把整串丢给 mysql2：连接池参数要显式可控，
 * 免得默认值（connectionLimit 10）在 2G 机器上多占一份内存配额。
 */
function parseMysqlUrl(raw: string): ParsedMysqlUrl {
  const url = new URL(raw);
  if (url.protocol !== 'mysql:') {
    throw new Error(`DB_URL 协议不支持：${url.protocol}（只接受 mysql: 或 sqlite:）`);
  }
  const database = url.pathname.replace(/^\//, '');
  if (!database) throw new Error('DB_URL 缺少数据库名，例如 mysql://user:pass@127.0.0.1:3307/grid');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

export function createMysqlDb(raw: string): Db {
  const cfg = parseMysqlUrl(raw);
  const pool = mysql.createPool({
    ...cfg,
    waitForConnections: true,
    connectionLimit: 8,
    maxIdle: 4,
    idleTimeout: 30_000,
    enableKeepAlive: true,
    charset: 'utf8mb4_0900_ai_ci',
    // 我们只存 BIGINT 时间戳，显式声明避免任何本地时区参与换算
    timezone: 'Z',
    supportBigNumbers: true,
    // 安全：绝不允许一次执行多条语句（SQL 注入的最后一道墙）
    multipleStatements: false,
  });

  return {
    driver: 'mysql',
    label: `mysql:${cfg.host}:${cfg.port}/${cfg.database}`,

    async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const [rows] = await pool.query(sql, params as unknown[]);
      return rows as T[];
    },

    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },

    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const tx: SqlExecutor = {
          async query<R>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
            const [rows] = await conn.query(sql, params as unknown[]);
            return rows as R[];
          },
          async exec(sql: string): Promise<void> {
            await conn.query(sql);
          },
        };
        const result = await fn(tx);
        await conn.commit();
        return result;
      } catch (error) {
        try {
          await conn.rollback();
        } catch {
          // 连接已坏时回滚也会失败，保留原始错误
        }
        throw error;
      } finally {
        conn.release();
      }
    },

    async nextSeq(tx: SqlExecutor): Promise<number> {
      await tx.exec('UPDATE change_seq SET seq = seq + 1 WHERE id = 1');
      const rows = await tx.query<{ seq: number }>('SELECT seq FROM change_seq WHERE id = 1');
      // BIGINT 在 mysql2 下可能回传字符串，统一转数字
      const seq = Number(rows[0]?.seq);
      if (!Number.isFinite(seq) || seq <= 0) throw new Error('change_seq 未初始化');
      return seq;
    },

    async ping(): Promise<boolean> {
      try {
        const [rows] = await pool.query('SELECT 1 AS ok');
        return Array.isArray(rows) && rows.length > 0;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export type { Row };
