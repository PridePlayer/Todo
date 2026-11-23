import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './types.js';

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

  return {
    driver: 'sqlite',
    label: `sqlite:${file}`,

    async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const stmt = raw.prepare(sql);
      return stmt.all(...(params as never[])) as T[];
    },

    async exec(sql: string): Promise<void> {
      raw.exec(sql);
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
