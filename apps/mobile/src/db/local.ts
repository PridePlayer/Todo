import type { SyncChange, SyncOp } from '@grid/core';
import * as SQLite from 'expo-sqlite';

/**
 * 本地库。
 *
 * 不是把 Web 的 Dexie repo 照抄一遍 —— 这里存的是"服务端行的镜像 + 待推队列"，
 * 而不是带业务语义的仓储。原因：移动端第一版不做字段级合并，
 * 冲突一律以服务端结果为准；既然不做合并，就不需要把 repo 的 600 行搬过来。
 *
 * 三张表：
 *   doc    —— 每行一个 JSON，主键 (表名, id)，含墓碑
 *   meta   —— 游标等标量
 *   outbox —— 尚未推送成功的操作（离线时全靠它）
 */

export const TABLES = [
  'task',
  'tag',
  'list',
  'recur_exception',
  'calendar_source',
  'cal_event',
  'habit',
  'habit_log',
] as const;

export type RowTable = (typeof TABLES)[number];

export interface DocRow {
  tbl: RowTable;
  id: string;
  rev: number;
  deletedAt: number | null;
  payload: Record<string, unknown>;
}

export interface QueuedOp {
  opId: string;
  body: SyncOp;
  createdAt: number;
}

let db: SQLite.SQLiteDatabase | null = null;

export async function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync('grid.db');
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS doc (
      tbl     TEXT    NOT NULL,
      id      TEXT    NOT NULL,
      rev     INTEGER NOT NULL,
      deleted INTEGER NOT NULL,
      payload TEXT    NOT NULL,
      PRIMARY KEY (tbl, id)
    );
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      op_id      TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

interface DocSqlRow {
  tbl: string;
  id: string;
  rev: number;
  deleted: number;
  payload: string;
}

export async function loadAll(): Promise<DocRow[]> {
  const conn = await openDb();
  const rows = await conn.getAllAsync<DocSqlRow>('SELECT tbl, id, rev, deleted, payload FROM doc');
  const out: DocRow[] = [];
  for (const row of rows) {
    if (!isTable(row.tbl)) continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      // 单行坏了不该让整个首屏空白：丢掉这一行，下次 pull 会重新写回
      continue;
    }
    out.push({
      tbl: row.tbl,
      id: row.id,
      rev: row.rev,
      // 墓碑的真实删除时间在 payload 里；0 只作为"有墓碑但不知道时间"的兜底，
      // 千万别用 0 当"未删除"——判断一律写 `deletedAt === null`
      deletedAt: row.deleted ? Number(payload.deletedAt ?? 0) : null,
      payload,
    });
  }
  return out;
}

export async function applyChanges(changes: readonly SyncChange[]): Promise<void> {
  if (changes.length === 0) return;
  const conn = await openDb();
  await conn.withTransactionAsync(async () => {
    for (const change of changes) {
      if (!isTable(change.table)) continue;
      // 墓碑也写：不写的话，增量拉取里"删除"这条信息就丢了，
      // 界面上会一直留着一条已经不存在的事件（Web 端踩过这个坑）
      await conn.runAsync(
        'INSERT OR REPLACE INTO doc (tbl, id, rev, deleted, payload) VALUES (?, ?, ?, ?, ?)',
        [
          change.table,
          change.id,
          change.rev,
          change.deletedAt === null ? 0 : 1,
          JSON.stringify(change.payload ?? {}),
        ],
      );
    }
  });
}

/** 本地先落一行（乐观写入，不等服务端） */
export async function putRow(tbl: RowTable, id: string, rev: number, payload: Record<string, unknown>): Promise<void> {
  const conn = await openDb();
  await conn.runAsync(
    'INSERT OR REPLACE INTO doc (tbl, id, rev, deleted, payload) VALUES (?, ?, ?, 0, ?)',
    [tbl, id, rev, JSON.stringify(payload)],
  );
}

export async function bumpRev(tbl: RowTable, id: string, rev: number): Promise<void> {
  const conn = await openDb();
  await conn.runAsync('UPDATE doc SET rev = ? WHERE tbl = ? AND id = ?', [rev, tbl, id]);
}

/**
 * 用服务端合并后的行覆盖本地（push 响应里的 `serverPayload`）。
 *
 * 为什么必须有这一步：服务端对打卡值是 `GREATEST(local, remote)`，
 * 对标签是并集，对四象限是整块裁决 —— 也就是说**推上去的值经常不是你写的那个**。
 * 只更新 rev 不更新字段，本地就会永远停在旧值上：
 *
 *   手机 value=1 推上去 → 服务端已有 2 → merge 保留 2 → 该行 change_seq 不变
 *   → 之后 pull 用 `change_seq > cursor` 拉不到这行 → 手机永远显示 1/2
 *
 * 而这个"永远"是真的永远 —— 不是等一会儿会自己好。
 *
 * `AND deleted = 0`：同一批 op 里先删后改时，不能把墓碑又写活。
 */
export async function applyServerPayload(
  tbl: RowTable,
  id: string,
  rev: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const conn = await openDb();
  await conn.runAsync('UPDATE doc SET rev = ?, payload = ? WHERE tbl = ? AND id = ? AND deleted = 0', [
    rev,
    JSON.stringify(payload),
    tbl,
    id,
  ]);
}

/**
 * 本地软删：把 deleted 置 1，payload 留空。
 *
 * 不直接 DELETE 行：删完如果 push 失败，本地就再也找不到这条了，
 * 队列里那条 delete 变成"指向一个不存在的行"，重试时无从判断该不该保留。
 * 留墓碑才能让"离线删除 → 联网补推"这条路走得通。
 */
export async function softDeleteRow(tbl: RowTable, id: string, deletedAt: number): Promise<void> {
  const conn = await openDb();
  await conn.runAsync('UPDATE doc SET deleted = 1, payload = ? WHERE tbl = ? AND id = ?', [
    JSON.stringify({ deletedAt }),
    tbl,
    id,
  ]);
}

export async function getMeta(key: string): Promise<string | null> {
  const conn = await openDb();
  const row = await conn.getFirstAsync<{ v: string }>('SELECT v FROM meta WHERE k = ?', [key]);
  return row?.v ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const conn = await openDb();
  await conn.runAsync('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', [key, value]);
}

export async function queueOp(op: SyncOp): Promise<void> {
  const conn = await openDb();
  await conn.runAsync('INSERT OR REPLACE INTO outbox (op_id, body, created_at) VALUES (?, ?, ?)', [
    op.opId,
    JSON.stringify(op),
    Date.now(),
  ]);
}

export async function loadOps(): Promise<QueuedOp[]> {
  const conn = await openDb();
  const rows = await conn.getAllAsync<{ op_id: string; body: string; created_at: number }>(
    'SELECT op_id, body, created_at FROM outbox ORDER BY created_at ASC',
  );
  const out: QueuedOp[] = [];
  for (const row of rows) {
    try {
      out.push({ opId: row.op_id, body: JSON.parse(row.body) as SyncOp, createdAt: row.created_at });
    } catch {
      await conn.runAsync('DELETE FROM outbox WHERE op_id = ?', [row.op_id]);
    }
  }
  return out;
}

export async function dropOps(opIds: readonly string[]): Promise<void> {
  if (opIds.length === 0) return;
  const conn = await openDb();
  const holes = opIds.map(() => '?').join(',');
  await conn.runAsync(`DELETE FROM outbox WHERE op_id IN (${holes})`, [...opIds]);
}

/** 退出登录用：清空一切，避免下一个人看到上一个人的数据 */
export async function wipe(): Promise<void> {
  const conn = await openDb();
  await conn.execAsync('DELETE FROM doc; DELETE FROM meta; DELETE FROM outbox;');
}

function isTable(value: string): value is RowTable {
  return (TABLES as readonly string[]).includes(value);
}
