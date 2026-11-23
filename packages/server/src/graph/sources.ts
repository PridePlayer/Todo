import type { Db } from '../db/types.js';
import { listCalendars, type GraphCalendar } from './client.js';

/**
 * 日历源（calendar_source）的发现与校准。
 *
 * 每次同步前都调一次不太划算（多一个请求），所以只在三种时机跑：
 * 首次连接、用户点"刷新日历列表"、delta 拿到一个认不出的 parentFolderId。
 */

/** 节假日/生日这类只读日历默认不同步：它们会把日历塞满，而且不能编辑 */
const NOISY = /(节假日|假期|生日|holiday|birthday)/i;

export interface SourceRow {
  id: string;
  ms_calendar_id: string;
  name: string;
  is_default: number;
  is_visible: number;
  is_synced: number;
  can_edit: number;
  color_key: number;
  sort_order: number;
  /** 每个日历各自的 delta 游标；NULL 表示还没做过首次全量 */
  delta_link: string | null;
}

export async function loadSources(db: Db, userId: string): Promise<SourceRow[]> {
  return db.query<SourceRow>(
    'SELECT id, ms_calendar_id, name, is_default, is_visible, is_synced, can_edit, color_key, sort_order, delta_link ' +
      'FROM calendar_source WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC',
    [userId],
  );
}

/**
 * 把 Graph 的日历列表写进 calendar_source。
 *
 * 只更新"名字/可编辑性/顺序"这类服务端说了算的字段，**绝不覆盖**
 * is_visible / is_synced —— 那是用户在界面上做的选择，一次刷新就被重置会让人想把 App 删掉。
 */
export async function syncSources(
  db: Db,
  userId: string,
  accountId: string,
  calendars: readonly GraphCalendar[],
  now = Date.now(),
): Promise<SourceRow[]> {
  const existing = await loadSources(db, userId);
  const byMsId = new Map(existing.map((row) => [row.ms_calendar_id, row]));
  const seen = new Set<string>();

  for (let index = 0; index < calendars.length; index += 1) {
    const cal = calendars[index]!;
    seen.add(cal.id);
    const current = byMsId.get(cal.id);
    // 灰阶档位：0..5 循环，只用来区分不同日历的左缘色条，不用 Graph 的十六进制色
    const colorKey = index % 6;

    if (!current) {
      const noisy = NOISY.test(cal.name);
      const id = newRowId();
      await db.transaction(async (tx) => {
        const seq = await db.nextSeq(tx);
        await tx.query(
          'INSERT INTO calendar_source (id, user_id, account_id, ms_calendar_id, name, is_default, is_visible, ' +
            'is_synced, can_edit, color_key, sort_order, created_at, rev, change_seq, updated_at, deleted_at, ' +
            'hlc_wall, hlc_counter, hlc_device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, 0, NULL)',
          [
            id,
            userId,
            accountId,
            cal.id,
            cal.name.slice(0, 128),
            cal.isDefaultCalendar ? 1 : 0,
            noisy ? 0 : 1,
            noisy ? 0 : 1,
            cal.canEdit ? 1 : 0,
            colorKey,
            index,
            now,
            seq,
            now,
            now,
          ],
        );
      });
      continue;
    }

    // 名字改了 / 可编辑性变了才写：否则每 30 秒轮询都会把所有源的 rev 推高
    const changed =
      current.name !== cal.name.slice(0, 128) ||
      Number(current.can_edit) !== (cal.canEdit ? 1 : 0) ||
      Number(current.is_default) !== (cal.isDefaultCalendar ? 1 : 0) ||
      Number(current.color_key) !== colorKey ||
      Number(current.sort_order) !== index;
    if (!changed) continue;

    await db.transaction(async (tx) => {
      const seq = await db.nextSeq(tx);
      await tx.query(
        'UPDATE calendar_source SET name = ?, is_default = ?, can_edit = ?, color_key = ?, sort_order = ?, ' +
          'rev = rev + 1, change_seq = ?, updated_at = ? WHERE id = ?',
        [
          cal.name.slice(0, 128),
          cal.isDefaultCalendar ? 1 : 0,
          cal.canEdit ? 1 : 0,
          colorKey,
          index,
          seq,
          now,
          current.id,
        ],
      );
    });
  }

  // Graph 上已经删掉的日历：源和它的事件一起退休。
  // 只软删源是不够的——事件行还活着，但再也不会被任何一次 pull 碰到（源已经被过滤掉），
  // 于是那些会议永久挂在日历上，谁也删不掉。
  for (const row of existing) {
    if (seen.has(row.ms_calendar_id)) continue;
    await retireSource(db, userId, row.id, now);
  }

  return loadSources(db, userId);
}

/** 拉一次日历列表并落库 */
export async function refreshSources(
  db: Db,
  userId: string,
  accountId: string,
  accessToken: string,
): Promise<SourceRow[]> {
  const calendars = await listCalendars(accessToken);
  return syncSources(db, userId, accountId, calendars);
}

/**
 * 日历在 Outlook 侧被删掉了：本地源与它的事件一起退休。
 *
 * 不这么做的话，那个源的 delta 游标会永远返回 404，
 * 而 pull 是按源循环的——一个坏游标就能把**所有**日历的同步拖停，
 * 症状是"某天之后一条都同步不下来了"，而且日志里只有一行 404。
 */
export async function retireSource(db: Db, userId: string, sourceId: string, now = Date.now()): Promise<number> {
  const events = await db.query<{ id: string }>(
    'SELECT id FROM cal_event WHERE user_id = ? AND source_id = ? AND deleted_at IS NULL',
    [userId, sourceId],
  );
  await db.transaction(async (tx) => {
    const seq = await db.nextSeq(tx);
    for (const event of events) {
      await tx.query('UPDATE cal_event SET deleted_at = ?, rev = rev + 1, change_seq = ?, updated_at = ? WHERE id = ?', [
        now,
        seq,
        now,
        event.id,
      ]);
    }
    await tx.query(
      'UPDATE calendar_source SET deleted_at = ?, delta_link = NULL, rev = rev + 1, change_seq = ?, updated_at = ? WHERE id = ?',
      [now, seq, now, sourceId],
    );
  });
  return events.length;
}

/** 新行 id：26 位、只含大写字母与数字，和 ULID 同形但不需要严格单调 */
export function newRowId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const time = Date.now().toString(32).toUpperCase().padStart(9, '0');
  let tail = '';
  for (let i = 0; i < 17; i += 1) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${time}${tail}`.slice(0, 26);
}

/** 在源列表里挑一个"兜底源"：优先默认日历，其次第一个可编辑的 */
export function fallbackSourceId(sources: readonly SourceRow[]): string | null {
  const def = sources.find((row) => Number(row.is_default) === 1);
  if (def) return def.id;
  const editable = sources.find((row) => Number(row.can_edit) === 1);
  return editable?.id ?? sources[0]?.id ?? null;
}

export function sourceByMsId(sources: readonly SourceRow[], msCalendarId: string | null): SourceRow | undefined {
  if (!msCalendarId) return undefined;
  return sources.find((row) => row.ms_calendar_id === msCalendarId);
}
