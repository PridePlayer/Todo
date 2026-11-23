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

export interface Db {
  readonly driver: DriverKind;
  /** 面向调用者的人话描述，用于启动日志与 healthz */
  readonly label: string;
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
