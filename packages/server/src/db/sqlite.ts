import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Db, Row, SqlExecutor } from './types.js';

type DatabaseSyncCtor = new (file: string) => import('node:sqlite').DatabaseSync;

/**
 * 延迟到真正要用的时候才加载 node:sqlite。
 *
 * 写成静态 `import { DatabaseSync } from 'node:sqlite'` 时，Node < 22.5 会在
 * **进程启动第一步**就抛 ERR_UNKNOWN_BUILTIN_MODULE —— 哪怕生产环境配的是
 * `mysql://`、这个文件里的代码一行都不会执行。一个"只是本地开发用"的驱动
 * 于是变成了部署阻塞点，而且报错信息（找不到模块）和真实原因（版本不够）对不上。
 */
function loadSqlite(): DatabaseSyncCtor {
  const requireHere = createRequire(import.meta.url);
  try {
    return (requireHere('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
  } catch {
    throw new Error(
      '当前 Node 没有内置 node:sqlite（需要 22.5+）。\n' +
        '本地开发请升级 Node；生产环境把 DB_URL 配成 mysql://... 即可，不会走到这里。',
    );
  }
}

/**
 * 开发用驱动：Node 22.5+ 内置的 node:sqlite。
 * 选它的唯一理由是「零安装」——本地不需要 MySQL、Docker 或任何原生编译。
 * 生产仍用 MySQL，两者共用同一套 SQL（见 ./types.ts 的可移植约束）。
 */
export function createSqliteDb(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const DatabaseSync = loadSqlite();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  const txHandle: SqlExecutor = {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
    async exec(sql: string): Promise<void> {
      raw.exec(sql);
    },
  };

  // node:sqlite 是单连接同步驱动，事务必须排队执行：
  // 否则两个 async 事务会在 await 之间交错，一个的 ROLLBACK 会把另一个的写入一起丢掉。
  let chain: Promise<unknown> = Promise.resolve();

  return {
    driver: 'sqlite',
    label: `sqlite:${file}`,

    async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return txHandle.query<T>(sql, params);
    },

    async exec(sql: string): Promise<void> {
      raw.exec(sql);
    },

    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(txHandle);
          raw.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            // 回滚失败（连接已断）时保留原始错误，它更有诊断价值
          }
          throw error;
        }
      };
      const next = chain.then(run, run);
      chain = next.catch(() => undefined);
      return next;
    },

    async nextSeq(tx: SqlExecutor): Promise<number> {
      await tx.exec('UPDATE change_seq SET seq = seq + 1 WHERE id = 1');
      const rows = await tx.query<{ seq: number }>('SELECT seq FROM change_seq WHERE id = 1');
      const seq = rows[0]?.seq;
      if (typeof seq !== 'number') throw new Error('change_seq 未初始化');
      return seq;
    },

    async ping(): Promise<boolean> {
      try {
        raw.prepare('SELECT 1 AS ok').get();
        return true;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      raw.close();
    },
  };
}

export type { Row };
