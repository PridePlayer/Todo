/**
 * 数据库抽象层。
 *
 * 只用两个驱动（sqlite / mysql），但**共用同一套可移植 SQL**：
 *  - 占位符统一用 `?`
 *  - 时间统一存 BIGINT（epoch 毫秒），不用 DATETIME/DATE，彻底回避时区与格式差异
 *  - 布尔存 0/1，枚举存 VARCHAR
 *  - 不使用 ON DUPLICATE KEY / ON CONFLICT / JSON 函数 / 窗口函数
 * 主键用 VARCHAR(26) 的业务 id（ULID），不用自增，避免多表 id 交叉污染增量游标。
 */
export type Row = Record<string, unknown>;

export type DriverKind = 'sqlite' | 'mysql';

/** 事务内的句柄：只有这两个方法，杜绝"忘了传 tx 又用了池"的隐式串行错误 */
export interface SqlExecutor {
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export interface Db extends SqlExecutor {
  readonly driver: DriverKind;
  /** 面向调用者的人话描述，用于启动日志与 healthz */
  readonly label: string;
  ping(): Promise<boolean>;
  close(): Promise<void>;

  /**
   * 事务。回调内**必须**用传进来的 `tx`，用 `db.query` 会跑在另一条连接上，
   * 那个更新不会被回滚，也不会和这里的行锁互斥。
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;

  /**
   * 取下一个全局变更水位。**只能在 transaction 内调用**，且必须与业务行写入同事务。
   * 实现是 `UPDATE change_seq SET seq = seq + 1` 后回读——两条语句，
   * 但都在同一事务里，行锁保证不会出现"跳号空洞"（详见 docs/03 §2.1）。
   */
  nextSeq(tx: SqlExecutor): Promise<number>;
}
