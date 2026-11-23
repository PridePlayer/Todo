import { createDb, runMigrations } from '../db/index.js';
import { loadEnv } from '../env.js';

const env = loadEnv();
const db = createDb(env.dbUrl);

console.log(`[migrate] 目标：${db.label}`);

try {
  const ran = await runMigrations(db, (msg) => console.log(`[migrate] ${msg}`));
  if (ran.length === 0) {
    console.log('[migrate] 无变更，数据库已是最新');
  } else {
    console.log(`[migrate] 完成，应用 ${ran.length} 个迁移文件`);
  }
} finally {
  await db.close();
}
