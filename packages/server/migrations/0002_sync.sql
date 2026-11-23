-- 0002_sync.sql —— M2 同步内核：全局水位 + 可同步业务表
--
-- 仍然遵守可移植约束（见 0001 注释）。
--
-- 关键设计：
--   1. change_seq 是**全局单行**序号，不是每表自增。多表共用一条水位，
--      客户端才能用一个 cursor 拉全部实体而不漏行。
--   2. 每张可同步表都有 rev（业务版本）与 change_seq（水位）。
--      rev 用于字段级合并的 baseRev 校验，change_seq 用于增量拉取，两者不能互相替代。
--   3. task.tag_ids 用 JSON 文本存数组（不是 task_tag 关联表）。
--      理由见 docs/07 ADR-017：关联表会让 pull 产生"半行"（有 id 没内容），
--      在 M2 这个阶段收益不抵复杂度，M3 做标签管理页时再迁移。

CREATE TABLE change_seq (
  id  INT    NOT NULL,
  seq  BIGINT NOT NULL,
  PRIMARY KEY (id)
);

INSERT INTO change_seq (id, seq) VALUES (1, 0);

-- ── 清单 ────────────────────────────────────────────────
CREATE TABLE list (
  id          VARCHAR(26)  NOT NULL,
  user_id     VARCHAR(26)  NOT NULL,
  name        VARCHAR(48)  NOT NULL,
  sort_order  BIGINT       NOT NULL DEFAULT 0,
  created_at  BIGINT       NOT NULL,
  rev         INT          NOT NULL DEFAULT 1,
  change_seq  BIGINT       NOT NULL,
  updated_at  BIGINT       NOT NULL,
  deleted_at  BIGINT       NULL,
  hlc_wall    BIGINT       NOT NULL DEFAULT 0,
  hlc_counter INT          NOT NULL DEFAULT 0,
  hlc_device  VARCHAR(26)  NULL,
  PRIMARY KEY (id)
);

CREATE INDEX ix_list_user_seq ON list (user_id, change_seq);

-- ── 标签 ────────────────────────────────────────────────
CREATE TABLE tag (
  id          VARCHAR(26)  NOT NULL,
  user_id     VARCHAR(26)  NOT NULL,
  name        VARCHAR(24)  NOT NULL,
  color_key   INT          NOT NULL DEFAULT 0,
  created_at  BIGINT       NOT NULL,
  rev         INT          NOT NULL DEFAULT 1,
  change_seq  BIGINT       NOT NULL,
  updated_at  BIGINT       NOT NULL,
  deleted_at  BIGINT       NULL,
  hlc_wall    BIGINT       NOT NULL DEFAULT 0,
  hlc_counter INT          NOT NULL DEFAULT 0,
  hlc_device  VARCHAR(26)  NULL,
  PRIMARY KEY (id)
);

CREATE INDEX ix_tag_user_seq ON tag (user_id, change_seq);

CREATE UNIQUE INDEX ux_tag_user_name ON tag (user_id, name);

-- ── 待办（核心表）───────────────────────────────────────
CREATE TABLE task (
  id           VARCHAR(26)  NOT NULL,
  user_id      VARCHAR(26)  NOT NULL,
  list_id      VARCHAR(26)  NOT NULL,
  parent_id    VARCHAR(26)  NULL,
  path         VARCHAR(160) NOT NULL,
  depth        INT          NOT NULL DEFAULT 0,

  title        VARCHAR(512) NOT NULL,
  note         TEXT         NULL,

  quadrant     INT          NOT NULL DEFAULT 1,
  important    INT          NOT NULL DEFAULT 0,
  urgent       INT          NOT NULL DEFAULT 0,
  priority     INT          NOT NULL DEFAULT 0,

  due_date     VARCHAR(10)  NULL,
  start_at     BIGINT       NULL,
  end_at       BIGINT       NULL,
  all_day      INT          NOT NULL DEFAULT 1,

  location     VARCHAR(256) NULL,
  tag_ids      TEXT         NULL,

  completed_at BIGINT       NULL,
  archived_at  BIGINT       NULL,
  sort_order   BIGINT       NOT NULL DEFAULT 0,

  rrule        VARCHAR(512) NULL,
  remind_at    BIGINT       NULL,

  created_at   BIGINT       NOT NULL,
  rev          INT          NOT NULL DEFAULT 1,
  change_seq   BIGINT       NOT NULL,
  updated_at   BIGINT       NOT NULL,
  deleted_at   BIGINT       NULL,

  hlc_wall     BIGINT       NOT NULL DEFAULT 0,
  hlc_counter  INT          NOT NULL DEFAULT 0,
  hlc_device   VARCHAR(26)  NULL,

  PRIMARY KEY (id)
);

CREATE INDEX ix_task_user_seq ON task (user_id, change_seq);
CREATE INDEX ix_task_user_quadrant ON task (user_id, quadrant, completed_at);
CREATE INDEX ix_task_parent ON task (parent_id);
CREATE INDEX ix_task_path ON task (path);

-- ── 幂等：同一个 opId 重放只生效一次 ────────────────────
CREATE TABLE op_applied (
  op_id      VARCHAR(32)  NOT NULL,
  user_id    VARCHAR(26)  NOT NULL,
  table_name VARCHAR(24)  NOT NULL,
  row_id     VARCHAR(26)  NOT NULL,
  status     VARCHAR(16)  NOT NULL,
  rev        INT          NULL,
  seq        BIGINT       NULL,
  applied_at BIGINT       NOT NULL,
  PRIMARY KEY (op_id)
);

CREATE INDEX ix_op_applied_user ON op_applied (user_id, applied_at);

-- ── 冲突留痕：败者值留在这里，UI 可"一键切回" ──────────
CREATE TABLE conflict_log (
  id           VARCHAR(26)  NOT NULL,
  user_id      VARCHAR(26)  NOT NULL,
  table_name   VARCHAR(24)  NOT NULL,
  row_id       VARCHAR(26)  NOT NULL,
  field        VARCHAR(32)  NOT NULL,
  local_value  TEXT         NULL,
  remote_value TEXT         NULL,
  winner       VARCHAR(8)   NOT NULL,
  resolved_at  BIGINT       NULL,
  created_at   BIGINT       NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX ix_conflict_user_row ON conflict_log (user_id, row_id);
