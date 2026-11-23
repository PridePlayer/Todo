import {
  DepthLimitError,
  MAX_DEPTH,
  expandSeries,
  flagsOf,
  newTaskSchema,
  parseRrule,
  planAll,
  planSkip,
  planThisAndFollowing,
  planThisOnly,
  quadrantOf,
  ulid,
  type ExceptionDraft,
  type NewTask,
  type Occurrence,
  type OccurrencePatch,
  type Quadrant,
  type RecurException,
  type SeriesLike,
  type SyncTable,
  type Tag,
  type Task,
  type TaskList,
  type TaskPatch,
  type TaskStore,
} from '@grid/core';
import { db, type OutboxOp } from './dexie';
import { notifyLocalChange } from '../sync/bus';
import { bumpHlc } from '../sync/hlc';

const INBOX: TaskList = { id: 'list-inbox', name: '收件箱', sortOrder: 0 };

function nowMs(): number {
  return Date.now();
}

/** 线上 payload：与 core 的 Task 模型同名同义，服务端 task-map 负责落库映射 */
function taskPayload(task: Task): Record<string, unknown> {
  return {
    listId: task.listId,
    parentId: task.parentId,
    path: task.path,
    depth: task.depth,
    title: task.title,
    note: task.note,
    quadrant: task.quadrant,
    important: task.important,
    urgent: task.urgent,
    priority: task.priority,
    dueDate: task.dueDate,
    startAt: task.startAt,
    endAt: task.endAt,
    allDay: task.allDay,
    location: task.location,
    tagIds: task.tagIds,
    completedAt: task.completedAt,
    archivedAt: task.archivedAt,
    sortOrder: task.sortOrder,
    rrule: task.rrule,
    remindAt: task.remindAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    deletedAt: task.deletedAt,
  };
}

async function pendingFor(id: string): Promise<OutboxOp[]> {
  return db.outbox.where('id').equals(id).toArray();
}

async function pushOp(op: {
  table: SyncTable;
  action: 'create' | 'update' | 'delete';
  id: string;
  baseRev: number;
  fields: Record<string, unknown>;
  base?: Record<string, unknown> | null;
}): Promise<void> {
  const hlc = await bumpHlc();
  await db.outbox.add({
    opId: ulid(),
    table: op.table,
    action: op.action,
    id: op.id,
    baseRev: op.baseRev,
    fields: JSON.stringify(op.fields),
    base: op.base ? JSON.stringify(op.base) : null,
    hlcWall: hlc.wall,
    hlcCounter: hlc.counter,
    device: hlc.device,
    createdAt: nowMs(),
    status: 'pending',
    error: null,
  });
  // 所有入队都从这里过，所以引擎只需要听这一处就知道"该同步了"
  notifyLocalChange();
}

/**
 * 更新入队 + 合并（docs/03 §8.2）。
 * 连续编辑同一条任务时，队列里只留一条 op，字段取并集、base 取最早值。
 * 不合并的后果是：改一次标题就排一条 op，flush 一批 50 条全是同一个任务。
 */
async function enqueueUpdate(
  id: string,
  fields: Record<string, unknown>,
  base: Record<string, unknown> | null,
  baseRev: number,
  table: SyncTable = 'task',
): Promise<void> {
  const pending = await pendingFor(id);
  const createOp = pending.find((op) => op.action === 'create');
  if (createOp) {
    const merged = { ...(JSON.parse(createOp.fields) as Record<string, unknown>), ...fields };
    await db.outbox.put({ ...createOp, fields: JSON.stringify(merged) });
    notifyLocalChange();
    return;
  }
  const updateOp = pending.find((op) => op.action === 'update');
  if (updateOp) {
    const mergedFields = { ...(JSON.parse(updateOp.fields) as Record<string, unknown>), ...fields };
    const mergedBase = {
      ...(updateOp.base ? (JSON.parse(updateOp.base) as Record<string, unknown>) : {}),
      ...(base ?? {}),
    };
    await db.outbox.put({
      ...updateOp,
      fields: JSON.stringify(mergedFields),
      base: JSON.stringify(mergedBase),
    });
    notifyLocalChange();
    return;
  }
  await pushOp({ table, action: 'update', id, baseRev, fields, base });
}

/**
 * 通用入队：给 task 之外的实体（cal_event）用。
 * task 的合并规则（四象限、tagIds）不适用于别的表，但它们共用"同一条只留一条 op"的逻辑。
 */
export async function enqueueTableUpdate(
  table: SyncTable,
  id: string,
  fields: Record<string, unknown>,
  base: Record<string, unknown>,
  baseRev: number,
): Promise<void> {
  await enqueueUpdate(id, fields, base, baseRev, table);
}

/** 通用新建入队（给 task 之外的表用，例如 habit / habit_log） */
export async function enqueueTableCreate(
  table: SyncTable,
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await pushOp({ table, action: 'create', id, baseRev: 0, fields, base: null });
}

/** 通用软删入队 */
export async function enqueueTableDelete(table: SyncTable, id: string, baseRev: number): Promise<void> {
  await pushOp({ table, action: 'delete', id, baseRev, fields: {}, base: null });
}

/**
 * 直接入队一次字段更新。
 *
 * 只给同步层用（冲突裁决要写 `repo.patch` 白名单之外的字段，例如 completedAt）。
 * 视图层一律走 `repo.patch`，那里有校验、有范围裁剪、有 base 记录。
 */
export async function enqueueFieldUpdate(
  id: string,
  fields: Record<string, unknown>,
  base: Record<string, unknown>,
  baseRev: number,
): Promise<void> {
  await enqueueUpdate(id, fields, base, baseRev);
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
      // depth 从 0 起算，"最多 3 层"意味着 parent.depth 最大为 1
      if (parent.depth + 1 > MAX_DEPTH - 1) throw new DepthLimitError(parent.id);
    }

    const listId = parsed.listId ?? (await this.defaultList()).id;
    // 子任务继承父任务的象限：否则一列里会混进另一列的任务
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
      rrule: parsed.rrule,
      remindAt: null,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      rev: 0, // 0 = 服务端还没有这一行
    };

    await db.tasks.add(task);
    await pushOp({ table: 'task', action: 'create', id, baseRev: 0, fields: taskPayload(task), base: null });
    return task;
  }

  async patch(id: string, changes: TaskPatch): Promise<Task> {
    const current = (await db.tasks.get(id)) ?? null;
    if (!current) throw new Error('任务不存在');

    const t = nowMs();
    const next: Task = { ...current, updatedAt: t };
    const base: Record<string, unknown> = {};

    if (changes.title !== undefined) {
      const title = changes.title.trim();
      if (title === '') throw new Error('标题不能为空');
      next.title = title.slice(0, 512);
      base.title = current.title;
    }
    if (changes.note !== undefined) {
      next.note = changes.note?.slice(0, 10_000) ?? null;
      base.note = current.note;
    }
    if (changes.priority !== undefined) {
      next.priority = changes.priority;
      base.priority = current.priority;
    }
    if (changes.dueDate !== undefined) {
      next.dueDate = changes.dueDate;
      base.dueDate = current.dueDate;
    }
    if (changes.startAt !== undefined) {
      next.startAt = changes.startAt;
      next.allDay = changes.startAt === null;
      base.startAt = current.startAt;
      base.allDay = current.allDay;
    }
    if (changes.endAt !== undefined) {
      next.endAt = changes.endAt;
      base.endAt = current.endAt;
    }
    if (changes.location !== undefined) {
      next.location = changes.location?.slice(0, 256) ?? null;
      base.location = current.location;
    }
    if (changes.tagIds !== undefined) {
      next.tagIds = changes.tagIds.slice(0, 20);
      base.tagIds = current.tagIds;
    }
    if (changes.sortOrder !== undefined) {
      next.sortOrder = changes.sortOrder;
      base.sortOrder = current.sortOrder;
    }
    if (changes.quadrant !== undefined) {
      const flags = flagsOf(changes.quadrant);
      next.important = flags.important;
      next.urgent = flags.urgent;
      next.quadrant = quadrantOf(flags.important, flags.urgent);
      base.important = current.important;
      base.urgent = current.urgent;
      base.quadrant = current.quadrant;
    }
    if (changes.rrule !== undefined) {
      // 规则字符串必须先过校验：一旦写进库，视图会拿它去展开，
      // 非法字符串会在每次渲染时抛错，症状是"整页白屏"而不是"这条规则没生效"
      if (changes.rrule !== null) parseRrule(changes.rrule);
      next.rrule = changes.rrule;
      base.rrule = current.rrule;
    }

    await db.tasks.put(next);

    if (changes.parentId !== undefined && changes.parentId !== current.parentId) {
      await this.move(id, changes.parentId);
      return (await db.tasks.get(id))!;
    }

    if (Object.keys(base).length > 0) {
      await enqueueUpdate(id, { ...base, ...pick(next, Object.keys(base)) }, base, current.rev);
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
      if (parent.path.startsWith(task.path)) throw new Error('不能挂到自己的子任务下');
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
        });
      }
    });

    await enqueueUpdate(
      id,
      { parentId: newParentId, path: newPath, depth: newDepth, quadrant: newQuadrant, important: flags.important, urgent: flags.urgent },
      { parentId: task.parentId, path: task.path, depth: task.depth, quadrant: task.quadrant, important: task.important, urgent: task.urgent },
      task.rev,
    );
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
        await db.tasks.put({ ...row, completedAt: target, updatedAt: t });
      }
    });

    for (const row of subtree) {
      await enqueueUpdate(row.id, { completedAt: target }, { completedAt: row.completedAt }, row.rev);
    }

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
        await db.tasks.put({ ...row, deletedAt: t, updatedAt: t });
      }
    });

    for (const row of subtree) {
      const pending = await pendingFor(row.id);
      const createOp = pending.find((op) => op.action === 'create');
      if (createOp) {
        // 服务端还没见过这一行 → 撤掉 create，本地直接删，不需要墓碑
        await db.outbox.delete(createOp.opId);
        await db.tasks.delete(row.id);
        continue;
      }
      // 之前的 update 已经被删除覆盖，留着只会推一次无意义的写
      for (const op of pending.filter((item) => item.action === 'update')) {
        await db.outbox.delete(op.opId);
      }
      await pushOp({ table: 'task', action: 'delete', id: row.id, baseRev: row.rev, fields: {}, base: null });
    }

    // 系列被删 → 它的例外必须一起走，否则服务端留下"系列不存在但例外还在"的孤儿，
    // 而 M3 的出口条件正是要求这类孤儿为 0
    for (const row of subtree) {
      if (row.rrule === null) continue;
      const exceptions = await this.exceptionsOf(row.id);
      for (const exception of exceptions) {
        await db.exceptions.put({ ...exception, deletedAt: t, updatedAt: t });
        await pushOp({
          table: 'recur_exception',
          action: 'delete',
          id: exception.id,
          baseRev: exception.rev,
          fields: {},
          base: null,
        });
      }
    }

    // 走到这里可能一条 op 都没新增（新建后立刻删除 = 本地直接清掉），
    // 但待推送条数变了，引擎得知道
    notifyLocalChange();
    return ids;
  }

  async restore(ids: readonly string[]): Promise<void> {
    const t = nowMs();
    for (const id of ids) {
      const row = await db.tasks.get(id);
      if (!row) continue;
      // 撤销窗口内还没推出去的 delete 直接撤单，服务端根本不知道发生过删除
      const pending = await pendingFor(id);
      const deleteOp = pending.find((op) => op.action === 'delete');
      if (deleteOp) await db.outbox.delete(deleteOp.opId);

      await db.tasks.put({ ...row, deletedAt: null, updatedAt: t });
      await enqueueUpdate(id, { deletedAt: null }, { deletedAt: t }, row.rev);
    }
    notifyLocalChange();
  }

  async purge(ids: readonly string[]): Promise<void> {
    await db.tasks.bulkDelete([...ids]);
  }

  async purgeExpired(graceMs: number): Promise<number> {
    const cutoff = nowMs() - graceMs;
    const rows = await db.tasks.toArray();
    // 只清理"已经推送到服务端"的软删行；还没推的必须留着，否则删除会丢失
    const stale = rows.filter((row) => row.deletedAt !== null && row.deletedAt < cutoff && row.rev > 0);
    if (stale.length > 0) await db.tasks.bulkDelete(stale.map((row) => row.id));
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

    const tag: Tag = { id: ulid(), name: clean, colorKey: existing.length % 5 };
    await db.tags.add(tag);
    await pushOp({ table: 'tag', action: 'create', id: tag.id, baseRev: 0, fields: { name: tag.name, colorKey: tag.colorKey }, base: null });
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

  // ── 重复（M3） ────────────────────────────────────────────

  async exceptionsOf(seriesId: string): Promise<RecurException[]> {
    const rows = await db.exceptions.where('seriesId').equals(seriesId).toArray();
    return rows.filter((row) => row.deletedAt === null);
  }

  async allExceptions(): Promise<RecurException[]> {
    const rows = await db.exceptions.toArray();
    return rows.filter((row) => row.deletedAt === null);
  }

  /**
   * 设规则。重复必须有确定的起点，所以顺手把"只有日期没有时刻"的任务补成 09:00。
   * 不补的话展开时找不到锚点，日历里会出现"这条任务明明重复了却一次都不显示"。
   */
  async setRrule(id: string, rrule: string | null): Promise<Task> {
    const task = (await db.tasks.get(id)) ?? null;
    if (!task) throw new Error('任务不存在');

    const patch: TaskPatch = { rrule };
    if (rrule !== null && task.startAt === null) {
      const anchor = task.dueDate
        ? new Date(`${task.dueDate}T09:00:00`).getTime()
        : startOfHour(Date.now());
      patch.startAt = anchor;
      patch.endAt = anchor + 60 * 60 * 1000;
    }
    return this.patch(id, patch);
  }

  /**
   * 三选项编辑的入口。
   *
   * `scope` 决定写哪张表，而不是写哪种 UI 状态：
   *   this      → recur_exception(override)
   *   following → 母体截断 + 新系列 + 例外改挂
   *   all       → 母体
   */
  async editOccurrence(
    seriesId: string,
    originalStart: number,
    scope: 'this' | 'following' | 'all',
    patch: OccurrencePatch,
  ): Promise<void> {
    const task = (await db.tasks.get(seriesId)) ?? null;
    if (!task) throw new Error('重复系列不存在');

    if (scope === 'all') {
      await this.patch(seriesId, patch as TaskPatch);
      return;
    }

    const exceptions = await this.exceptionsOf(seriesId);
    const series = toSeriesLike(task, exceptions);
    const occurrence = findOccurrence(series, originalStart);
    if (!occurrence) throw new Error('找不到这一次，可能已被其他设备修改');

    if (scope === 'this') {
      const draft = planThisOnly(series, occurrence, patch);
      if (draft) await this.upsertException(draft);
      return;
    }

    const plan = planThisAndFollowing(series, occurrence, patch);

    // 先把母体截断，再建新系列：反过来的话，中间会有一瞬间
    // "旧系列还带着周五 + 新系列也有周五"，界面上闪一下重复的事件块。
    // 而删母体必须放到最后——例外要先改挂，否则中间态是孤儿（出口条件查的就是它）
    if (!plan.retireMaster) {
      await this.patch(seriesId, { rrule: plan.masterRrule! });
    }

    const created = await this.create({
      title: plan.next.title,
      quadrant: task.quadrant,
      parentId: task.parentId,
      listId: task.listId,
      note: task.note ?? undefined,
      location: task.location,
      startAt: plan.next.startAt,
      endAt: plan.next.endAt,
      tagIds: task.tagIds,
    });
    await this.patch(created.id, {
      rrule: plan.next.rrule,
      ...(plan.next.patch.note !== undefined ? { note: plan.next.patch.note } : {}),
      ...(plan.next.patch.location !== undefined ? { location: plan.next.patch.location } : {}),
    });

    for (const exception of exceptions) {
      if (exception.originalStart < occurrence.originalStart) continue;
      const now = nowMs();
      await db.exceptions.put({ ...exception, seriesId: created.id, updatedAt: now });
      await pushOp({
        table: 'recur_exception',
        action: 'update',
        id: exception.id,
        baseRev: exception.rev,
        fields: { seriesId: created.id, updatedAt: now },
        base: { seriesId },
      });
    }

    if (plan.retireMaster) {
      // cutoff 就是第一次 → 整条系列都被"及后续"换掉，母体最后再消失
      await this.softDelete(seriesId);
    }
  }

  /** 删除某一次（仅本次）：写一条 kind='deleted' 的例外，母体不动 */
  async skipOccurrence(seriesId: string, originalStart: number): Promise<void> {
    await this.upsertException(planSkip(seriesId, originalStart));
  }

  private async upsertException(draft: ExceptionDraft): Promise<RecurException> {
    const siblings = await db.exceptions.where('seriesId').equals(draft.seriesId).toArray();
    const existing = siblings.find((row) => row.originalStart === draft.originalStart);
    const now = nowMs();

    if (existing) {
      // 复活路径：同一次被跳过之后又想改回来时，复用同一行（服务端的唯一键
      // 是 (series_id, original_start)，新建一行会被拒绝），deletedAt 必须显式清零
      const row: RecurException = { ...existing, ...draft, deletedAt: null, updatedAt: now };
      await db.exceptions.put(row);
      await pushOp({
        table: 'recur_exception',
        action: 'update',
        id: row.id,
        baseRev: existing.rev,
        fields: exceptionFields(row),
        base: exceptionFields(existing),
      });
      return row;
    }

    const row: RecurException = {
      id: ulid(now),
      ...draft,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      rev: 0, // 0 = 服务端还没有这一行
    };
    await db.exceptions.put(row);
    await pushOp({ table: 'recur_exception', action: 'create', id: row.id, baseRev: 0, fields: exceptionFields(row), base: null });
    return row;
  }
}

/** 从对象里挑出指定键，用于构造"新值" */
function pick<T extends object>(source: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = (source as Record<string, unknown>)[key];
  return out;
}

function startOfHour(ts: number): number {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/**
 * 例外行 → 线上字段。
 * `rev` 不进 fields：它是服务端维护的版本号，客户端只能读不能写
 * （写进去会被 task-map 过滤掉，但留在这里会让人误以为可以控制）。
 */
function exceptionFields(row: RecurException): Record<string, unknown> {
  return {
    seriesId: row.seriesId,
    originalStart: row.originalStart,
    kind: row.kind,
    overrideStart: row.overrideStart,
    overrideEnd: row.overrideEnd,
    overrideTitle: row.overrideTitle,
    payload: row.payload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * 任务 → 可展开的系列。
 *
 * 锚点的兜底顺序是 startAt → dueDate 09:00 → createdAt：
 * 展开必须有确定的时刻，而"只有日期"的任务在日历里也要能重复出现。
 */
function toSeriesLike(task: Task, exceptions: readonly RecurException[]): SeriesLike {
  const anchor =
    task.startAt ??
    (task.dueDate ? new Date(`${task.dueDate}T09:00:00`).getTime() : task.createdAt);
  return {
    id: task.id,
    title: task.title,
    startAt: anchor,
    endAt: task.endAt,
    allDay: task.allDay && task.startAt === null,
    rrule: task.rrule,
    exceptions,
  };
}

/** 在 ±31 天窗口里找出 originalStart 匹配的那一次（它可能被前一个例外挪过位置） */
function findOccurrence(series: SeriesLike, originalStart: number): Occurrence | null {
  const window = 31 * 24 * 60 * 60 * 1000;
  const list = expandSeries(series, originalStart - window, originalStart + window);
  return list.find((item) => item.originalStart === originalStart) ?? null;
}

export const repo = new LocalTaskStore();
