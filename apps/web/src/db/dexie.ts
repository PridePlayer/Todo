import Dexie, { type Table } from 'dexie';
import type { Tag, Task, TaskList } from '@grid/core';

/**
 * 本地操作队列的一条记录。
 *
 * 语义是"意图"而不是"结果"：记录的是"我要把某几个字段改成什么"，
 * 所以它是可以被合并（coalescing）的——连续改三次标题，队列里只留最后一条。
 */
export interface OutboxOp {
  opId: string;
  table: 'task' | 'tag' | 'list';
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
    this.tasks = this.table('tasks');
    this.tags = this.table('tags');
    this.lists = this.table('lists');
    this.outbox = this.table('outbox');
    this.meta = this.table('meta');
    this.conflicts = this.table('conflicts');
  }
}

export const db = new GridDB();
