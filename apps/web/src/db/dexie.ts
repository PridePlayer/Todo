import Dexie, { type Table } from 'dexie';
import type { Tag, Task, TaskList } from '@grid/core';

/**
 * 本地库（IndexedDB）。
 *
 * 纪律：**视图层不直接碰这个文件**，一律走 repo.ts。
 * 原因不是洁癖——M2 要在写入路径上插操作队列，如果组件里散落着 `db.tasks.put()`，
 * 那时候得一个个改，而且必漏。
 *
 * 索引说明（IndexedDB 只索引存在且非 null 的值，所以 deletedAt 上查不到 null 的行，
 * 这也是"软删除的行"必须靠内存过滤而不是索引查询的原因）：
 *   quadrant    四象限列表的主查询（每列一条 range）
 *   parentId    展开子任务
 *   completedAt 区分未完成/已完成
 *   sortOrder   列内手动顺序
 *   path        取某任务整棵子树（前缀查询）
 */
export class GridDB extends Dexie {
  tasks!: Table<Task, string>;
  tags!: Table<Tag, string>;
  lists!: Table<TaskList, string>;

  constructor() {
    super('grid');
    this.version(1).stores({
      tasks: 'id, parentId, quadrant, completedAt, dueDate, path, sortOrder, deletedAt, listId',
      tags: 'id, &name',
      lists: 'id, sortOrder',
    });
    this.tasks = this.table('tasks');
    this.tags = this.table('tags');
    this.lists = this.table('lists');
  }
}

export const db = new GridDB();
