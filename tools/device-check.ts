/**
 * M6a 验收：Android 设备令牌。
 *
 * 对应 docs/06 的 A7 / A8 / A9 三条，加上文档没写但必须成立的几条：
 *   - 服务端只存 SHA-256，库里翻不出明文
 *   - 令牌**不能**签发令牌（否则偷到一个就能不断续命，"注销此设备"是假的）
 *   - 临期静默轮换只发生一次，新令牌经响应头交回，旧令牌有 24 小时宽限
 *
 * 全程走真实 HTTP（Fastify inject）+ 内存库，跑的是和线上同一份 routes/。
 * 用法：cd packages/server && ./node_modules/.bin/tsx ../../tools/device-check.ts
 */
process.env.DB_URL = 'sqlite::memory:';

import { createHash } from 'node:crypto';
import { buildApp } from '../packages/server/src/app.js';
import { DEVICE_TOKEN_PREFIX } from '../packages/server/src/auth/device-token.js';
import { createSession } from '../packages/server/src/auth/session.js';
import { createDb } from '../packages/server/src/db/index.js';
import { runMigrations } from '../packages/server/src/db/migrate.js';
import { loadEnv } from '../packages/server/src/env.js';
import { createUser } from '../packages/server/src/repo/users.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  ${detail}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? `= ${JSON.stringify(actual)}` : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const env = loadEnv();
if (!env.dbUrl.startsWith('sqlite:')) {
  console.error(`期望内存 sqlite，实际 ${env.dbUrl}：拒绝在真实库上跑验收`);
  process.exit(1);
}

const db = createDb(env.dbUrl);
await runMigrations(db);
const app = await buildApp({ env, db, startedAt: Date.now(), tokens: null });

const user = await createUser(db, 'device-check@example.invalid', 'not-a-real-hash');
const other = await createUser(db, 'device-check-2@example.invalid', 'not-a-real-hash');
const session = await createSession(db, user.id, env.sessionTtlMs);

// 只在这个脚本自建的临时库里有效（开头会重建 device-check 用户），
// 不要写成任何真实环境用过的口令——仓库是公开的。
const PASSWORD = 'device-check-only-passphrase';
// 直接用真实哈希，让 device-login 走完整校验链（含锁定计数器）
const { hashPassword } = await import('../packages/server/src/auth/password.js');
await db.query('UPDATE app_user SET password_hash = ? WHERE id = ?', [await hashPassword(PASSWORD), user.id]);

const CSRF = 'device-check-csrf-token-0123456789';
const sessionCookies = { [env.cookieName]: session.token, csrf: CSRF };

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function summary(token?: string) {
  return app.inject({
    method: 'GET',
    url: '/api/habits/summary',
    headers: token ? bearer(token) : {},
  });
}

async function row(sql: string, params: unknown[] = []): Promise<Record<string, unknown> | undefined> {
  const rows = await db.query<Record<string, unknown>>(sql, params);
  return rows[0];
}

console.log('\nM6a 验收：设备令牌\n');

// 1) 未认证一律 401
{
  const res = await summary();
  eq('既无 Cookie 也无 Bearer → 401', res.statusCode, 401);
  eq('错误码是 unauthenticated', (res.json() as { error: { code: string } }).error.code, 'unauthenticated');
}

// 2) App 设备登录（一步拿令牌，不落 Cookie）
let token = '';
{
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/device-login',
    payload: { email: 'device-check@example.invalid', password: PASSWORD, label: 'Pixel 8' },
  });
  eq('设备登录 200', res.statusCode, 200);
  const body = res.json() as { device: { token: string; expiresAt: number; label: string } };
  token = body.device.token;
  check('令牌带 grd_ 前缀', token.startsWith(DEVICE_TOKEN_PREFIX), token.slice(0, 8) + '…');
  eq('令牌长度 = 4 + 43（32 字节 base64url）', token.length, 47);
  eq('设备名被记下来', body.device.label, 'Pixel 8');
  const days = (body.device.expiresAt - Date.now()) / 86_400_000;
  check('有效期约 180 天', days > 179 && days <= 180, `${days.toFixed(1)} 天`);
  check('响应里没有 Cookie', !res.headers['set-cookie'], String(res.headers['set-cookie'] ?? '无'));
}

// 3) 密码错误仍被同一套锁定策略挡住
{
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/device-login',
    payload: { email: 'device-check@example.invalid', password: 'wrong-password' },
  });
  eq('密码错误 → 401', res.statusCode, 401);
}

// 4) 服务端只存 SHA-256
{
  const stored = await row('SELECT * FROM device_token WHERE user_id = ?', [user.id]);
  const hash = String(stored?.token_hash ?? '');
  eq('库里存的是 64 位十六进制', hash.length, 64);
  check('hash 就是令牌的 SHA-256', hash === createHash('sha256').update(token, 'utf8').digest('hex'));
  check('库里翻不到明文令牌', !JSON.stringify(stored).includes(token), '已确认');
}

// 5) A7：Bearer 能读也能写
{
  const read = await summary(token);
  eq('A7：Bearer 读 /api/habits/summary → 200', read.statusCode, 200);

  const now = Date.now();
  const taskId = 'DEVICECHECKTASK00000000001';
  const push = await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: bearer(token),
    payload: {
      deviceId: '01DEVICECHECKDEVICE0000001',
      ops: [
        {
          opId: 'DC1',
          table: 'task',
          action: 'create',
          id: taskId,
          baseRev: 0,
          fields: {
            title: '设备令牌写入的任务',
            listId: 'list-inbox',
            path: `${taskId}/`,
            depth: 0,
            quadrant: 1,
            important: true,
            urgent: true,
            priority: 0,
            allDay: true,
            tagIds: [],
            sortOrder: 1,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
          hlc: { wall: now, counter: 0, device: '01DEVICECHECKDEVICE0000001' },
        },
      ],
    },
  });
  eq('A7：Bearer 写 /api/sync/push → 200', push.statusCode, 200);
  eq('写入被接受', (push.json() as { results: { status: string }[] }).results[0]?.status, 'applied');
  const stored = await row('SELECT title FROM task WHERE id = ?', [taskId]);
  eq('任务真的落库了', stored?.title, '设备令牌写入的任务');
}

// 6) 伪造令牌
{
  const res = await summary('grd_totally-made-up-token-value-here-000000000');
  eq('伪造令牌 → 401', res.statusCode, 401);
  eq('错误码是 device_expired（App 据此提示重登，而不是跳登录页）', (res.json() as { error: { code: string } }).error.code, 'device_expired');
  const res2 = await app.inject({ method: 'GET', url: '/api/habits/summary', headers: { authorization: 'Bearer not-grd-prefixed' } });
  eq('无前缀的 Bearer 同样 401', res2.statusCode, 401);
}

// 7) A8：过期（把 expires_at 改到过去）
{
  await db.query('UPDATE device_token SET expires_at = ? WHERE user_id = ?', [Date.now() - 1000, user.id]);
  const res = await summary(token);
  eq('A8：过期令牌 → 401', res.statusCode, 401);
  eq('A8：错误码 device_expired', (res.json() as { error: { code: string } }).error.code, 'device_expired');
  // 复原，后面的用例还要用它
  await db.query('UPDATE device_token SET expires_at = ? WHERE user_id = ?', [Date.now() + 180 * 86_400_000, user.id]);
  const again = await summary(token);
  eq('复原有效期后又能用（过期判定没有留下副作用）', again.statusCode, 200);
}

// 8) 只有 Cookie 会话能签发令牌
{
  const viaDevice = await app.inject({
    method: 'POST',
    url: '/api/devices',
    headers: { ...bearer(token), 'x-csrf-token': CSRF },
    cookies: { csrf: CSRF },
    payload: { label: '偷偷生成' },
  });
  eq('设备令牌不能签发新令牌（403）', viaDevice.statusCode, 403);
  eq('理由写清楚了', (viaDevice.json() as { error: { code: string } }).error.code, 'session_required');

  const noCsrf = await app.inject({
    method: 'POST',
    url: '/api/devices',
    cookies: sessionCookies,
    payload: { label: '没带 CSRF' },
  });
  eq('Cookie 会话但缺 CSRF → 403', noCsrf.statusCode, 403);

  const ok = await app.inject({
    method: 'POST',
    url: '/api/devices',
    cookies: sessionCookies,
    headers: { 'x-csrf-token': CSRF },
    payload: { label: '备用手机' },
  });
  eq('Cookie 会话 + CSRF 可以签发', ok.statusCode, 200);
  const body = ok.json() as { token: string; label: string };
  check('新令牌同样是 grd_ 前缀', body.token.startsWith(DEVICE_TOKEN_PREFIX));
  eq('设备名正确', body.label, '备用手机');
}

// 9) 列表：最近使用时间会被刷新
{
  const before = await app.inject({ method: 'GET', url: '/api/devices', cookies: sessionCookies });
  eq('列表 200', before.statusCode, 200);
  const tokens = (before.json() as { tokens: { id: string; label: string; lastSeenAt: number }[] }).tokens;
  eq('有两台设备', tokens.length, 2);
  check('状态与顺序合理', tokens[0]?.label === '备用手机', tokens.map((t) => t.label).join(','));

  // 间隔超过节流窗口才会写 last_seen_at，这里直接把旧值压到 10 分钟前
  await db.query('UPDATE device_token SET last_seen_at = ? WHERE label = ?', [Date.now() - 600_000, 'Pixel 8']);
  await summary(token);
  const refreshed = await row("SELECT last_seen_at FROM device_token WHERE label = 'Pixel 8'");
  check('用过之后 last_seen_at 被更新', Number(refreshed?.last_seen_at) > Date.now() - 60_000);
}

// 10) A9：注销立即生效
{
  const target = await row("SELECT id FROM device_token WHERE label = 'Pixel 8'");
  const id = String(target?.id ?? '');

  // 别的用户注销不存在的 id → 404（不给"存在但不是你的"留探测口）
  const otherSession = await createSession(db, other.id, env.sessionTtlMs);
  const foreign = await app.inject({
    method: 'DELETE',
    url: `/api/devices/${id}`,
    cookies: { [env.cookieName]: otherSession.token, csrf: CSRF },
    headers: { 'x-csrf-token': CSRF },
  });
  eq('别的用户注销这个 id → 404', foreign.statusCode, 404);
  eq('别人的注销没有影响它', (await summary(token)).statusCode, 200);

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/devices/${id}`,
    cookies: sessionCookies,
    headers: { 'x-csrf-token': CSRF },
  });
  eq('A9：注销 200', del.statusCode, 200);
  const after = await summary(token);
  eq('A9：注销后立刻 401（不等过期）', after.statusCode, 401);

  const listed = await app.inject({ method: 'GET', url: '/api/devices', cookies: sessionCookies });
  const revoked = (listed.json() as { tokens: { label: string; revokedAt: number | null }[] }).tokens.find(
    (t) => t.label === 'Pixel 8',
  );
  check('设置页仍能看到这条记录并标为已注销', revoked?.revokedAt !== null && revoked?.revokedAt !== undefined);
}

// 11) 临期静默轮换
{
  const res = await app.inject({
    method: 'POST',
    url: '/api/devices',
    cookies: sessionCookies,
    headers: { 'x-csrf-token': CSRF },
    payload: { label: '快过期的手机' },
  });
  const oldToken = (res.json() as { token: string }).token;

  // 压到 3 天后到期：进入 7 天轮换窗口
  await db.query("UPDATE device_token SET expires_at = ? WHERE label = '快过期的手机'", [
    Date.now() + 3 * 86_400_000,
  ]);

  const used = await app.inject({ method: 'GET', url: '/api/habits/summary', headers: bearer(oldToken) });
  eq('临期令牌这次请求仍然成功', used.statusCode, 200);
  const fresh = used.headers['x-device-token'];
  check('响应头带回了新令牌', typeof fresh === 'string' && fresh.startsWith(DEVICE_TOKEN_PREFIX), String(fresh ?? '无').slice(0, 10) + '…');
  eq('响应被标记为不可缓存', used.headers['cache-control'], 'no-store');

  if (typeof fresh === 'string') {
    eq('旧令牌在宽限期内仍可用', (await summary(oldToken)).statusCode, 200);
    eq('新令牌可直接使用', (await summary(fresh)).statusCode, 200);

    // 旧令牌的宽限期结束 → 失效；新令牌仍是完整 180 天
    await db.query("UPDATE device_token SET expires_at = ? WHERE label = '快过期的手机' AND rotated_to IS NOT NULL", [
      Date.now() - 1000,
    ]);
    eq('宽限期过后旧令牌失效', (await summary(oldToken)).statusCode, 401);
    eq('新令牌不受影响', (await summary(fresh)).statusCode, 200);

    // 已经轮换过的行不会再轮换第二次（否则每次请求都产生一把新钥匙）
    const rotatedRows = await db.query<{ c: unknown }>(
      "SELECT COUNT(*) AS c FROM device_token WHERE label = '快过期的手机'",
      [],
    );
    eq('这条设备链上共 2 行（原始 + 轮换出来的）', Number(rotatedRows[0]?.c ?? 0), 2);
    const reUse = await app.inject({ method: 'GET', url: '/api/habits/summary', headers: bearer(fresh) });
    check('新令牌不会继续触发轮换', !reUse.headers['x-device-token'], String(reUse.headers['x-device-token'] ?? '无'));
  }
}

// 12) 移除已失效的记录（清理列表用，但绝不能绕过吊销）
{
  const active = await row("SELECT id FROM device_token WHERE label = '备用手机'");
  const bad = await app.inject({
    method: 'DELETE',
    url: `/api/devices/${String(active?.id ?? '')}?purge=1`,
    cookies: sessionCookies,
    headers: { 'x-csrf-token': CSRF },
  });
  eq('仍然有效的令牌不能"移除记录"（409）', bad.statusCode, 409);

  const revokedRow = await row("SELECT id FROM device_token WHERE label = 'Pixel 8'");
  const ok = await app.inject({
    method: 'DELETE',
    url: `/api/devices/${String(revokedRow?.id ?? '')}?purge=1`,
    cookies: sessionCookies,
    headers: { 'x-csrf-token': CSRF },
  });
  eq('已注销的记录可以移除', ok.statusCode, 200);
  const left = await db.query<{ c: unknown }>("SELECT COUNT(*) AS c FROM device_token WHERE label = 'Pixel 8'");
  eq('库里真的删掉了', Number(left[0]?.c ?? 0), 0);
}

await app.close();

console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}\n`);
if (fail > 0) process.exitCode = 1;
