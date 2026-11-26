import { flagsOf, ulid, type Tag, type Task } from '@grid/core';
import type { ImportRow } from '../lib/task-import';
import { notifyLocalChange } from '../sync/bus';
import { bumpHlc } from '../sync/hlc';
import { db, type OutboxOp } from './dexie';
import { taskPayload } from './repo';

/**
 * 批量导入的落库（docs/12）。
 *
 * 「整批失败就一条不写」在这里是靠**一个 Dexie 事务**保证的，不是靠"先检查一遍"：
 * 检查只能挡住校验错误，挡不住写入过程中磁盘满、IndexedDB 被别的标签页锁住这类事故。
 * 没有事务的话，那种失败会留下"前 300 条在、后 200 条没在"的结果 ——
 * 而这正是用户最难处理的状态：他不知道从哪继续，重导会不会重复也说不清。
 */

const INBOX_ID = 'list-inbox';
const MAX_TAGS_PER_TASK = 20;

export interface ImportOutcome {
  created: number;
  /** 标题 + 日期完全相同、被跳过的条数 */
  skipped: number;
  /** 这次现建的标签名 */
  newTags: string[];
}

/**
 * 去重键：标题 + 日期。
 *
 * 不用标题单独判：同一件事在月初和月末各做一次很常见，只按标题会漏导。
 * 也不用标题 + 时间：全天任务没有时间，"上午想起来又加一遍"应该被挡住。
 */
function dedupeKey(title: string, dueDate: string | null): string {
  return `${title.trim()}\u0000${dueDate ?? ''}`;
}

export async function importTasks(rows: readonly ImportRow[]): Promise<ImportOutcome> {
  if (rows.length === 0) return { created: 0, skipped: 0, newTags: [] };

  // HLC 必须在事务外先取一次：`bumpHlc()` 自己会开 `db.transaction('rw', db.meta, …)`，
  // 在已打开的事务里再调它属于嵌套事务，Dexie 会直接抛错。
  // 批次内改为在基准上递增 —— HLC 的规则本来就是"墙钟相同则计数递增"，这样完全合法。
  const base = await bumpHlc();
  const now = Date.now();
  let counter = base.counter;

  const outcome = await db.transaction('rw', [db.tasks, db.tags, db.outbox, db.meta], async () => {
    // ── 现有数据：去重键 + 各象限的 sortOrder 水位 ──
    const existing = await db.tasks.toArray();
    const seen = new Set<string>();
    const maxOrder = new Map<number, number>();
    for (const task of existing) {
      if (task.deletedAt !== null) continue;
      seen.add(dedupeKey(task.title, task.dueDate));
      if (task.parentId !== null) continue;
      const water = maxOrder.get(task.quadrant) ?? 0;
      if (task.sortOrder > water) maxOrder.set(task.quadrant, task.sortOrder);
    }

    // ── 标签：按名字不区分大小写匹配，缺的现建（tags 表有 &name 唯一索引，重名会直接失败） ──
    const tagRows = await db.tags.toArray();
    const tagByName = new Map<string, Tag>();
    for (const tag of tagRows) tagByName.set(tag.name.toLowerCase(), tag);
    const newTags: Tag[] = [];
    const newTagNames: string[] = [];

    const tasks: Task[] = [];
    const ops: OutboxOp[] = [];

    const enqueue = (
      table: OutboxOp['table'],
      action: OutboxOp['action'],
      id: string,
      fields: Record<string, unknown>,
    ): void => {
      counter += 1;
      ops.push({
        opId: ulid(),
        table,
        action,
        id,
        baseRev: 0,
        fields: JSON.stringify(fields),
        base: null,
        hlcWall: base.wall,
        hlcCounter: counter,
        device: base.device,
        createdAt: now,
        status: 'pending',
        error: null,
      });
    };

    let skipped = 0;

    for (const row of rows) {
      const key = dedupeKey(row.draft.title, row.draft.dueDate ?? null);
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);

      const tagIds: string[] = [];
      for (const raw of row.tags) {
        const name = raw.trim().replace(/^#/, '').slice(0, 24);
        if (name === '') continue;
        const lower = name.toLowerCase();
        let tag = tagByName.get(lower);
        if (!tag) {
          tag = { id: ulid(), name, colorKey: (tagRows.length + newTags.length) % 5 };
          tagByName.set(lower, tag);
          newTags.push(tag);
          newTagNames.push(name);
        }
        if (!tagIds.includes(tag.id)) tagIds.push(tag.id);
        if (tagIds.length >= MAX_TAGS_PER_TASK) break;
      }

      const id = ulid();
      // NewTask 是 zod 的 input 类型，带 default 的字段在类型上仍是 optional，这里补一次
      const quadrant = row.draft.quadrant ?? 4;
      const { important, urgent } = flagsOf(quadrant);
      // 按象限各自递增：混用全局计数器会让 01 象限的排序号被 04 撑大，
      // 四象限视图里的顺序就和手动挡的对不上
      const sortOrder = (maxOrder.get(quadrant) ?? 0) + 1;
      maxOrder.set(quadrant, sortOrder);

      const task: Task = {
        id,
        listId: INBOX_ID,
        parentId: null,
        path: `${id}/`,
        depth: 0,
        title: row.draft.title,
        note: row.draft.note ?? null,
        quadrant,
        important,
        urgent,
        priority: row.draft.priority ?? 0,
        dueDate: row.draft.dueDate ?? null,
        startAt: row.draft.startAt ?? null,
        endAt: row.draft.endAt ?? null,
        allDay: (row.draft.startAt ?? null) === null,
        location: row.draft.location ?? null,
        tagIds,
        completedAt: null,
        archivedAt: null,
        sortOrder,
        rrule: row.draft.rrule ?? null,
        remindAt: null,
        remindLeadMinutes: row.draft.remindLeadMinutes ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        rev: 0,
      };
      tasks.push(task);
      enqueue('task', 'create', id, taskPayload(task));
    }

    if (newTags.length > 0) {
      await db.tags.bulkAdd(newTags);
      for (const tag of newTags) {
        enqueue('tag', 'create', tag.id, { name: tag.name, colorKey: tag.colorKey });
      }
    }
    if (tasks.length > 0) await db.tasks.bulkAdd(tasks);
    if (ops.length > 0) {
      await db.outbox.bulkAdd(ops);
      // 把批次用掉的 HLC 写回 meta，否则下一次 bumpHlc 会从旧计数继续，产生重复的 (wall, counter)
      await db.meta.put({ key: 'hlcWall', value: String(base.wall) });
      await db.meta.put({ key: 'hlcCounter', value: String(counter) });
    }

    return { created: tasks.length, skipped, newTags: newTagNames };
  });

  // 事务提交之后才喊"我改了"：放在事务里的话，一旦回滚引擎已经被叫醒，
  // 它会去推一个空的队列，日志上表现为一次没有原因的空同步
  if (outcome.created > 0 || outcome.newTags.length > 0) notifyLocalChange();
  return outcome;
}
