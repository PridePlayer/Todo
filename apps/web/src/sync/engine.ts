import {
  ApiError,
  type Quadrant,
  type RecurException,
  type SyncChange,
  type SyncConflict,
  type SyncOp,
  type SyncOpResult,
  type SyncTable,
  type Task,
} from '@grid/core';
import { api } from '../api';
import { db, type ConflictRow, type OutboxOp } from '../db/dexie';
import { enqueueFieldUpdate } from '../db/repo';
import { broadcast, onBroadcast } from './broadcast';
import { onLocalChange } from './bus';
import { getDeviceId, getMeta, setMeta } from './hlc';
import { withSyncLock } from './webLocks';

/**
 * 客户端同步引擎。
 *
 * 一个周期固定四步，顺序不能换（docs/03 §7.3）：
 *   1. push  —— 先把本地意图推上去，让"我改的"优先落库
 *   2. pull  —— 再拉别人的改动，覆盖的是"我没动过"的字段
 *   3. apply —— 写入 IndexedDB，跳过本地仍有未推送操作的行
 *   4. hasMore 就继续 pull，直到追平
 *
 * 先拉后推会怎样：本地刚把标题从 A 改成 B，pull 先拿到服务端的旧值 A 直接覆盖，
 * 界面闪一下回退，然后 push 又把 B 推上去，再拉一次才变回 B——用户看到的是"改完自己弹回去"。
 *
 * 引擎不碰 UI，也不自己 setTimeout 轮询单个请求；它对外只暴露"同步一次"和"订阅状态"。
 * 何时同步是 startAutoSync 的事：入队后防抖、网络恢复、页面回前台、30 秒心跳。
 */

const KEY_CURSOR = 'syncCursor';
const KEY_LAST = 'lastSyncAt';

/** 一批最多 50 条：服务端逐条一个事务，太大只会拉长单次请求的失败面 */
const PUSH_BATCH = 50;
const PULL_LIMIT = 200;
/** 一轮同步最多翻 40 页（8000 行）；再多说明该全量重建了，别把标签页卡死 */
const PULL_MAX_ROUNDS = 40;
/** 输入时每敲一下都同步会打成 ddos，防抖到"停下来之后再推" */
const DEBOUNCE_MS = 600;
const IDLE_INTERVAL_MS = 30_000;
/** 冲突抽屉只留最近 50 条，老冲突自动淘汰——它们是提示，不是账本 */
const MAX_CONFLICTS = 50;

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  /** 待推送的操作条数 */
  pending: number;
  /** 被服务端拒绝、需要人工处理的操作 */
  failed: number;
  /** 冲突待决条数 */
  conflicts: number;
  lastSyncAt: number | null;
  /** 给人看的一句话，phase=idle 时为 null */
  message: string | null;
}

let status: SyncStatus = {
  phase: 'idle',
  pending: 0,
  failed: 0,
  conflicts: 0,
  lastSyncAt: null,
  message: null,
};

const listeners = new Set<() => void>();

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function patch(partial: Partial<SyncStatus>): void {
  let changed = false;
  for (const key of Object.keys(partial) as (keyof SyncStatus)[]) {
    if (status[key] !== partial[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  status = { ...status, ...partial };
  for (const listener of listeners) listener();
}

// ── 计数 ────────────────────────────────────────────────────

/**
 * 单独查一次计数而不是订阅 outbox 的 liveQuery：
 * liveQuery 每次写入都会重查，同步过程中会连着触发几十次，顶栏数字会跳舞。
 * 这里由引擎在"合适的时候"刷新（入队、周期结束），数字只在有意义时变。
 */
export async function refreshCounts(): Promise<void> {
  const [pending, failed, conflicts] = await Promise.all([
    db.outbox.where('status').equals('pending').count(),
    db.outbox.where('status').equals('failed').count(),
    db.conflicts.count(),
  ]);
  const raw = await getMeta(KEY_LAST);
  patch({ pending, failed, conflicts, lastSyncAt: raw ? Number(raw) : null });
}

// ── 同步主流程 ──────────────────────────────────────────────

let running: Promise<void> | null = null;
let rerun = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 同步一次。已经在跑时不再并发开第二个，而是标记"跑完再来一轮"——
 * 因为这一轮可能已经拉过一次 pull，期间新入队的操作必须有机会被推上去。
 */
export function syncNow(): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  running = withSyncLock(runCycle)
    .catch((error: unknown) => {
      // 锁本身出错（极少）也要落到状态里，绝不能变成未捕获的 rejection
      const info = describeError(error);
      patch({ phase: info.phase, message: info.message });
    })
    .finally(() => {
      running = null;
      if (rerun) {
        rerun = false;
        scheduleSync(0);
      }
    });
  return running;
}

export function scheduleSync(delayMs: number = DEBOUNCE_MS): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncNow();
  }, delayMs);
}

async function runCycle(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    await refreshCounts();
    patch({ phase: 'offline', message: '离线，改动暂存在本机' });
    return;
  }

  patch({ phase: 'syncing', message: null });
  try {
    await pushPending();
    await pullFrom(await readCursor());
    await setMeta(KEY_LAST, String(Date.now()));
    patch({ phase: 'idle', message: null });
    broadcast({ type: 'synced', at: Date.now() });
  } catch (error) {
    const info = describeError(error);
    patch({ phase: info.phase, message: info.message });
  } finally {
    await refreshCounts();
  }
}

function describeError(error: unknown): { phase: SyncPhase; message: string } {
  if (error instanceof ApiError) {
    if (error.status === 0) return { phase: 'offline', message: '网络不可用，改动暂存在本机' };
    if (error.status === 401) return { phase: 'error', message: '登录已过期，请重新登录' };
    return { phase: 'error', message: error.message };
  }
  return { phase: 'error', message: error instanceof Error ? error.message : '同步失败' };
}

// ── 推送 ────────────────────────────────────────────────────

async function pushPending(): Promise<void> {
  const deviceId = await getDeviceId();
  for (;;) {
    const batch = await db.outbox.where('status').equals('pending').sortBy('createdAt');
    const slice = batch.slice(0, PUSH_BATCH);
    if (slice.length === 0) return;

    const res = await api.syncPush({ deviceId, ops: slice.map(toWireOp) });
    const handled = await handleResults(slice, res.results);
    // 服务端一条都没认领（响应缺 opId）时不要死循环，留给下一轮
    if (handled === 0) return;
  }
}

function toWireOp(op: OutboxOp): SyncOp {
  return {
    opId: op.opId,
    table: op.table,
    action: op.action,
    id: op.id,
    baseRev: op.baseRev,
    fields: JSON.parse(op.fields) as Record<string, unknown>,
    base: op.base ? (JSON.parse(op.base) as Record<string, unknown>) : undefined,
    hlc: { wall: op.hlcWall, counter: op.hlcCounter, device: op.device },
  };
}

async function handleResults(ops: readonly OutboxOp[], results: readonly SyncOpResult[]): Promise<number> {
  const byId = new Map(results.map((result) => [result.opId, result]));
  let handled = 0;

  for (const op of ops) {
    const result = byId.get(op.opId);
    if (!result) continue;
    handled += 1;
    await db.outbox.delete(op.opId);

    if (result.status === 'rejected') {
      // 保留但改状态：缺标题、表名非法这类错误重试一万次也一样，
      // 留在 pending 会让引擎每一轮都重新推一条注定失败的 op
      await db.outbox.put({ ...op, status: 'failed', error: result.reason ?? 'rejected' });
      continue;
    }

    if (result.conflicts && result.conflicts.length > 0) {
      await saveConflicts(op.id, result.conflicts);
    }

    // 推送期间用户可能又改了这条任务：此时本地才是最新的，别让服务端回包覆盖掉
    if (await hasPending(op.id)) continue;

    if (result.serverPayload) {
      await applyPayload(op.table, op.id, result.rev ?? op.baseRev, result.serverPayload, null);
    } else if (result.rev !== undefined) {
      await bumpRev(op.table, op.id, result.rev);
    }
  }

  return handled;
}

async function saveConflicts(rowId: string, conflicts: readonly SyncConflict[]): Promise<void> {
  const now = Date.now();
  for (const conflict of conflicts) {
    const row: ConflictRow = {
      id: `${rowId}:${conflict.field}:${now}`,
      taskId: rowId,
      field: conflict.field,
      local: JSON.stringify(conflict.local ?? null),
      remote: JSON.stringify(conflict.remote ?? null),
      createdAt: now,
    };
    await db.conflicts.put(row);
  }
  const all = await db.conflicts.orderBy('createdAt').toArray();
  const overflow = all.length - MAX_CONFLICTS;
  if (overflow > 0) await db.conflicts.bulkDelete(all.slice(0, overflow).map((row) => row.id));
}

// ── 拉取 ────────────────────────────────────────────────────

async function readCursor(): Promise<number> {
  const raw = await getMeta(KEY_CURSOR);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

async function pullFrom(startCursor: number): Promise<void> {
  let cursor = startCursor;

  for (let round = 0; round < PULL_MAX_ROUNDS; round += 1) {
    const res = await api.syncPull({ cursor, limit: PULL_LIMIT });

    if (res.resyncRequired) {
      // 游标比最早可用的墓碑还老：增量已经接不上了，只能清空重来
      await clearLocalData();
      await setMeta(KEY_CURSOR, '0');
      cursor = 0;
      continue;
    }

    for (const change of res.changes) await applyChange(change);

    cursor = res.nextCursor;
    // 每页都落游标：中途断网时下次从这里接着拉，不会重放已应用的整页
    await setMeta(KEY_CURSOR, String(cursor));

    if (!res.hasMore) return;
  }
}

async function applyChange(change: SyncChange): Promise<void> {
  // 本地还有没推上去的操作 → 说明本地意图比这条远端记录更新（或至少同样新），
  // 覆盖掉会让用户看到自己刚改的字被改回去；等下一轮 push 之后自然收敛
  if (await hasPending(change.id)) return;
  await applyPayload(change.table, change.id, change.rev, change.payload, change.deletedAt);
}

async function hasPending(id: string): Promise<boolean> {
  const rows = await db.outbox.where('id').equals(id).toArray();
  return rows.some((row) => row.status === 'pending');
}

async function bumpRev(table: SyncTable, id: string, rev: number): Promise<void> {
  if (table === 'task') {
    const row = await db.tasks.get(id);
    if (row) await db.tasks.put({ ...row, rev });
    return;
  }
  // tag / list 的模型里没有 rev，本地也不需要——只有 task 会带着 baseRev 做字段级合并
}

async function applyPayload(
  table: SyncTable,
  id: string,
  rev: number,
  payload: Record<string, unknown> | null,
  deletedAt: number | null,
): Promise<void> {
  if (table === 'task') {
    if (deletedAt !== null) {
      const row = await db.tasks.get(id);
      // 本地没有这行就直接不管：墓碑的唯一作用是让别的端知道"它没了"，
      // 本机从来没见过的任务不需要留墓碑
      if (row) await db.tasks.put({ ...row, deletedAt, rev });
      return;
    }
    if (!payload) return;
    await db.tasks.put(toTask(id, rev, payload));
    return;
  }

  if (table === 'tag') {
    if (deletedAt !== null) {
      await db.tags.delete(id);
      return;
    }
    if (!payload) return;
    await db.tags.put({
      id,
      name: String(payload.name ?? '').slice(0, 24) || '未命名',
      colorKey: clampColor(Number(payload.colorKey ?? 0)),
    });
    return;
  }

  if (table === 'recur_exception') {
    // 例外不物理删除：服务端的唯一键是 (series_id, original_start)，
    // 留着墓碑，同一次被"复活"时才能复用同一行而不是撞唯一索引
    const row = await db.exceptions.get(id);
    if (deletedAt !== null) {
      if (row) await db.exceptions.put({ ...row, deletedAt, rev });
      return;
    }
    if (!payload) return;
    await db.exceptions.put(toException(id, rev, payload, deletedAt));
    return;
  }

  if (deletedAt !== null) {
    await db.lists.delete(id);
    return;
  }
  if (!payload) return;
  await db.lists.put({
    id,
    name: String(payload.name ?? '').slice(0, 48) || '未命名清单',
    sortOrder: Number(payload.sortOrder ?? 0),
  });
}

function clampColor(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, Math.trunc(value)));
}

/**
 * 线上 payload → 本地 Task。
 *
 * 必须逐字段兜底：服务端可能来自一个更晚的版本（多了/少了字段），
 * 用 `{ ...payload }` 直接铺开会让 `quadrant` 变成字符串、`important` 变成 1/0，
 * 而这种脏数据不会立刻报错，只会在排序和高亮上表现成"偶尔有任务颜色不对"。
 */
function toTask(id: string, rev: number, payload: Record<string, unknown>): Task {
  const now = Date.now();
  const startAt = numOrNull(payload.startAt);
  const quadrant = clampQuadrant(payload.quadrant);
  return {
    id,
    listId: str(payload.listId) ?? 'list-inbox',
    parentId: str(payload.parentId),
    path: str(payload.path) ?? `${id}/`,
    depth: Math.max(0, Math.trunc(Number(payload.depth ?? 0)) || 0),
    title: (str(payload.title) ?? '').slice(0, 512) || '（无标题）',
    note: str(payload.note),
    quadrant,
    important: Boolean(payload.important),
    urgent: Boolean(payload.urgent),
    priority: Math.min(3, Math.max(0, Math.trunc(Number(payload.priority ?? 0)) || 0)),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(payload.dueDate ?? '')) ? String(payload.dueDate) : null,
    startAt,
    endAt: numOrNull(payload.endAt),
    allDay: Boolean(payload.allDay ?? startAt === null),
    location: str(payload.location),
    tagIds: Array.isArray(payload.tagIds) ? payload.tagIds.map(String).slice(0, 20) : [],
    completedAt: numOrNull(payload.completedAt),
    archivedAt: numOrNull(payload.archivedAt),
    sortOrder: Number(payload.sortOrder ?? 0) || 0,
    rrule: str(payload.rrule),
    remindAt: numOrNull(payload.remindAt),
    createdAt: numOrNull(payload.createdAt) ?? now,
    updatedAt: numOrNull(payload.updatedAt) ?? now,
    deletedAt: numOrNull(payload.deletedAt),
    rev: rev > 0 ? rev : 1,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampQuadrant(value: unknown): Quadrant {
  const n = Math.trunc(Number(value ?? 1));
  return n === 2 || n === 3 || n === 4 ? n : 1;
}

/** 线上 payload → 例外行。kind 只认两个值，脏数据按 override 处理（宁可多显示一次也不静默丢） */
function toException(id: string, rev: number, payload: Record<string, unknown>, deletedAt: number | null): RecurException {
  const now = Date.now();
  return {
    id,
    seriesId: str(payload.seriesId) ?? '',
    originalStart: numOrNull(payload.originalStart) ?? 0,
    kind: payload.kind === 'deleted' ? 'deleted' : 'override',
    overrideStart: numOrNull(payload.overrideStart),
    overrideEnd: numOrNull(payload.overrideEnd),
    overrideTitle: str(payload.overrideTitle),
    payload: typeof payload.payload === 'object' && payload.payload !== null
      ? (payload.payload as Record<string, unknown>)
      : null,
    createdAt: numOrNull(payload.createdAt) ?? now,
    updatedAt: numOrNull(payload.updatedAt) ?? now,
    deletedAt,
    rev: rev > 0 ? rev : 1,
  };
}

// ── 人工操作 ────────────────────────────────────────────────

async function clearLocalData(): Promise<void> {
  await db.transaction('rw', db.tasks, db.tags, db.lists, db.exceptions, async () => {
    await db.tasks.clear();
    await db.tags.clear();
    await db.lists.clear();
    await db.exceptions.clear();
  });
}

/**
 * 全量重建：把服务端当作唯一真源，本地推平重拉。
 *
 * 前置条件是"队列已经推干净"：不清空就直接重建，等于把还没上传的本地改动删掉，
 * 而用户点这个按钮的动机通常只是"感觉两边不一样"，不该赔上未同步的数据。
 */
export async function rebuildFromServer(): Promise<void> {
  await withSyncLock(async () => {
    patch({ phase: 'syncing', message: null });
    try {
      await pushPending();
      const left = await db.outbox.where('status').equals('pending').count();
      if (left > 0) throw new Error(`还有 ${left} 条改动没推上去，先连上服务端再重建`);

      await clearLocalData();
      await setMeta(KEY_CURSOR, '0');
      await pullFrom(0);
      await setMeta(KEY_LAST, String(Date.now()));
      patch({ phase: 'idle', message: null });
      broadcast({ type: 'synced', at: Date.now() });
    } finally {
      await refreshCounts();
    }
  });
}

/**
 * 冲突裁决：把某个字段改成冲突里的另一侧值并重新入队。
 *
 * base 取"当前本地值"而不是更早的版本——服务端看到的现状就是它，
 * 所以合并时会判定"远端没动过这个字段"，无条件接受我方写入。
 */
export async function resolveConflict(conflictId: string, keep: 'local' | 'remote'): Promise<void> {
  const row = await db.conflicts.get(conflictId);
  if (!row) return;

  const value = JSON.parse(keep === 'local' ? row.local : row.remote) as unknown;
  const task = await db.tasks.get(row.taskId);

  if (task && row.field in task) {
    const base = (task as unknown as Record<string, unknown>)[row.field];
    await db.tasks.put({
      ...(task as unknown as Record<string, unknown>),
      [row.field]: value,
      updatedAt: Date.now(),
    } as Task);
    await enqueueFieldUpdate(row.taskId, { [row.field]: value }, { [row.field]: base }, task.rev);
  }

  await db.conflicts.delete(conflictId);
  await refreshCounts();
  scheduleSync(0);
}

/** 丢弃全部冲突提示：用户选择"就这样，别告诉我了" */
export async function dismissConflicts(): Promise<void> {
  await db.conflicts.clear();
  await refreshCounts();
}

/** 设置页要列出来的冲突明细，新的在上 */
export async function listConflicts(): Promise<ConflictRow[]> {
  const rows = await db.conflicts.orderBy('createdAt').reverse().toArray();
  return rows;
}

/** 设置页要列出来的被拒操作 */
export async function listFailedOps(): Promise<OutboxOp[]> {
  return db.outbox.where('status').equals('failed').sortBy('createdAt');
}

/** 本地游标 = 已经应用到的服务端 change_seq */
export async function readLocalCursor(): Promise<number> {
  return readCursor();
}

/** 被服务端拒绝的操作重试一次（例如操作人在另一台设备上补了标题） */
export async function retryFailedOps(): Promise<void> {
  const rows = await db.outbox.where('status').equals('failed').toArray();
  for (const row of rows) await db.outbox.put({ ...row, status: 'pending', error: null });
  await refreshCounts();
  scheduleSync(0);
}

/** 彻底丢弃被拒绝的操作，本地改动保留但不再尝试上传 */
export async function discardFailedOps(): Promise<void> {
  const rows = await db.outbox.where('status').equals('failed').toArray();
  await db.outbox.bulkDelete(rows.map((row) => row.opId));
  await refreshCounts();
}

// ── 自动同步的调度 ──────────────────────────────────────────

let started = false;
let idleTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 打开自动同步。返回清理函数，由 AppShell 卸载时调用。
 *
 * 四个触发点，各管一件事，不要合并：
 *   入队后防抖 —— 用户正在打字
 *   online      —— 断网恢复，最需要立刻推
 *   visibility  —— 手机上切回来，此时心跳可能早被系统冻结了
 *   30s 心跳    —— 另一端改了什么，本端不用等到自己动手才知道
 */
export function startAutoSync(): () => void {
  if (started) return () => undefined;
  started = true;

  void refreshCounts();
  void syncNow();

  const offLocal = onLocalChange(() => {
    void refreshCounts();
    broadcast({ type: 'local-change' });
    scheduleSync();
  });

  const offCast = onBroadcast((message) => {
    if (message.type === 'local-change') {
      // 另一页刚写了本地库，本页也推一次：谁先抢到锁谁推，服务端幂等
      scheduleSync();
      return;
    }
    void refreshCounts();
  });

  const handleOnline = (): void => {
    void syncNow();
  };
  const handleOffline = (): void => {
    void refreshCounts();
    patch({ phase: 'offline', message: '离线，改动暂存在本机' });
  };
  const handleVisible = (): void => {
    if (document.visibilityState === 'visible') scheduleSync(200);
  };

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  document.addEventListener('visibilitychange', handleVisible);

  idleTimer = setInterval(() => {
    // 后台标签页不做心跳：手机浏览器会把它冻结，醒过来的第一次请求通常是失败
    if (document.visibilityState === 'visible' && navigator.onLine) void syncNow();
  }, IDLE_INTERVAL_MS);

  return () => {
    started = false;
    offLocal();
    offCast();
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
    document.removeEventListener('visibilitychange', handleVisible);
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
  };
}
