import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { checkPasswordPolicy, hashPassword } from '../auth/password.js';
import { createDb, runMigrations } from '../db/index.js';
import { loadEnv } from '../env.js';
import { findUserByEmail, updatePasswordHash } from '../repo/users.js';

const HELP = `
重置管理员密码（不做邮件找回 —— 单用户场景自建发信是过度设计）。

用法：
  pnpm --filter @grid/server reset:password --email you@example.com
  pnpm --filter @grid/server reset:password --email you@example.com --password '新密码'

不给 --password 时自动生成一个 20 位随机密码并打印一次。
重置后该账号下所有会话立即失效。
`.trim();

// 去掉了 0/O/1/l/I 这类手抄易错的字符
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generatePassword(length = 20): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const email = values.email?.trim().toLowerCase();
if (!email) {
  console.error('✗ 缺少 --email\n\n' + HELP);
  process.exit(1);
}

const generated = values.password ? null : generatePassword();
const password = values.password ?? generated!;
const policy = checkPasswordPolicy(password);
if (!policy.ok) {
  console.error(`✗ ${policy.message}`);
  process.exit(1);
}

const env = loadEnv();
const db = createDb(env.dbUrl);

try {
  await runMigrations(db, () => {});
  const user = await findUserByEmail(db, email);
  if (!user) {
    console.error(`✗ 账号不存在：${email}`);
    process.exit(1);
  }
  await updatePasswordHash(db, user.id, await hashPassword(password));
  console.log(`\n✓ 已重置 ${email} 的密码，所有旧会话已失效`);
  if (generated) console.log(`  新密码：${generated}\n  ↑ 只显示这一次，请立刻存进密码管理器\n`);
  else console.log('');
} finally {
  await db.close();
}
