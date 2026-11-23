import fs from 'node:fs';
import path from 'node:path';
import { migrationsDir } from '../paths.js';
import { splitStatements } from './split-sql.js';
import type { Db } from './types.js';

interface MigrationRow {
  name: string;
}

/**
 * 迁移只增不改：只允许「加表 / 加可空列 / 加索引」。
 * 这样代码回滚到上一片时，不需要同时回滚数据。
 */
export async function runMigrations(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS _migration (' +
      '  name VARCHAR(255) NOT NULL PRIMARY KEY,' +
      '  applied_at BIGINT NOT NULL' +
      ')',
  );

  const appliedRows = await db.query<MigrationRow>('SELECT name FROM _migration');
  const applied = new Set(appliedRows.map((r) => r.name));

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`迁移目录不存在：${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = splitStatements(sql);
    log(`migrate: ${file}（${statements.length} 条语句）`);
    for (const statement of statements) {
      await db.exec(statement);
    }
    await db.query('INSERT INTO _migration (name, applied_at) VALUES (?, ?)', [file, Date.now()]);
    ran.push(file);
  }

  if (ran.length === 0) log('migrate: 已是最新，无需变更');
  return ran;
}
