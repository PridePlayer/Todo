import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser as authenticateRequest } from '../auth/require.js';
import { verifyCsrfToken } from '../auth/csrf.js';
import type { Db } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { HttpError } from '../http/errors.js';
import { readSyncState } from '../graph/delta.js';
import { loadSources, refreshSources } from '../graph/sources.js';
import { NotConnectedError, ReauthRequiredError, type GraphTokens } from '../graph/token.js';
import { runCalendarSync } from '../jobs/calendar.js';
import { findAccountByUser, num } from '../repo/oauth.js';

/**
 * 日历相关的人机接口（不是同步协议的一部分）。
 *
 * 划分原则：
 *   /api/sync/*      —— 客户端与服务端之间的**数据**通道（change_seq 增量）
 *   /api/calendar/*  —— 人与 Outlook 之间的**控制**通道（立即同步、开关日历源）
 * 两者混在一起会让"离线可用"的边界变模糊：控制通道必须在线，数据通道不必。
 */

interface Deps {
  db: Db;
  env: AppEnv;
  tokens: GraphTokens | null;
}

export async function calendarRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { db, env, tokens } = deps;

  // 统一鉴权：Cookie 会话（Web）与 Bearer 设备令牌（Android）都从这里进
  const requireUser = (req: FastifyRequest): Promise<string> => authenticateRequest(db, env, req);

  function requireGraph(): GraphTokens {
    if (!tokens) {
      throw new HttpError(503, 'oauth_not_configured', '服务端未配置 Microsoft OAuth，日历同步不可用');
    }
    return tokens;
  }

  app.get('/calendar/status', async (req) => {
    const userId = await requireUser(req);
    const account = await findAccountByUser(db, userId);
    const state = await readSyncState(db, userId);
    const sources = await loadSources(db, userId);

    return {
      configured: env.oauth.enabled,
      connected: account !== null,
      email: account?.email ?? account?.display_name ?? null,
      accountStatus: account?.status ?? null,
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError,
      reauthRequired: account?.status === 'needs_reauth',
      pendingWrites: state.pendingOutbox,
      deadWrites: state.deadOutbox,
      events: state.events,
      tokenExpiresAt: account ? num(account.token_expires_at) : null,
      sources: sources.map((row) => ({
        id: row.id,
        name: row.name,
        isVisible: Number(row.is_visible) === 1,
        isSynced: Number(row.is_synced) === 1,
        canEdit: Number(row.can_edit) === 1,
        isDefault: Number(row.is_default) === 1,
        colorKey: Number(row.color_key),
        sortOrder: Number(row.sort_order),
      })),
    };
  });

  /**
   * 立即同步：前端在日历页打开时每 30 秒戳一次。
   * 为什么不只靠后台定时器：用户刚在 Outlook 改了会议就切回 GRID，
   * 等 30 秒才看到变化会被当成"没同步上"。
   */
  app.post('/calendar/sync', async (req) => {
    if (!verifyCsrfToken(req)) throw new HttpError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
    const userId = await requireUser(req);
    const graph = requireGraph();

    try {
      const result = await runCalendarSync(db, graph, userId);
      return {
        ok: result.error === null,
        reauthRequired: result.reauthRequired,
        error: result.error,
        added: result.pulled.added,
        updated: result.pulled.updated,
        removed: result.pulled.removed,
        pushed: result.pushed.done,
        deadWrites: result.pushed.dead,
      };
    } catch (err) {
      if (err instanceof NotConnectedError) throw new HttpError(404, 'not_connected', '尚未连接 Microsoft 账号');
      if (err instanceof ReauthRequiredError) throw new HttpError(409, 'reauth_required', err.reason);
      throw err;
    }
  });

  /** 重新发现日历列表（用户新建/删除了日历之后） */
  app.post('/calendar/sources/refresh', async (req) => {
    if (!verifyCsrfToken(req)) throw new HttpError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
    const userId = await requireUser(req);
    const graph = requireGraph();

    const account = await findAccountByUser(db, userId);
    if (!account) throw new HttpError(404, 'not_connected', '尚未连接 Microsoft 账号');

    const accessToken = await graph.accessTokenFor(userId);
    const rows = await refreshSources(db, userId, account.id, accessToken);
    return {
      sources: rows.map((row) => ({
        id: row.id,
        name: row.name,
        isVisible: Number(row.is_visible) === 1,
        isSynced: Number(row.is_synced) === 1,
        canEdit: Number(row.can_edit) === 1,
      })),
    };
  });

  /**
   * 单个日历源的显示/同步开关。
   *
   * 走接口而不是同步协议：这个操作**必须在线生效**（用户点一下就要看到日历消失），
   * 而且它改的是"这一端看什么"，不是需要字段级合并的业务数据。
   * 写入时抬高 change_seq，其它设备照样能通过增量拉到。
   */
  app.patch('/calendar/sources/:id', async (req) => {
    if (!verifyCsrfToken(req)) throw new HttpError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
    const userId = await requireUser(req);
    const params = req.params as { id?: string };
    const id = typeof params.id === 'string' ? params.id : '';
    if (id === '') throw new HttpError(400, 'bad_request', '缺少日历源 id');

    const body = (req.body ?? {}) as { isVisible?: unknown; isSynced?: unknown };
    const wantVisible = typeof body.isVisible === 'boolean' ? body.isVisible : null;
    const wantSynced = typeof body.isSynced === 'boolean' ? body.isSynced : null;
    if (wantVisible === null && wantSynced === null) {
      throw new HttpError(400, 'bad_request', '至少要指定 isVisible 或 isSynced');
    }

    const rows = await db.query<{ id: string; is_visible: number; is_synced: number }>(
      'SELECT id, is_visible, is_synced FROM calendar_source WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [id, userId],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, 'not_found', '没有这个日历源');

    const nextVisible = wantVisible === null ? Number(row.is_visible) : wantVisible ? 1 : 0;
    const nextSynced = wantSynced === null ? Number(row.is_synced) : wantSynced ? 1 : 0;

    await db.transaction(async (tx) => {
      const seq = await db.nextSeq(tx);
      const now = Date.now();
      await tx.query(
        'UPDATE calendar_source SET is_visible = ?, is_synced = ?, rev = rev + 1, change_seq = ?, updated_at = ? WHERE id = ?',
        [nextVisible, nextSynced, seq, now, id],
      );
    });

    return { ok: true, isVisible: nextVisible === 1, isSynced: nextSynced === 1 };
  });
}
