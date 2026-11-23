import type { Db } from '../db/types.js';
import { ulid } from '../util/crypto.js';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: number | string;
  updated_at: number | string;
}

export interface PublicUser {
  id: string;
  email: string;
  createdAt: number;
}

function toNum(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

/** 白名单映射：新增任何服务端字段都不会顺手泄漏出去 */
export function toPublicUser(row: UserRow): PublicUser {
  return { id: row.id, email: row.email, createdAt: toNum(row.created_at) };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const rows = await db.query<UserRow>(
    'SELECT id, email, password_hash, created_at, updated_at FROM app_user WHERE email = ?',
    [normalizeEmail(email)],
  );
  return rows[0] ?? null;
}

export async function findUserById(db: Db, id: string): Promise<UserRow | null> {
  const rows = await db.query<UserRow>(
    'SELECT id, email, password_hash, created_at, updated_at FROM app_user WHERE id = ?',
    [id],
  );
  return rows[0] ?? null;
}

export async function createUser(db: Db, email: string, passwordHash: string): Promise<UserRow> {
  const now = Date.now();
  const row: UserRow = {
    id: ulid(now),
    email: normalizeEmail(email),
    password_hash: passwordHash,
    created_at: now,
    updated_at: now,
  };
  await db.query(
    'INSERT INTO app_user (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [row.id, row.email, row.password_hash, row.created_at, row.updated_at],
  );
  return row;
}

export async function updatePasswordHash(db: Db, userId: string, passwordHash: string): Promise<void> {
  await db.query('UPDATE app_user SET password_hash = ?, updated_at = ? WHERE id = ?', [
    passwordHash,
    Date.now(),
    userId,
  ]);
  // 改密码即失效所有会话：否则旧设备上的登录态永远不会掉
  await db.query('DELETE FROM session WHERE user_id = ?', [userId]);
}

export async function countUsers(db: Db): Promise<number> {
  const rows = await db.query<{ c: number | string }>('SELECT COUNT(*) AS c FROM app_user');
  return toNum(rows[0]?.c ?? 0);
}
