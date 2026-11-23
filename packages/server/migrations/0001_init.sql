-- 0001_init.sql —— M0 地基：单用户、会话、登录锁定
--
-- 可移植约束（SQLite 与 MySQL 8 都能跑）：
--   * 不用 AUTO_INCREMENT / AUTOINCREMENT，主键是业务生成的 ULID（VARCHAR(26)）
--   * 时间一律 BIGINT（epoch 毫秒），不用 DATETIME，回避时区与精度差异
--   * 布尔用 0/1，不用 BOOLEAN
--   * 不用 JSON 列、不用窗口函数、不用 ON DUPLICATE KEY
--   * SQLite 的索引名是全库唯一，所以索引名统一带表名前缀

CREATE TABLE app_user (
  id            VARCHAR(26)  NOT NULL,
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    BIGINT       NOT NULL,
  updated_at    BIGINT       NOT NULL,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ux_app_user_email ON app_user (email);

-- 只存会话 id 的 SHA-256，库被拖走也无法直接冒用会话
CREATE TABLE session (
  id_hash      CHAR(64)     NOT NULL,
  user_id      VARCHAR(26)  NOT NULL,
  created_at   BIGINT       NOT NULL,
  last_seen_at BIGINT       NOT NULL,
  expires_at   BIGINT       NOT NULL,
  user_agent   VARCHAR(255) NULL,
  ip_hash      CHAR(64)     NULL,
  PRIMARY KEY (id_hash)
);

CREATE INDEX ix_session_user_id ON session (user_id);
CREATE INDEX ix_session_expires_at ON session (expires_at);

-- 登录锁定必须落库：放在内存里，重启一次就等于给爆破者清零
CREATE TABLE login_attempt (
  email           VARCHAR(255) NOT NULL,
  failed_count    INT          NOT NULL,
  first_failed_at BIGINT       NULL,
  locked_until    BIGINT       NULL,
  updated_at      BIGINT       NOT NULL,
  PRIMARY KEY (email)
);
