import type { Db } from '../db/types.js';
import { randomToken, sha256Hex } from '../util/crypto.js';

const ABSOLUTE_MAX_MS = 90 * 24 * 60 * 60 * 1000;
/** last_seen_at 的写入节流，避免每个请求都打一次 UPDATE */
const TOUCH_INTERVAL_MS = 60_000;

interface SessionRow {
  user_id: string;
  created_at: number | string;
  last_seen_at: number | string;
  expires_at: number | string;
}

export interface SessionMeta {
  userAgent?: string | undefined;
  ipHash?: string | undefined;
}

function num(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

export async function createSession(
  db: Db,
  userId: string,
  ttlMs: number,
  meta: SessionMeta = {},
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  await db.query(
    'INSERT INTO session (id_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip_hash) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      sha256Hex(token),
      userId,
      now,
      now,
      expiresAt,
      meta.userAgent ? meta.userAgent.slice(0, 255) : null,
      meta.ipHash ?? null,
    ],
  );
  return { token, expiresAt };
}

/**
 * 校验会话。过期就顺手删掉，不留在表里等清理任务。
 * 除了滑动过期，还有 90 天绝对上限：否则一个被偷走的 cookie 可以无限续命。
 */
export async function resolveSession(db: Db, token: string, ttlMs: number): Promise<string | null> {
  if (!token) return null;
  const idHash = sha256Hex(token);
  const rows = await db.query<SessionRow>(
    'SELECT user_id, created_at, last_seen_at, expires_at FROM session WHERE id_hash = ?',
    [idHash],
  );
  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  const createdAt = num(row.created_at);
  const expiresAt = num(row.expires_at);

  if (expiresAt <= now || createdAt + ABSOLUTE_MAX_MS <= now) {
    await db.query('DELETE FROM session WHERE id_hash = ?', [idHash]);
    return null;
  }

  // 滑动续期：最多续到「创建时间 + 90 天」，不会无限延长
  if (now - num(row.last_seen_at) > TOUCH_INTERVAL_MS) {
    const nextExpiry = Math.min(now + ttlMs, createdAt + ABSOLUTE_MAX_MS);
    await db.query('UPDATE session SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', [
      now,
      nextExpiry,
      idHash,
    ]);
  }

  return row.user_id;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  if (!token) return;
  await db.query('DELETE FROM session WHERE id_hash = ?', [sha256Hex(token)]);
}

export async function deleteExpiredSessions(db: Db): Promise<void> {
  await db.query('DELETE FROM session WHERE expires_at <= ?', [Date.now()]);
}
