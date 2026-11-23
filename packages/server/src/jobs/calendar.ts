import type { Db, Row } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { pullEvents } from '../graph/delta.js';
import { drainOutbox } from '../graph/push.js';
import { refreshSources } from '../graph/sources.js';
import { NotConnectedError, ReauthRequiredError, type GraphTokens } from '../graph/token.js';

/**
 * 日历后台任务。
 *
 * 为什么不用真正的任务队列：单用户、单进程，一个 setInterval 就够，
 * 而且失败模式简单（进程重启后从数据库游标继续，不会丢东西）。
 *
 * 间隔取 30 秒：验收要求"Outlook 里改了，GRID 一分钟内可见"。
 * 服务端 30 秒一轮 + 客户端 30 秒一轮，最坏 60 秒；实际通常一次就够，
 * 因为用户改了之后一般会马上切回 GRID，那时客户端会立即触发一次同步。
 */

const PULL_INTERVAL_MS = 30_000;
const OUTBOX_INTERVAL_MS = 5_000;

/** 每个用户各一把"正在跑"的闸：定时器与手动"立即同步"不能同时打 Graph */
const running = new Map<string, Promise<CalendarSyncResult>>();

export interface CalendarSyncResult {
  pulled: { added: number; updated: number; removed: number; skipped: number; pages: number };
  pushed: { done: number; retried: number; dead: number; skipped: number };
  /** 需要用户重新授权时为 true，前端要显示红色通栏 */
  reauthRequired: boolean;
  error: string | null;
}

/**
 * 跑一轮：先拉增量，再回写队列。
 *
 * 顺序不能反：先回写意味着 PATCH 之后 delta 还没跑，
 * 界面上就出现"我刚拖的时间又跳回去了"（本地被 delta 的旧值覆盖）。
 */
export function runCalendarSync(db: Db, tokens: GraphTokens, userId: string): Promise<CalendarSyncResult> {
  const inflight = running.get(userId);
  if (inflight) return inflight;

  const task = (async (): Promise<CalendarSyncResult> => {
    const empty = { added: 0, updated: 0, removed: 0, skipped: 0, pages: 0 };
    const noPush = { done: 0, retried: 0, dead: 0, skipped: 0 };
    try {
      const pulled = await pullEvents({ db, tokens, userId });
      const pushed = await drainOutbox({ db, tokens, userId });
      await db.query('UPDATE oauth_account SET last_error = NULL WHERE user_id = ?', [userId]);
      return { pulled, pushed, reauthRequired: false, error: null };
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        return { pulled: empty, pushed: noPush, reauthRequired: true, error: err.reason };
      }
      if (err instanceof NotConnectedError) {
        return { pulled: empty, pushed: noPush, reauthRequired: false, error: null };
      }
      const message = err instanceof Error ? err.message : String(err);
      // 记到账户上，设置页与日历页的胶囊都能读到；不覆盖 needs_reauth 状态
      await db.query('UPDATE oauth_account SET last_error = ? WHERE user_id = ?', [message.slice(0, 500), userId]);
      return { pulled: empty, pushed: noPush, reauthRequired: false, error: message };
    } finally {
      running.delete(userId);
    }
  })();

  running.set(userId, task);
  return task;
}

export interface CalendarJobsDeps {
  db: Db;
  env: AppEnv;
  tokens: GraphTokens;
}

export function startCalendarJobs(deps: CalendarJobsDeps): () => void {
  if (!deps.env.oauth.enabled) {
    return () => undefined;
  }

  let stopped = false;

  const connected = async (): Promise<Row[]> =>
    deps.db.query<Row>(
      "SELECT user_id, id, status FROM oauth_account WHERE provider = 'microsoft' AND status <> 'revoked'",
    );

  const pullTick = async (): Promise<void> => {
    if (stopped) return;
    for (const account of await connected()) {
      if (stopped) return;
      // needs_reauth 的账户不再打 Graph：没意义，而且会让 last_error 每 30 秒刷一次同样的字
      if (account.status === 'needs_reauth' && !(await hasFreshAuth(deps.db, String(account.user_id)))) continue;
      await runCalendarSync(deps.db, deps.tokens, String(account.user_id));
    }
  };

  const outboxTick = async (): Promise<void> => {
    if (stopped) return;
    for (const account of await connected()) {
      if (stopped) return;
      const userId = String(account.user_id);
      try {
        await drainOutbox({ db: deps.db, tokens: deps.tokens, userId });
      } catch {
        // 回写的失败已经落在 op_outbox 里，这里不重复记日志
      }
    }
  };

  // 启动后 2 秒先跑一次：刚连上账号的用户不该等 30 秒才看到事件
  const boot = setTimeout(() => void pullTick(), 2_000);
  const pullTimer = setInterval(() => void pullTick(), PULL_INTERVAL_MS);
  const outboxTimer = setInterval(() => void outboxTick(), OUTBOX_INTERVAL_MS);
  // 别让定时器把进程钉住（脚本模式下要能自然退出）
  boot.unref?.();
  pullTimer.unref?.();
  outboxTimer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(boot);
    clearInterval(pullTimer);
    clearInterval(outboxTimer);
  };
}

/** 账户标了 needs_reauth，但用户刚重新授权过（token 还没过期）→ 允许再试一次 */
async function hasFreshAuth(db: Db, userId: string): Promise<boolean> {
  const rows = await db.query<Row>(
    'SELECT token_expires_at FROM oauth_account WHERE user_id = ? AND provider = ?',
    [userId, 'microsoft'],
  );
  return Number(rows[0]?.token_expires_at ?? 0) > Date.now();
}

/** 首次连接后立刻做一次：拉日历列表 + 全量事件 */
export async function initialSync(db: Db, tokens: GraphTokens, userId: string, accountId: string): Promise<void> {
  try {
    const accessToken = await tokens.accessTokenFor(userId);
    await refreshSources(db, userId, accountId, accessToken);
    await runCalendarSync(db, tokens, userId);
  } catch {
    // 首次同步失败不该让"连接成功"变成错误页：后台任务会继续重试
  }
}
