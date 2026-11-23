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

export const FIELD_MAPS = {
  task: TASK_FIELDS,
  tag: TAG_FIELDS,
  list: LIST_FIELDS,
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
    if (value === null || value === undefined || value === '') return [];
    try {
      const parsed = JSON.parse(String(value));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // 库里存了半截 JSON 时不要让整个 pull 失败，退化成空数组
      return [];
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
