-- 0003_calendar.sql —— M3 重复规则：例外表
--
-- 为什么例外要单独建表（而不是 task.exdate 一个 JSON 列）：
--   1. 例外要单独参与增量同步。塞进 JSON 后，改一次例外就会抬高母体 rev，
--      两端看到的是"整行变了"，字段级合并无法判断改了哪个字段，于是次次报假冲突。
--   2. 例外要能被单独软删、单独恢复、单独记冲突账。
--   3. 唯一键 (series_id, original_start) 能把"同一系列的同一次只能有一个结论"
--      变成数据库约束，而不是靠应用层自觉。
--
-- rrule 本身存 task.rrule（0002 已建）。UNTIL / COUNT 编码在规则字符串里，
-- 不单独开列：重复规则是原子整体，拆列之后"改了频率"和"改了结束条件"会拼出
-- 一条谁也没写过的规则（见 docs/07 ADR-018）。

CREATE TABLE recur_exception (
  id               VARCHAR(26)  NOT NULL,
  user_id          VARCHAR(26)  NOT NULL,
  -- 母体 task.id；M4 之后也会指向 cal_event.id，届时加 series_kind
  series_id        VARCHAR(26)  NOT NULL,
  -- 该次在原系列中的原定开始（epoch 毫秒），例外的定位键
  original_start   BIGINT       NOT NULL,
  -- 'override' = 这次被改写；'deleted' = 这次被跳过（iCal 的 EXDATE）
  kind             VARCHAR(10)  NOT NULL,
  override_start   BIGINT       NULL,
  override_end     BIGINT       NULL,
  override_title   VARCHAR(512) NULL,
  -- 其余被改字段的稀疏覆盖（note / location 等），JSON 文本
  override_payload TEXT         NULL,
  created_at       BIGINT       NOT NULL,
  rev              INT          NOT NULL DEFAULT 1,
  change_seq       BIGINT       NOT NULL,
  updated_at       BIGINT       NOT NULL,
  deleted_at       BIGINT       NULL,
  hlc_wall         BIGINT       NOT NULL DEFAULT 0,
  hlc_counter      INT          NOT NULL DEFAULT 0,
  hlc_device       VARCHAR(26)  NULL,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ux_exception_series_start ON recur_exception (series_id, original_start);
CREATE INDEX ix_exception_user_seq ON recur_exception (user_id, change_seq);
CREATE INDEX ix_exception_series ON recur_exception (series_id);
