import type { Db } from '../db/types.js';

/**
 * 与 packages/core/src/models/session.ts 中的常量保持一致（M2 会把 core 变成构建产物后改为直接引用）。
 * 单用户场景不做验证码，只做「连续失败锁定」，要求是重启后不清零 —— 所以必须落库。
 */
const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000;

interface AttemptRow {
  failed_count: number | string;
  locked_until: number | string | null;
  first_failed_at: number | string | null;
}

export interface LockState {
  locked: boolean;
  failedCount: number;
  lockedUntil: number | null;
  remainingAttempts: number;
}

function toNum(v: number | string | null): number {
  if (v === null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

async function readAttempt(db: Db, email: string): Promise<AttemptRow | null> {
  const rows = await db.query<AttemptRow>(
    'SELECT failed_count, locked_until, first_failed_at FROM login_attempt WHERE email = ?',
    [email],
  );
  return rows[0] ?? null;
}

export async function getLockState(db: Db, email: string, now = Date.now()): Promise<LockState> {
  const row = await readAttempt(db, email);
  if (!row) return { locked: false, failedCount: 0, lockedUntil: null, remainingAttempts: MAX_FAILURES };

  const lockedUntil = row.locked_until === null ? null : toNum(row.locked_until);
  if (lockedUntil !== null && lockedUntil > now) {
    return { locked: true, failedCount: toNum(row.failed_count), lockedUntil, remainingAttempts: 0 };
  }

  // 锁已过期 → 计数归零重新开始
  const failedCount = lockedUntil !== null ? 0 : toNum(row.failed_count);
  return {
    locked: false,
    failedCount,
    lockedUntil: null,
    remainingAttempts: Math.max(0, MAX_FAILURES - failedCount),
  };
}

/**
 * 记一次失败。第 5 次失败时写入锁定，但本次响应仍按「密码不正确」返回，
 * 从第 6 次开始才是 429 —— 这样用户能明确知道「我刚踩到上限」，而不是莫名其妙被拒。
 */
export async function registerFailure(db: Db, email: string, now = Date.now()): Promise<LockState> {
  const state = await getLockState(db, email, now);
  const failedCount = state.failedCount + 1;
  const lockedUntil = failedCount >= MAX_FAILURES ? now + LOCK_MS : null;
  const existing = await readAttempt(db, email);

  if (existing) {
    await db.query(
      'UPDATE login_attempt SET failed_count = ?, locked_until = ?, first_failed_at = ?, updated_at = ? WHERE email = ?',
      [failedCount, lockedUntil, state.failedCount === 0 ? now : (existing.first_failed_at ?? now), now, email],
    );
  } else {
    await db.query(
      'INSERT INTO login_attempt (email, failed_count, locked_until, first_failed_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [email, failedCount, lockedUntil, now, now],
    );
  }

  return {
    locked: lockedUntil !== null,
    failedCount,
    lockedUntil,
    remainingAttempts: Math.max(0, MAX_FAILURES - failedCount),
  };
}

export async function clearFailures(db: Db, email: string): Promise<void> {
  await db.query('DELETE FROM login_attempt WHERE email = ?', [email]);
}

export const lockoutPolicy = { MAX_FAILURES, LOCK_MINUTES: LOCK_MS / 60_000 } as const;
