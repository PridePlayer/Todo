import {
  DepthLimitError,
  MAX_DEPTH,
  flagsOf,
  newTaskSchema,
  quadrantOf,
  ulid,
  type NewTask,
  type Quadrant,
  type Tag,
  type Task,
  type TaskList,
  type TaskPatch,
  type TaskStore,
} from '@grid/core';
import { db } from './dexie';

const INBOX: TaskList = { id: 'list-inbox', name: '收件箱', sortOrder: 0 };

function nowMs(): number {
  return Date.now();
}

/** 同父级同象限里的最大 sortOrder，新建的任务排到最后 */
async function maxSortOrderIn(quadrant: Quadrant, parentId: string | null): Promise<number> {
  const rows = await db.tasks.where('quadrant').equals(quadrant).toArray();
  let max = 0;
  for (const row of rows) {
    if (row.deletedAt !== null) continue;
    if (row.parentId !== parentId) continue;
    if (row.sortOrder > max) max = row.sortOrder;
  }
  return max + 1;
}

/**
 * 取整棵子树（含自己）。用物化路径前缀，不递归。
 * 路径约定：根任务 'id/'，子任务 '父路径 + id/'，所以「自己的 path」天然就是整棵子树的前缀。
 */
async function subtreeOf(task: Task): Promise<Task[]> {
  const all = await db.tasks.toArray();
  return all.filter((row) => row.path.startsWith(task.path));
}

export class LocalTaskStore implements TaskStore {
  async all(): Promise<Task[]> {
    return db.tasks.toArray();
  }

  async byId(id: string): Promise<Task | null> {
    return (await db.tasks.get(id)) ?? null;
  }

  async create(input: NewTask): Promise<Task> {
    const parsed = newTaskSchema.parse(input);
    const t = nowMs();
    const id = ulid(t);

    let parent: Task | null = null;
    if (parsed.parentId !== null) {
      parent = (await db.tasks.get(parsed.parentId)) ?? null;
      if (!parent || parent.deletedAt !== null) throw new Error('父任务不存在或已删除');
      // depth 从 0 起算，所以"最多 3 层"意味着 parent.depth 最大为 1
      if (parent.depth + 1 > MAX_DEPTH - 1) throw new DepthLimitError(parent.id);
    }

    const listId = parsed.listId ?? (await this.defaultList()).id;
    // 子任务继承父任务的象限：子任务不单独参与四象限归类，否则一列里会出现别的列的任务
    const quadrant = parent ? parent.quadrant : parsed.quadrant;
    const { important, urgent } = flagsOf(quadrant);

    const task: Task = {
      id,
      listId,
      parentId: parent?.id ?? null,
      path: parent ? `${parent.path}${id}/` : `${id}/`,
      depth: parent ? parent.depth + 1 : 0,
      title: parsed.title,
      note: parsed.note ?? null,
      quadrant,
      important,
      urgent,
      priority: parsed.priority,
      dueDate: parsed.dueDate,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      allDay: parsed.startAt === null,
      location: parsed.location,
      tagIds: parsed.tagIds,
      completedAt: null,
      archivedAt: null,
      sortOrder: await maxSortOrderIn(quadrant, parent?.id ?? null),
      rrule: null,
      remindAt: null,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      rev: 1,
    };

    await db.tasks.add(task);
    return task;
  }

  async patch(id: string, changes: TaskPatch): Promise<Task> {
    const current = (await db.tasks.get(id)) ?? null;
    if (!current) throw new Error('任务不存在');

    const t = nowMs();
    const next: Task = { ...current, updatedAt: t, rev: current.rev + 1 };

    if (changes.title !== undefined) {
      const title = changes.title.trim();
      if (title === '') throw new Error('标题不能为空');
      next.title = title.slice(0, 512);
    }
    if (changes.note !== undefined) next.note = changes.note?.slice(0, 10_000) ?? null;
    if (changes.priority !== undefined) next.priority = changes.priority;
    if (changes.dueDate !== undefined) next.dueDate = changes.dueDate;
    if (changes.startAt !== undefined) next.startAt = changes.startAt;
    if (changes.endAt !== undefined) next.endAt = changes.endAt;
    if (changes.location !== undefined) next.location = changes.location?.slice(0, 256) ?? null;
    if (changes.tagIds !== undefined) next.tagIds = changes.tagIds.slice(0, 20);
    if (changes.sortOrder !== undefined) next.sortOrder = changes.sortOrder;
    if (changes.startAt !== undefined) next.allDay = changes.startAt === null;

    if (changes.quadrant !== undefined) {
      const flags = flagsOf(changes.quadrant);
      next.important = flags.important;
      next.urgent = flags.urgent;
      next.quadrant = quadrantOf(flags.important, flags.urgent);
    }

    await db.tasks.put(next);

    if (changes.parentId !== undefined && changes.parentId !== current.parentId) {
      await this.move(id, changes.parentId);
      return (await db.tasks.get(id))!;
    }
    return next;
  }

  /** 改父级：重算自己与所有子孙的 depth/path，先校验总层数不超限 */
  private async move(id: string, newParentId: string | null): Promise<void> {
    const task = (await db.tasks.get(id))!;
    const subtree = await subtreeOf(task);

    let newDepth = 0;
    let newPath = `${task.id}/`;
    let newQuadrant = task.quadrant;

    if (newParentId !== null) {
      if (newParentId === id) throw new Error('不能把任务挂到自己下面');
      const parent = (await db.tasks.get(newParentId)) ?? null;
      if (!parent || parent.deletedAt !== null) throw new Error('目标父任务不存在');
      // 防止挂到自己的子孙下面（会造成环）
      if (parent.path.startsWith(`${task.path}${task.id}/`)) throw new Error('不能挂到自己的子任务下');
      newDepth = parent.depth + 1;
      newPath = `${parent.path}${task.id}/`;
      newQuadrant = parent.quadrant;
    }

    const ownHeight = subtree.reduce((max, row) => Math.max(max, row.depth - task.depth), 0);
    if (newDepth + ownHeight > MAX_DEPTH - 1) throw new DepthLimitError(newParentId ?? '');

    const depthDelta = newDepth - task.depth;
    const flags = flagsOf(newQuadrant);
    const t = nowMs();

    await db.transaction('rw', db.tasks, async () => {
      for (const row of subtree) {
        const depth = row.depth + depthDelta;
        // path 相对自己之后的部分（自己那一段已经包含在 newPath 里）
        const relative = row.path.slice(task.path.length);
        const path = `${newPath}${relative}`;
        const isSelf = row.id === task.id;
        await db.tasks.put({
          ...row,
          parentId: isSelf ? newParentId : row.parentId,
          depth,
          path,
          quadrant: isSelf ? newQuadrant : row.quadrant,
          important: isSelf ? flags.important : row.important,
          urgent: isSelf ? flags.urgent : row.urgent,
          updatedAt: t,
          rev: row.rev + 1,
        });
      }
    });
  }

  async toggleComplete(id: string): Promise<Task> {
    const task = (await db.tasks.get(id)) ?? null;
    if (!task) throw new Error('任务不存在');

    const subtree = await subtreeOf(task);
    const target = task.completedAt === null ? nowMs() : null;
    const t = nowMs();

    await db.transaction('rw', db.tasks, async () => {
      for (const row of subtree) {
        // 完成父任务 = 完成整棵子树，否则列表里会留下"父任务已完成但子任务还开着"的鬼状态
        await db.tasks.put({ ...row, completedAt: target, updatedAt: t, rev: row.rev + 1 });
      }
    });

    return (await db.tasks.get(id))!;
  }

  async softDelete(id: string): Promise<string[]> {
    const task = (await db.tasks.get(id)) ?? null;
    if (!task) return [];
    const subtree = await subtreeOf(task);
    const ids = subtree.map((row) => row.id);
    const t = nowMs();
    await db.transaction('rw', db.tasks, async () => {
      for (const row of subtree) {
        await db.tasks.put({ ...row, deletedAt: t, updatedAt: t, rev: row.rev + 1 });
      }
    });
    return ids;
  }

  async restore(ids: readonly string[]): Promise<void> {
    const t = nowMs();
    await db.transaction('rw', db.tasks, async () => {
      for (const id of ids) {
        const row = await db.tasks.get(id);
        if (!row) continue;
        await db.tasks.put({ ...row, deletedAt: null, updatedAt: t, rev: row.rev + 1 });
      }
    });
  }

  async purge(ids: readonly string[]): Promise<void> {
    await db.tasks.bulkDelete([...ids]);
  }

  async purgeExpired(graceMs: number): Promise<number> {
    const cutoff = nowMs() - graceMs;
    const rows = await db.tasks.toArray();
    const stale = rows.filter((row) => row.deletedAt !== null && row.deletedAt < cutoff).map((r) => r.id);
    if (stale.length > 0) await db.tasks.bulkDelete(stale);
    return stale.length;
  }

  async maxSortOrder(quadrant: Quadrant): Promise<number> {
    return maxSortOrderIn(quadrant, null);
  }

  async tags(): Promise<Tag[]> {
    return db.tags.toArray();
  }

  async ensureTag(name: string): Promise<Tag> {
    const clean = name.trim().replace(/^#/, '').slice(0, 24);
    if (clean === '') throw new Error('标签不能为空');
    const existing = await db.tags.toArray();
    const hit = existing.find((tag) => tag.name.toLowerCase() === clean.toLowerCase());
    if (hit) return hit;
    const tag: Tag = {
      id: ulid(),
      name: clean,
      colorKey: existing.length % 5,
    };
    await db.tags.add(tag);
    return tag;
  }

  async lists(): Promise<TaskList[]> {
    const rows = await db.lists.orderBy('sortOrder').toArray();
    if (rows.length > 0) return rows;
    await db.lists.put(INBOX);
    return [INBOX];
  }

  async defaultList(): Promise<TaskList> {
    const rows = await this.lists();
    return rows[0] ?? INBOX;
  }
}

export const repo = new LocalTaskStore();
