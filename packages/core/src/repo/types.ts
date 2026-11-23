import type { NewTask, Quadrant, Tag, Task, TaskList } from '../models/task';

/**
 * 仓储接口。
 *
 * M1 唯一实现是 Dexie（apps/web/src/db/repo.ts）。
 * M2 会加一个「同步实现」：写入时先落本地、再把操作塞进队列。
 * 之所以现在就抽出接口，是因为**视图层不允许知道数据从哪来**——
 * 否则 M2 接同步时要回头改每一个组件，那才是真正的返工。
 */
export interface TaskPatch {
  title?: string;
  note?: string | null;
  quadrant?: Quadrant;
  priority?: number;
  dueDate?: string | null;
  startAt?: number | null;
  endAt?: number | null;
  location?: string | null;
  tagIds?: string[];
  sortOrder?: number;
  /** 改父级（拖动到别的任务下）。会连带重算子孙的 path/depth */
  parentId?: string | null;
}

export interface TaskStore {
  all(): Promise<Task[]>;
  byId(id: string): Promise<Task | null>;
  create(input: NewTask): Promise<Task>;
  patch(id: string, changes: TaskPatch): Promise<Task>;
  toggleComplete(id: string): Promise<Task>;
  /** 软删除整棵子树（含自己），返回受影响的 id；撤销窗口结束后由 purge 物理删除 */
  softDelete(id: string): Promise<string[]>;
  restore(ids: readonly string[]): Promise<void>;
  purge(ids: readonly string[]): Promise<void>;
  /** 应用启动时清理「软删已超过 10 秒」的残留（比如撤销窗口中途关掉标签页） */
  purgeExpired(graceMs: number): Promise<number>;
  /** 某个象限（无父级）里最大的 sortOrder，用于新建时排在末尾 */
  maxSortOrder(quadrant: Quadrant): Promise<number>;

  tags(): Promise<Tag[]>;
  ensureTag(name: string): Promise<Tag>;

  lists(): Promise<TaskList[]>;
  defaultList(): Promise<TaskList>;
}

/** 加了第 4 层时抛这个，UI 直接提示"最多 3 层" */
export class DepthLimitError extends Error {
  constructor(public readonly parentId: string) {
    super('最多 3 层子任务');
    this.name = 'DepthLimitError';
  }
}
