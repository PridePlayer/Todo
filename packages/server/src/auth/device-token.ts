import type { Db, SqlExecutor } from '../db/types.js';
import { randomToken, sha256Hex, ulid } from '../util/crypto.js';

/**
 * Android 设备令牌（docs/02 §5.3）。
 *
 * 与 Web 的 Cookie 会话是**两套**东西，不只是"换了个传输方式"：
 *   - Web 有浏览器帮忙带 Cookie、有 SameSite 挡 CSRF；App 两样都没有，
 *     所以它用 Bearer 头，天然不参与 CSRF（攻击者的页面带不上这个头）。
 *   - Web 会话 30 天滑动；App 令牌 180 天 + 临期静默轮换，
 *     因为"每 30 天让用户在手机上重新输一次密码"是会被卸载的功能。
 *
 * 令牌只存 SHA-256，且明文只在签发那一次返回。服务端事后无法重建令牌——
 * 这不是限制，而是要求：能重建就意味着库泄露 = 全部设备失守。
 */

/** 前缀让令牌能在日志/日志脱敏规则里被一眼认出来 */
export const DEVICE_TOKEN_PREFIX = 'grd_';

/**
 * 令牌能做的事。
 *
 * full    —— App 主令牌。sync、export、日历、签发子令牌，全都能做。
 * widget  —— 桌面小组件专用。只能读 /api/widget/summary。
 *
 * 为什么要分：小组件跑在 headless JS 里，令牌只能存明文（SecureStore 能否在
 * 那个上下文解密尚未验证）。既然保管强度降了，就必须让它即使被读走也只泄露
 * 「今天有几条待办、哪几个习惯打了卡」，而不是整个账号。
 */
export type DeviceScope = 'full' | 'widget';

export const DEVICE_SCOPE_FULL: DeviceScope = 'full';
export const DEVICE_SCOPE_WIDGET: DeviceScope = 'widget';

/** 库里旧行的 scope 是 NULL，一律按 full 处理（迁移不回填） */
export function normalizeScope(value: string | null | undefined): DeviceScope {
  return value === 'widget' ? 'widget' : 'full';
}
/** 180 天 */
export const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** 小组件只读令牌：90 天，到期由 App 重新签发（不轮换） */
export const WIDGET_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 剩余不足 7 天就静默轮换，避免"用户某天打开 App 突然要求重新登录" */
export const DEVICE_ROTATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 旧令牌的宽限期：设备端可能还在用上一次响应之前的那份 */
export const DEVICE_GRACE_MS = 24 * 60 * 60 * 1000;
/** last_seen_at 写入节流，避免每个请求都打一次 UPDATE */
const TOUCH_INTERVAL_MS = 60_000;

const HASH_RE = /^[0-9a-f]{64}$/;

export interface DeviceTokenInfo {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** 已吊销 / 已过期仍会列出来（设置页要显示"已失效"，否则用户以为记录丢了） */
  revokedAt: number | null;
  rotatedTo: string | null;
  scope: DeviceScope;
}

export interface IssuedDeviceToken extends DeviceTokenInfo {
  /** 明文令牌，只在这一刻存在 */
  token: string;
}

interface Row {
  id: string;
  user_id: string;
  label: string;
  created_at: number | string;
  last_seen_at: number | string;
  expires_at: number | string;
  rotated_to: string | null;
  revoked_at: number | string | null;
  scope: string | null;
}

function num(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
}

function toInfo(row: Row): DeviceTokenInfo {
  return {
    id: row.id,
    label: row.label,
    createdAt: num(row.created_at) ?? 0,
    lastSeenAt: num(row.last_seen_at) ?? 0,
    expiresAt: num(row.expires_at) ?? 0,
    revokedAt: num(row.revoked_at),
    rotatedTo: row.rotated_to,
    scope: normalizeScope(row.scope),
  };
}

function normalizeLabel(label: string | undefined): string {
  const clean = (label ?? '').trim().slice(0, 64);
  return clean === '' ? '未命名设备' : clean;
}

async function insert(
  db: SqlExecutor,
  userId: string,
  label: string,
  ttlMs: number,
  now: number,
  scope: DeviceScope,
): Promise<IssuedDeviceToken> {
  const token = `${DEVICE_TOKEN_PREFIX}${randomToken(32)}`;
  const id = ulid(now);
  await db.query(
    'INSERT INTO device_token (id, user_id, token_hash, label, created_at, last_seen_at, expires_at, rotated_to, revoked_at, scope) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
    [id, userId, sha256Hex(token), normalizeLabel(label), now, now, now + ttlMs, scope],
  );
  return {
    id,
    token,
    label: normalizeLabel(label),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + ttlMs,
    revokedAt: null,
    rotatedTo: null,
    scope,
  };
}

export async function issueDeviceToken(
  db: Db,
  userId: string,
  label?: string,
  scope: DeviceScope = DEVICE_SCOPE_FULL,
): Promise<IssuedDeviceToken> {
  // 小组件令牌过期不轮换（它跑在没有响应头可读的 headless 里），所以 TTL 短一档：
  // 180 天的明文只读令牌放在应用私有目录里，太久没有理由。
  const ttl = scope === DEVICE_SCOPE_WIDGET ? WIDGET_TOKEN_TTL_MS : DEVICE_TTL_MS;
  return insert(db, userId, normalizeLabel(label), ttl, Date.now(), scope);
}

/**
 * 校验 Bearer 令牌。
 *
 * 返回 `rotated` 时调用方必须把它写进响应头：设备端只有这一个机会拿到新令牌，
 * 而它此刻正在用的旧令牌 24 小时后就会失效。丢了这个头 → 用户第二天被登出。
 */
export async function resolveDeviceToken(
  db: Db,
  raw: string,
): Promise<{
  userId: string;
  id: string;
  expiresAt: number;
  scope: DeviceScope;
  rotated: IssuedDeviceToken | null;
} | null> {
  if (typeof raw !== 'string' || !raw.startsWith(DEVICE_TOKEN_PREFIX)) return null;

  const hash = sha256Hex(raw);
  if (!HASH_RE.test(hash)) return null;

  const rows = await db.query<Row & { token_hash: string }>(
    'SELECT id, user_id, token_hash, label, created_at, last_seen_at, expires_at, rotated_to, revoked_at, scope ' +
      'FROM device_token WHERE token_hash = ?',
    [hash],
  );
  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  const expiresAt = num(row.expires_at) ?? 0;
  if (row.revoked_at !== null || expiresAt <= now) return null;

  const lastSeen = num(row.last_seen_at) ?? 0;
  const scope = normalizeScope(row.scope);
  const nearExpiry = expiresAt - now <= DEVICE_ROTATE_WINDOW_MS;

  // 小组件令牌不轮换：轮换后的新令牌只能通过响应头交回客户端，
  // 而 headless JS 里没有人读那个头 —— 轮换等于静默自杀。
  if (scope === 'full' && nearExpiry && row.rotated_to === null) {
    const rotated = await rotate(db, row, now);
    if (rotated) {
      return { userId: row.user_id, id: row.id, expiresAt, scope, rotated };
    }
    // 并发下另一个请求已经轮换过：正常放行，本轮不带新令牌（对方那次响应里已给过）
  } else if (now - lastSeen > TOUCH_INTERVAL_MS) {
    await db.query('UPDATE device_token SET last_seen_at = ? WHERE id = ?', [now, row.id]);
  }

  return { userId: row.user_id, id: row.id, expiresAt, scope, rotated: null };
}

/**
 * 轮换：签发新令牌，旧令牌进入 24 小时宽限。
 *
 * 用事务 + `rotated_to IS NULL` 条件更新来防"两个并发请求各轮换一次"：
 * 那样会产生两个都有效的令牌，而设置页只会显示一条链，谁在用就说不清了。
 */
async function rotate(db: Db, row: Row, now: number): Promise<IssuedDeviceToken | null> {
  return db.transaction(async (tx) => {
    const fresh = await tx.query<{ rotated_to: string | null }>(
      'SELECT rotated_to FROM device_token WHERE id = ?',
      [row.id],
    );
    if (!fresh[0] || fresh[0].rotated_to !== null) return null;

    const issued = await insert(tx, row.user_id, row.label, DEVICE_TTL_MS, now, normalizeScope(row.scope));
    await tx.query('UPDATE device_token SET expires_at = ?, rotated_to = ? WHERE id = ?', [
      now + DEVICE_GRACE_MS,
      issued.id,
      row.id,
    ]);
    return issued;
  });
}

/**
 * 签发小组件只读令牌。
 *
 * 签发前把该用户之前仍未失效的 widget 令牌全部吊销：App 每次启动都可能续签，
 * 不吊销的话表里会堆一串都能用的只读令牌，泄露面随使用时长线性扩大。
 * 旧令牌立刻失效不会打断小组件 —— 它拿到的是本轮新签发的那把。
 */
export async function issueWidgetToken(db: Db, userId: string): Promise<IssuedDeviceToken> {
  await db.query(
    "UPDATE device_token SET revoked_at = ? WHERE user_id = ? AND scope = 'widget' AND revoked_at IS NULL",
    [Date.now(), userId],
  );
  return issueDeviceToken(db, userId, '桌面小组件', DEVICE_SCOPE_WIDGET);
}

export async function listDeviceTokens(db: Db, userId: string): Promise<DeviceTokenInfo[]> {
  // 只列全权令牌：widget 令牌是设备自己派生出来的，设置页该显示"几台设备"，
  // 而不是同一台设备下挂着的主/子两条记录（子令牌吊销了用户也不会理解意味着什么）。
  const rows = await db.query<Row>(
    'SELECT id, user_id, label, created_at, last_seen_at, expires_at, rotated_to, revoked_at, scope ' +
      "FROM device_token WHERE user_id = ? AND (scope IS NULL OR scope <> 'widget') ORDER BY created_at DESC",
    [userId],
  );
  return rows.map(toInfo);
}

/**
 * 吊销（「注销此设备」）。
 *
 * 立即生效：不等过期，也不保留宽限——用户的意图是"这台设备立刻不能再读我的数据"。
 * 返回 false 表示这个 id 不属于该用户（不给"存在但不是你的"留探测口）。
 */
export async function revokeDeviceToken(db: Db, userId: string, id: string): Promise<boolean> {
  const rows = await db.query<Row>('SELECT id, user_id, revoked_at FROM device_token WHERE id = ? AND user_id = ?', [
    id,
    userId,
  ]);
  if (rows.length === 0) return false;
  await db.query('UPDATE device_token SET revoked_at = ? WHERE id = ? AND user_id = ?', [Date.now(), id, userId]);
  return true;
}

export async function deleteExpiredDeviceTokens(db: Db): Promise<void> {
  // 过期一个月后才物理删：设置页要能看到"已失效"，否则用户以为是自己记错了
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await db.query('DELETE FROM device_token WHERE expires_at <= ?', [cutoff]);
}

/**
 * 把一条**已失效**的记录从列表里彻底清掉。
 *
 * 只允许清已吊销/已过期的行：这条路径一旦能删仍然有效的令牌，它就绕过了吊销，
 * 变成"删掉等于还能用"——那是最不该出现的语义。返回 false 表示不满足条件。
 */
export async function purgeDeviceToken(db: Db, userId: string, id: string): Promise<boolean> {
  const rows = await db.query<{ revoked_at: number | string | null; expires_at: number | string }>(
    'SELECT revoked_at, expires_at FROM device_token WHERE id = ? AND user_id = ?',
    [id, userId],
  );
  const row = rows[0];
  if (!row) return false;
  const revoked = row.revoked_at !== null && row.revoked_at !== undefined;
  const expired = (num(row.expires_at) ?? 0) <= Date.now();
  if (!revoked && !expired) return false;
  await db.query('DELETE FROM device_token WHERE id = ? AND user_id = ?', [id, userId]);
  return true;
}
