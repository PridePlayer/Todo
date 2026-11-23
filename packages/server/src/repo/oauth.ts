import type { Db } from '../db/types.js';

export interface OauthAccountRow {
  id: string;
  user_id: string;
  provider: string;
  account_id: string;
  email: string | null;
  display_name: string | null;
  tenant_id: string | null;
  scope: string | null;
  access_token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: number | string;
  status: string;
  last_error: string | null;
  last_verified_at: number | string | null;
  created_at: number | string;
  updated_at: number | string;
}

const COLUMNS =
  'id, user_id, provider, account_id, email, display_name, tenant_id, scope, ' +
  'access_token_enc, refresh_token_enc, token_expires_at, status, last_error, ' +
  'last_verified_at, created_at, updated_at';

export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function findAccountByUser(db: Db, userId: string): Promise<OauthAccountRow | null> {
  const rows = await db.query<OauthAccountRow>(
    `SELECT ${COLUMNS} FROM oauth_account WHERE user_id = ? AND provider = 'microsoft'`,
    [userId],
  );
  return rows[0] ?? null;
}

export interface UpsertAccountInput {
  id: string;
  userId: string;
  accountId: string;
  email: string | null;
  displayName: string | null;
  tenantId: string | null;
  scope: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: number;
}

/**
 * 先查再写，不用 ON DUPLICATE KEY / ON CONFLICT：
 * 两个驱动共用的 SQL 里不能出现任何一种方言专属 upsert。
 */
export async function upsertAccount(db: Db, input: UpsertAccountInput): Promise<void> {
  const now = Date.now();
  const existing = await findAccountByUser(db, input.userId);

  if (!existing) {
    await db.query(
      `INSERT INTO oauth_account (${COLUMNS}) VALUES (?, ?, 'microsoft', ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?)`,
      [
        input.id,
        input.userId,
        input.accountId,
        input.email,
        input.displayName,
        input.tenantId,
        input.scope,
        input.accessTokenEnc,
        input.refreshTokenEnc,
        input.tokenExpiresAt,
        now,
        now,
      ],
    );
    return;
  }

  await db.query(
    'UPDATE oauth_account SET account_id = ?, email = ?, display_name = ?, tenant_id = ?, scope = ?, ' +
      'access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, status = ?, last_error = NULL, ' +
      'updated_at = ? WHERE user_id = ? AND provider = ?',
    [
      input.accountId,
      input.email,
      input.displayName,
      input.tenantId,
      input.scope,
      input.accessTokenEnc,
      input.refreshTokenEnc ?? existing.refresh_token_enc,
      input.tokenExpiresAt,
      'active',
      now,
      input.userId,
      'microsoft',
    ],
  );
}

export interface SaveTokensInput {
  accessTokenEnc: string;
  /** 微软轮换 refresh token 时会下发新的；没下发则传 null，保留旧值 */
  refreshTokenEnc: string | null;
  tokenExpiresAt: number;
  scope: string | null;
}

export async function saveTokens(db: Db, userId: string, input: SaveTokensInput): Promise<void> {
  const now = Date.now();
  if (input.refreshTokenEnc) {
    await db.query(
      'UPDATE oauth_account SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, ' +
        "scope = COALESCE(?, scope), status = 'active', last_error = NULL, updated_at = ? " +
        "WHERE user_id = ? AND provider = 'microsoft'",
      [input.accessTokenEnc, input.refreshTokenEnc, input.tokenExpiresAt, input.scope, now, userId],
    );
    return;
  }
  await db.query(
    'UPDATE oauth_account SET access_token_enc = ?, token_expires_at = ?, ' +
      "scope = COALESCE(?, scope), status = 'active', last_error = NULL, updated_at = ? " +
      "WHERE user_id = ? AND provider = 'microsoft'",
    [input.accessTokenEnc, input.tokenExpiresAt, input.scope, now, userId],
  );
}

export async function markNeedsReauth(db: Db, userId: string, reason: string): Promise<void> {
  await db.query(
    "UPDATE oauth_account SET status = 'needs_reauth', last_error = ?, updated_at = ? " +
      "WHERE user_id = ? AND provider = 'microsoft'",
    [reason.slice(0, 512), Date.now(), userId],
  );
}

export async function touchVerified(db: Db, userId: string): Promise<void> {
  await db.query(
    'UPDATE oauth_account SET last_verified_at = ? WHERE user_id = ? AND provider = ?',
    [Date.now(), userId, 'microsoft'],
  );
}

export async function deleteAccount(db: Db, userId: string): Promise<void> {
  await db.query("DELETE FROM oauth_account WHERE user_id = ? AND provider = 'microsoft'", [userId]);
}

export interface OauthStateRow {
  state_hash: string;
  user_id: string;
  code_verifier: string;
  redirect_uri: string;
  expires_at: number | string;
}

export async function createState(
  db: Db,
  input: { stateHash: string; userId: string; codeVerifier: string; redirectUri: string; ttlMs: number },
): Promise<void> {
  const now = Date.now();
  await db.query(
    'INSERT INTO oauth_state (state_hash, user_id, code_verifier, redirect_uri, created_at, expires_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
    [input.stateHash, input.userId, input.codeVerifier, input.redirectUri, now, now + input.ttlMs],
  );
}

/**
 * 取出并立即删除——state 是一次性的。
 * 先 SELECT 再 DELETE 而不是 DELETE ... RETURNING（SQLite 有、MySQL 没有）。
 */
export async function consumeState(db: Db, stateHash: string): Promise<OauthStateRow | null> {
  const rows = await db.query<OauthStateRow>(
    'SELECT state_hash, user_id, code_verifier, redirect_uri, expires_at FROM oauth_state WHERE state_hash = ?',
    [stateHash],
  );
  const row = rows[0];
  if (!row) return null;
  await db.query('DELETE FROM oauth_state WHERE state_hash = ?', [stateHash]);
  return row;
}

export async function deleteExpiredStates(db: Db): Promise<void> {
  await db.query('DELETE FROM oauth_state WHERE expires_at <= ?', [Date.now()]);
}
