-- 0006_habits.sql —— M5 打卡：习惯 + 每日记录
--
-- 两张表而不是四张（check / count / duration 各一张）：
--   三种类型的差别只有"目标值怎么比"，拆表会让列表页、热力图、连续天数
--   都要写三份分支，而这三处恰恰是最容易算错的地方。
--
-- habit_log 的 id 不是随机 ULID，而是 hash(habit_id + log_date)（见 core/habit/log-id.ts）。
-- 这是 M5 唯一必须确定性的主键：
--   两台设备同一天各点一次计数型，若 id 不同就是两行，同步后数字会**相加**；
--   id 相同才会走字段级合并，由 GREATEST 规则取较大值。
-- 唯一索引 (habit_id, log_date) 是这层的数据库兜底——应用层算错时宁可让这次写入失败，
-- 也不能在库里留下"同一天两行"的脏数据。
--
-- days_of_week 存 JSON 文本（"[0,2,4]"），空数组表示每天：
-- 加"每月 1 号"这类规则时不用改表结构，代价是不能用 SQL 直接按星期筛选——
-- 而所有统计本来就在应用层算（docs/03 §4.5），这个代价是零。

CREATE TABLE habit (
  id           VARCHAR(26)  NOT NULL,
  user_id      VARCHAR(26)  NOT NULL,
  name         VARCHAR(128) NOT NULL,
  -- 'check' 打勾 / 'count' 计数 / 'duration' 时长
  type         VARCHAR(10)  NOT NULL,
  -- check 恒为 1；count 是次数；duration 是分钟
  target       INT          NOT NULL DEFAULT 1,
  -- 计数型的单位（杯/页/次）；duration 固定"分钟"，check 固定"次"
  unit         VARCHAR(8)   NULL,
  days_of_week VARCHAR(32)  NULL,
  color_key    INT          NOT NULL DEFAULT 0,
  sort_order   INT          NOT NULL DEFAULT 0,
  -- 归档：不再出现在今日列表，但历史与统计保留（与 task.archived_at 同义）
  archived_at  BIGINT       NULL,
  created_at   BIGINT       NOT NULL,
  updated_at   BIGINT       NOT NULL,
  deleted_at   BIGINT       NULL,
  rev          INT          NOT NULL DEFAULT 1,
  change_seq   BIGINT       NOT NULL,
  hlc_wall     BIGINT       NOT NULL DEFAULT 0,
  hlc_counter  INT          NOT NULL DEFAULT 0,
  hlc_device   VARCHAR(26)  NULL,
  PRIMARY KEY (id)
);

CREATE INDEX ix_habit_user_seq ON habit (user_id, change_seq);
CREATE INDEX ix_habit_user_order ON habit (user_id, sort_order);

CREATE TABLE habit_log (
  id          VARCHAR(26)  NOT NULL,
  user_id     VARCHAR(26)  NOT NULL,
  habit_id    VARCHAR(26)  NOT NULL,
  -- 本地日历日 'YYYY-MM-DD'。不用 epoch 毫秒：跨时区后同一天会变成两天，
  -- 一次出差就能把连续 30 天的记录打断
  log_date    VARCHAR(10)  NOT NULL,
  value       DOUBLE       NOT NULL DEFAULT 0,
  -- 补卡标记：热力图上要画斜纹，避免"事后补记 10 天"被读成"真的坚持了 10 天"
  backfilled  TINYINT      NOT NULL DEFAULT 0,
  note        VARCHAR(512) NULL,
  created_at  BIGINT       NOT NULL,
  updated_at  BIGINT       NOT NULL,
  deleted_at  BIGINT       NULL,
  rev         INT          NOT NULL DEFAULT 1,
  change_seq  BIGINT       NOT NULL,
  hlc_wall    BIGINT       NOT NULL DEFAULT 0,
  hlc_counter INT          NOT NULL DEFAULT 0,
  hlc_device  VARCHAR(26)  NULL,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ux_habit_log_day ON habit_log (habit_id, log_date);
CREATE INDEX ix_habit_log_user_seq ON habit_log (user_id, change_seq);
CREATE INDEX ix_habit_log_habit_date ON habit_log (habit_id, log_date, deleted_at);
