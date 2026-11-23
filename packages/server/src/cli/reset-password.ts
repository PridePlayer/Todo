import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { checkPasswordPolicy, hashPassword } from '../auth/password.js';
import { createDb, runMigrations } from '../db/index.js';
import { loadEnv } from '../env.js';
import { findUserByEmail, listUsers, updatePasswordHash } from '../repo/users.js';

const HELP = `
重置管理员密码（不做邮件找回 —— 单用户场景自建发信是过度设计）。

用法：
  pnpm --filter @grid/server reset:password --list
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
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const env = loadEnv();
const db = createDb(env.dbUrl);

try {
  await runMigrations(db, () => {});

  // ── 只列账号：不碰密码，用于"我到底注册的是哪个邮箱"这种时刻 ──
  if (values.list) {
    const all = await listUsers(db);
    if (all.length === 0) {
      console.log('\n库里还没有任何账号。先创建：');
      console.log("  pnpm --filter @grid/server seed:user --email you@example.com --password '至少12位'\n");
    } else {
      console.log(`\n共 ${all.length} 个账号：`);
      for (const u of all) {
        console.log(`  ${u.email}    建于 ${new Date(u.createdAt).toISOString().slice(0, 10)}`);
      }
      console.log('');
    }
    process.exit(0);
  }

  const email = values.email?.trim().toLowerCase();
  if (!email) {
    console.error('✗ 缺少 --email（不确定账号是哪个邮箱的话，先跑 --list）\n\n' + HELP);
    process.exit(1);
  }

  const generated = values.password ? null : generatePassword();
  const password = values.password ?? generated!;
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) {
    console.error(`✗ ${policy.message}`);
    process.exit(1);
  }

  const user = await findUserByEmail(db, email);
  if (!user) {
    // 只说"账号不存在"等于把已知的信息藏起来 —— 库里就有答案，
    // 用户却得为此去开 phpMyAdmin 或 mysql 客户端。
    console.error(`✗ 账号不存在：${email}`);
    const all = await listUsers(db);
    if (all.length === 0) {
      console.error('  库里还没有任何账号，先创建：');
      console.error("    pnpm --filter @grid/server seed:user --email 你的邮箱 --password '至少12位'");
    } else {
      console.error('  库里现有账号（复制完整地址重试）：');
      for (const u of all) console.error(`    - ${u.email}`);
    }
    console.error('');
    process.exit(1);
  }

  await updatePasswordHash(db, user.id, await hashPassword(password));
  console.log(`\n✓ 已重置 ${email} 的密码，所有旧会话已失效`);
  if (generated) console.log(`  新密码：${generated}\n  ↑ 只显示这一次，请立刻存进密码管理器\n`);
  else console.log('');
} finally {
  await db.close();
}
