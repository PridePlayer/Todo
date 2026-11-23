import Dexie, { type Table } from 'dexie';
import type {
  CalEvent,
  CalendarSource,
  Habit,
  HabitLog,
  RecurException,
  SyncTable,
  Tag,
  Task,
  TaskList,
} from '@grid/core';

/**
 * 本地操作队列的一条记录。
 *
 * 语义是"意图"而不是"结果"：记录的是"我要把某几个字段改成什么"，
 * 所以它是可以被合并（coalescing）的——连续改三次标题，队列里只留最后一条。
 */
export interface OutboxOp {
  opId: string;
  table: SyncTable;
  action: 'create' | 'update' | 'delete';
  id: string;
  baseRev: number;
  /** JSON 字符串：改动字段（camelCase，与 Task 模型一致） */
  fields: string;
  /** JSON 字符串：这些字段在改动前的值，服务端用它判断"远端有没有动过" */
  base: string | null;
  hlcWall: number;
  hlcCounter: number;
  device: string;
  createdAt: number;
  status: 'pending' | 'failed';
  error: string | null;
}

export interface MetaRow {
  key: string;
  value: string;
}

/** 冲突待决：服务端把败者值留在 conflict_log，本地这份用于抽屉里"一键切回" */
export interface ConflictRow {
  id: string;
  taskId: string;
  field: string;
  /** JSON 字符串 */
  local: string;
  remote: string;
  createdAt: number;
}

/**
 * 本地库（IndexedDB）。
 *
 * 纪律：**视图层不直接碰这个文件**，一律走 repo.ts。
 * 原因不是洁癖——写入路径上要插操作队列，组件里散落的 `db.tasks.put()` 会绕过同步，
 * 表现为"这台机器上改了但另一台永远看不到"，而且极难定位。
 *
 * 索引说明（IndexedDB 不索引 null，因此 deletedAt 上的索引用不上，软删行靠内存过滤）：
 *   quadrant    四象限列表的主查询
 *   parentId    展开子任务
 *   completedAt 区分未完成/已完成
 *   path        取整棵子树（前缀查询）
 *   outbox.status + createdAt  flush 时取待推送的批次
 */
export class GridDB extends Dexie {
  tasks!: Table<Task, string>;
  tags!: Table<Tag, string>;
  lists!: Table<TaskList, string>;
  outbox!: Table<OutboxOp, string>;
  meta!: Table<MetaRow, string>;
  conflicts!: Table<ConflictRow, string>;
  exceptions!: Table<RecurException, string>;
  events!: Table<CalEvent, string>;
  sources!: Table<CalendarSource, string>;
  habits!: Table<Habit, string>;
  habitLogs!: Table<HabitLog, string>;

  constructor() {
    super('grid');
    this.version(1).stores({
      tasks: 'id, parentId, quadrant, completedAt, dueDate, path, sortOrder, deletedAt, listId',
      tags: 'id, &name',
      lists: 'id, sortOrder',
    });
    // v2：同步内核。只加表，不动已有表定义（IndexedDB 的迁移是"加表不用写 upgrade"）
    this.version(2).stores({
      tasks: 'id, parentId, quadrant, completedAt, dueDate, path, sortOrder, deletedAt, listId',
      tags: 'id, &name',
      lists: 'id, sortOrder',
      outbox: 'opId, status, createdAt, id',
      meta: 'key',
      conflicts: 'id, taskId, createdAt',
    });
    // v3：重复例外。seriesId + originalStart 是查表主路径（按系列取全部例外）
    this.version(3).stores({
      tasks: 'id, parentId, quadrant, completedAt, dueDate, path, sortOrder, deletedAt, listId',
      tags: 'id, &name',
      lists: 'id, sortOrder',
      outbox: 'opId, status, createdAt, id',
      meta: 'key',
      conflicts: 'id, taskId, createdAt',
      exceptions: 'id, seriesId, originalStart, kind, deletedAt',
    });
    // v4：Outlook 镜像。events 按 startAt 建索引：日历只展开当前窗口，
    // 有索引就不必把上千条历史会议读进内存再过滤
    this.version(4).stores({
      tasks: 'id, parentId, quadrant, completedAt, dueDate, path, sortOrder, deletedAt, listId',
      tags: 'id, &name',
      lists: 'id, sortOrder',
      outbox: 'opId, status, createdAt, id',
      meta: 'key',
      conflicts: 'id, taskId, createdAt',
      exceptions: 'id, seriesId, originalStart, kind, deletedAt',
      events: 'id, sourceId, startAt, endAt, deletedAt',
      sources: 'id, sortOrder, deletedAt',
    });
    // v5：打卡。habitLogs 的复合索引 [habitId+logDate] 是详情页的主查询——
    // 一个习惯一年 365 行，按 habitId 取全部再内存过滤会随年数线性变慢
    this.version(5).stores({
      tasks: 'id, parentId, quadrant, completedAt, dueDate, path, sortOrder, deletedAt, listId',
      tags: 'id, &name',
      lists: 'id, sortOrder',
      outbox: 'opId, status, createdAt, id',
      meta: 'key',
      conflicts: 'id, taskId, createdAt',
      exceptions: 'id, seriesId, originalStart, kind, deletedAt',
      events: 'id, sourceId, startAt, endAt, deletedAt',
      sources: 'id, sortOrder, deletedAt',
      habits: 'id, sortOrder, archivedAt, deletedAt',
      habitLogs: 'id, habitId, logDate, deletedAt, [habitId+logDate]',
    });
    this.tasks = this.table('tasks');
    this.tags = this.table('tags');
    this.lists = this.table('lists');
    this.outbox = this.table('outbox');
    this.meta = this.table('meta');
    this.conflicts = this.table('conflicts');
    this.exceptions = this.table('exceptions');
    this.events = this.table('events');
    this.sources = this.table('sources');
    this.habits = this.table('habits');
    this.habitLogs = this.table('habitLogs');
  }
}

export const db = new GridDB();
