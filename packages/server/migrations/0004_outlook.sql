-- 0004_outlook.sql —— M4 Outlook 日历镜像
--
-- 与文档 03 §4.6~4.8 的差异（见 docs/07 ADR-020/021）：
--   1. 不新建 calendar_account：M0b 已经有一张 oauth_account 存加密令牌，
--      再开一张表意味着同一份 refresh token 有两处副本，迟早对不上。
--      这里只给它**加列**（delta 游标、最近同步时间）。
--   2. op_outbox 的主键用 VARCHAR(26) 的 ULID，不用 BIGINT AUTO_INCREMENT：
--      SQLite 与 MySQL 的自增语法不同，而迁移文件是两边共用一份的。
--   3. cal_event 不加"Rrule until/count"独立列，理由同 ADR-017：规则是原子整体。

ALTER TABLE oauth_account ADD COLUMN delta_link_window TEXT NULL;
ALTER TABLE oauth_account ADD COLUMN delta_link_full TEXT NULL;
ALTER TABLE oauth_account ADD COLUMN window_start BIGINT NULL;
ALTER TABLE oauth_account ADD COLUMN window_end BIGINT NULL;
ALTER TABLE oauth_account ADD COLUMN last_sync_at BIGINT NULL;

-- ── 日历源 ──────────────────────────────────────────────
-- can_edit 是 Graph 给的：节假日/生日日历为 0，这两类事件在 UI 上不能拖。
CREATE TABLE calendar_source (
  id             VARCHAR(26)  NOT NULL,
  user_id        VARCHAR(26)  NOT NULL,
  account_id     VARCHAR(26)  NOT NULL,
  ms_calendar_id VARCHAR(256) NOT NULL,
  name           VARCHAR(128) NOT NULL,
  is_default     INT          NOT NULL DEFAULT 0,
  is_visible     INT          NOT NULL DEFAULT 1,
  is_synced      INT          NOT NULL DEFAULT 1,
  can_edit       INT          NOT NULL DEFAULT 1,
  color_key      INT          NOT NULL DEFAULT 0,
  sort_order     BIGINT       NOT NULL DEFAULT 0,
  created_at     BIGINT       NOT NULL,
  rev            INT          NOT NULL DEFAULT 1,
  change_seq     BIGINT       NOT NULL,
  updated_at     BIGINT       NOT NULL,
  deleted_at     BIGINT       NULL,
  hlc_wall       BIGINT       NOT NULL DEFAULT 0,
  hlc_counter    INT          NOT NULL DEFAULT 0,
  hlc_device     VARCHAR(26)  NULL,
  PRIMARY KEY (id)
);

CREATE INDEX ix_source_user_seq ON calendar_source (user_id, change_seq);
CREATE UNIQUE INDEX ux_source_ms ON calendar_source (account_id, ms_calendar_id);

-- ── 事件镜像 ────────────────────────────────────────────
-- ms_ical_uid 才是稳定身份（事件被移动到别的日历时 ms_event_id 会变），
-- 但唯一键用 (source_id, ms_event_id)：同一个 iCalUId 在"母体"与"单次例外"上相同，
-- 按 uid 去重会把一次例外合并进母体。
CREATE TABLE cal_event (
  id                 VARCHAR(26)  NOT NULL,
  user_id            VARCHAR(26)  NOT NULL,
  source_id          VARCHAR(26)  NOT NULL,
  ms_event_id        VARCHAR(512) NOT NULL,
  ms_ical_uid        VARCHAR(512) NULL,
  ms_series_master_id VARCHAR(512) NULL,

  subject            VARCHAR(512) NOT NULL,
  body_preview       VARCHAR(1024) NULL,
  location           VARCHAR(256) NULL,
  start_at           BIGINT       NOT NULL,
  end_at             BIGINT       NOT NULL,
  is_all_day         INT          NOT NULL DEFAULT 0,
  tzid               VARCHAR(64)  NOT NULL DEFAULT 'Asia/Shanghai',
  is_organizer       INT          NOT NULL DEFAULT 1,
  response_status    VARCHAR(24)  NULL,

  is_recurring       INT          NOT NULL DEFAULT 0,
  rrule              VARCHAR(512) NULL,
  -- Graph 原始 recurrence 对象。回写时要原样带上，所以必须留着
  recurrence_raw     TEXT         NULL,

  web_link           VARCHAR(1024) NULL,
  ms_etag            VARCHAR(256) NULL,
  sync_state         VARCHAR(16)  NOT NULL DEFAULT 'synced',
  last_pushed_at     BIGINT       NULL,
  push_attempts      INT          NOT NULL DEFAULT 0,

  created_at         BIGINT       NOT NULL,
  rev                INT          NOT NULL DEFAULT 1,
  change_seq         BIGINT       NOT NULL,
  updated_at         BIGINT       NOT NULL,
  deleted_at         BIGINT       NULL,
  hlc_wall           BIGINT       NOT NULL DEFAULT 0,
  hlc_counter        INT          NOT NULL DEFAULT 0,
  hlc_device         VARCHAR(26)  NULL,

  PRIMARY KEY (id)
);

CREATE INDEX ix_event_user_seq ON cal_event (user_id, change_seq);
CREATE INDEX ix_event_time ON cal_event (user_id, start_at, end_at);
CREATE INDEX ix_event_source ON cal_event (source_id, start_at);
-- ms_event_id 在 MySQL 下超长（512 × utf8mb4），只索引前缀；
-- SQLite 不支持前缀长度，因此不建这个索引，改为在应用层按 (source_id, ms_event_id) 查
CREATE UNIQUE INDEX ux_event_source_ms ON cal_event (source_id, ms_event_id);

-- ── 回写队列 ────────────────────────────────────────────
-- op_id 来自客户端 opId：客户端重发同一个操作只会命中唯一键，不会再推一次 Graph。
CREATE TABLE op_outbox (
  id           VARCHAR(26)  NOT NULL,
  user_id      VARCHAR(26)  NOT NULL,
  op_id        VARCHAR(32)  NOT NULL,
  entity       VARCHAR(16)  NOT NULL,
  entity_id    VARCHAR(26)  NOT NULL,
  action       VARCHAR(24)  NOT NULL,
  payload      TEXT         NULL,
  base_etag    VARCHAR(256) NULL,
  status       VARCHAR(12)  NOT NULL DEFAULT 'pending',
  attempts     INT          NOT NULL DEFAULT 0,
  next_run_at  BIGINT       NOT NULL,
  last_error   TEXT         NULL,
  created_at   BIGINT       NOT NULL,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ux_outbox_op ON op_outbox (op_id);
CREATE INDEX ix_outbox_claim ON op_outbox (status, next_run_at);
