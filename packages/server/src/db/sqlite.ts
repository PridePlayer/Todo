import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db, Row, SqlExecutor } from './types.js';

/**
 * 开发用驱动：Node 22.5+ 内置的 node:sqlite。
 * 选它的唯一理由是「零安装」——本地不需要 MySQL、Docker 或任何原生编译。
 * 生产仍用 MySQL，两者共用同一套 SQL（见 ./types.ts 的可移植约束）。
 */
export function createSqliteDb(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
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
