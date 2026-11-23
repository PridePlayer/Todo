import type { Row } from '../db/types.js';

/**
 * 服务端行（snake_case）↔ 线上 payload（camelCase，与客户端 Task 模型一致）的**唯一**映射点。
 * 别处不许再写第二份：字段漏一个的症状是"这个字段永远不同步"，而它看起来像 UI bug。
 */
type Kind = 'raw' | 'bool' | 'json';

interface FieldSpec {
  col: string;
  kind: Kind;
}

const TASK_FIELDS: Record<string, FieldSpec> = {
  id: { col: 'id', kind: 'raw' },
  listId: { col: 'list_id', kind: 'raw' },
  parentId: { col: 'parent_id', kind: 'raw' },
  path: { col: 'path', kind: 'raw' },
  depth: { col: 'depth', kind: 'raw' },
  title: { col: 'title', kind: 'raw' },
  note: { col: 'note', kind: 'raw' },
  quadrant: { col: 'quadrant', kind: 'raw' },
  important: { col: 'important', kind: 'bool' },
  urgent: { col: 'urgent', kind: 'bool' },
  priority: { col: 'priority', kind: 'raw' },
  dueDate: { col: 'due_date', kind: 'raw' },
  startAt: { col: 'start_at', kind: 'raw' },
  endAt: { col: 'end_at', kind: 'raw' },
  allDay: { col: 'all_day', kind: 'bool' },
  location: { col: 'location', kind: 'raw' },
  tagIds: { col: 'tag_ids', kind: 'json' },
  completedAt: { col: 'completed_at', kind: 'raw' },
  archivedAt: { col: 'archived_at', kind: 'raw' },
  sortOrder: { col: 'sort_order', kind: 'raw' },
  rrule: { col: 'rrule', kind: 'raw' },
  remindAt: { col: 'remind_at', kind: 'raw' },
  createdAt: { col: 'created_at', kind: 'raw' },
  updatedAt: { col: 'updated_at', kind: 'raw' },
  deletedAt: { col: 'deleted_at', kind: 'raw' },
  rev: { col: 'rev', kind: 'raw' },
};

const TAG_FIELDS: Record<string, FieldSpec> = {
  id: { col: 'id', kind: 'raw' },
  name: { col: 'name', kind: 'raw' },
  colorKey: { col: 'color_key', kind: 'raw' },
  createdAt: { col: 'created_at', kind: 'raw' },
  updatedAt: { col: 'updated_at', kind: 'raw' },
  deletedAt: { col: 'deleted_at', kind: 'raw' },
};

const LIST_FIELDS: Record<string, FieldSpec> = {
  id: { col: 'id', kind: 'raw' },
  name: { col: 'name', kind: 'raw' },
  sortOrder: { col: 'sort_order', kind: 'raw' },
  createdAt: { col: 'created_at', kind: 'raw' },
  updatedAt: { col: 'updated_at', kind: 'raw' },
  deletedAt: { col: 'deleted_at', kind: 'raw' },
};

const EXCEPTION_FIELDS: Record<string, FieldSpec> = {
  id: { col: 'id', kind: 'raw' },
  seriesId: { col: 'series_id', kind: 'raw' },
  originalStart: { col: 'original_start', kind: 'raw' },
  kind: { col: 'kind', kind: 'raw' },
  overrideStart: { col: 'override_start', kind: 'raw' },
  overrideEnd: { col: 'override_end', kind: 'raw' },
  overrideTitle: { col: 'override_title', kind: 'raw' },
  payload: { col: 'override_payload', kind: 'json' },
  createdAt: { col: 'created_at', kind: 'raw' },
  updatedAt: { col: 'updated_at', kind: 'raw' },
  deletedAt: { col: 'deleted_at', kind: 'raw' },
  rev: { col: 'rev', kind: 'raw' },
};

const SOURCE_FIELDS: Record<string, FieldSpec> = {
  id: { col: 'id', kind: 'raw' },
  name: { col: 'name', kind: 'raw' },
  isVisible: { col: 'is_visible', kind: 'bool' },
  isSynced: { col: 'is_synced', kind: 'bool' },
  canEdit: { col: 'can_edit', kind: 'bool' },
  isDefault: { col: 'is_default', kind: 'bool' },
  colorKey: { col: 'color_key', kind: 'raw' },
  sortOrder: { col: 'sort_order', kind: 'raw' },
  updatedAt: { col: 'updated_at', kind: 'raw' },
  deletedAt: { col: 'deleted_at', kind: 'raw' },
  rev: { col: 'rev', kind: 'raw' },
};

/**
 * Outlook 事件镜像。
 *
 * 注意这里**没有** msEtag / sourceId 的写入通道之外的字段：
 *   - msEtag 只在服务端与 Graph 之间流转，客户端拿到也没用，写进来只会破坏 If-Match
 *   - msEventId 由服务端从 Graph 写入，客户端改它等于把事件指向另一个会议
 */
const CAL_EVENT_FIELDS: Record<string, FieldSpec> = {
  id: { col: 'id', kind: 'raw' },
  sourceId: { col: 'source_id', kind: 'raw' },
  subject: { col: 'subject', kind: 'raw' },
  bodyPreview: { col: 'body_preview', kind: 'raw' },
  location: { col: 'location', kind: 'raw' },
  startAt: { col: 'start_at', kind: 'raw' },
  endAt: { col: 'end_at', kind: 'raw' },
  allDay: { col: 'is_all_day', kind: 'bool' },
  tzid: { col: 'tzid', kind: 'raw' },
  isOrganizer: { col: 'is_organizer', kind: 'bool' },
  responseStatus: { col: 'response_status', kind: 'raw' },
  isRecurring: { col: 'is_recurring', kind: 'bool' },
  rrule: { col: 'rrule', kind: 'raw' },
  webLink: { col: 'web_link', kind: 'raw' },
  syncState: { col: 'sync_state', kind: 'raw' },
  createdAt: { col: 'created_at', kind: 'raw' },
  updatedAt: { col: 'updated_at', kind: 'raw' },
  deletedAt: { col: 'deleted_at', kind: 'raw' },
  rev: { col: 'rev', kind: 'raw' },
};

export const FIELD_MAPS = {
  task: TASK_FIELDS,
  tag: TAG_FIELDS,
  list: LIST_FIELDS,
  recur_exception: EXCEPTION_FIELDS,
  calendar_source: SOURCE_FIELDS,
  cal_event: CAL_EVENT_FIELDS,
} as const;

export type SyncTableName = keyof typeof FIELD_MAPS;

function encode(kind: Kind, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (kind === 'bool') return value ? 1 : 0;
  if (kind === 'json') return value === null ? null : JSON.stringify(value);
  return value;
}

function decode(kind: Kind, value: unknown): unknown {
  if (kind === 'bool') return Number(value) === 1;
  if (kind === 'json') {
    if (value === null || value === undefined || value === '') return null;
    try {
      const parsed = JSON.parse(String(value));
      // 数组（tag_ids）与对象（override_payload）都原样返回；
      // 只有解不出来时才退化成 null，别让一处脏 JSON 把整次 pull 弄挂
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  // BIGINT 在 mysql2 下可能回传字符串，数字字段统一转 number
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return value;
}

/** 行 → payload。只输出 FIELD_MAPS 里声明过的字段，避免把 hlc/seq 这类内部列泄露给客户端 */
export function rowToPayload(table: SyncTableName, row: Row): Record<string, unknown> {
  const map = FIELD_MAPS[table];
  const payload: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(map)) {
    if (field === 'rev') continue; // rev 由 change 结构单独给
    payload[field] = decode(spec.kind, row[spec.col]);
  }
  return payload;
}

/** 客户端字段 → 列值。未声明的键直接丢弃（防客户端塞 hlc_wall 之类内部列） */
export function fieldsToColumns(
  table: SyncTableName,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const map = FIELD_MAPS[table];
  const columns: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    const spec = map[field];
    if (!spec) continue;
    if (field === 'id' || field === 'rev') continue;
    columns[spec.col] = encode(spec.kind, value);
  }
  return columns;
}

/** 判断某个字段名是否属于该表（merge 时用来过滤脏键） */
export function isKnownField(table: SyncTableName, field: string): boolean {
  return field in FIELD_MAPS[table];
}
