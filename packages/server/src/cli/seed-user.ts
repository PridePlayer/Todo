import { parseArgs } from 'node:util';
import { checkPasswordPolicy, hashPassword } from '../auth/password.js';
import { createDb, runMigrations } from '../db/index.js';
import { loadEnv } from '../env.js';
import { countUsers, createUser, findUserByEmail, listUsers } from '../repo/users.js';

const HELP = `
创建（唯一）管理员账号。

用法：
  pnpm --filter @grid/server seed:user --email you@example.com --password '至少12位'

可选：
  --force   已存在同邮箱账号时覆盖其密码
`.trim();

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const email = values.email?.trim().toLowerCase();
const password = values.password;
if (!email || !email.includes('@')) fail('缺少或非法的 --email');
if (!password) fail('缺少 --password');

const policy = checkPasswordPolicy(password);
if (!policy.ok) fail(policy.message ?? '密码不符合要求');

const env = loadEnv();
const db = createDb(env.dbUrl);

try {
  await runMigrations(db, (msg) => console.log(`[migrate] ${msg}`));

  const existing = await findUserByEmail(db, email);
  if (existing && !values.force) {
    fail(`账号 ${email} 已存在。要改密码请用 reset:password，或加 --force 覆盖`);
  }

  const total = await countUsers(db);
  if (!existing && total > 0) {
    const all = await listUsers(db);
    fail(
      `本系统是单用户模式，已存在 ${total} 个账号。请先删除多余账号再创建\n` +
        all.map((u) => `    - ${u.email}`).join('\n') +
        `\n\n  改密码不需要重建账号：pnpm --filter @grid/server reset:password --email <上面的地址>`,
    );
  }

  const passwordHash = await hashPassword(password);
  if (existing) {
    await db.query('UPDATE app_user SET password_hash = ?, updated_at = ? WHERE id = ?', [
      passwordHash,
      Date.now(),
      existing.id,
    ]);
    await db.query('DELETE FROM session WHERE user_id = ?', [existing.id]);
    console.log(`\n✓ 已重置密码：${email}（所有设备需要重新登录）\n`);
  } else {
    const user = await createUser(db, email, passwordHash);
    console.log(`\n✓ 账号已创建：${user.email}  id=${user.id}\n  现在可以 pnpm dev 登录了\n`);
  }
} finally {
  await db.close();
}
