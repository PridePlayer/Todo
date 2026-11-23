import path from 'node:path';
import { repoRoot } from '../paths.js';
import { createMysqlDb } from './mysql.js';
import { createSqliteDb } from './sqlite.js';
import type { Db } from './types.js';

/** `sqlite:./.data/grid.db` 的相对路径以仓库根为基准，避免受进程 cwd 影响 */
export function resolveSqlitePath(spec: string): string {
  if (spec === '' || spec === ':memory:') return ':memory:';
  return path.isAbsolute(spec) ? spec : path.resolve(repoRoot, spec);
}

export function createDb(dbUrl: string): Db {
  if (dbUrl.startsWith('mysql://')) return createMysqlDb(dbUrl);
  if (dbUrl.startsWith('sqlite:')) {
    return createSqliteDb(resolveSqlitePath(dbUrl.slice('sqlite:'.length)));
  }
  throw new Error(
    `无法识别的 DB_URL：${dbUrl}\n` +
      '只支持两种写法：\n' +
      '  sqlite:./.data/grid.db\n' +
      '  mysql://user:pass@127.0.0.1:3307/grid',
  );
}

export { runMigrations } from './migrate.js';
export type { Db, DriverKind, Row } from './types.js';
