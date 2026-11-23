-- 0002_oauth.sql —— Microsoft Graph 授权（OAuth 2.0 授权码 + PKCE）
--
-- 设计要点：
--   * 令牌一律存密文（AES-256-GCM，密钥来自 .env 的 TOKEN_ENC_KEY），库里没有明文 token
--   * oauth_state 存 state 的 SHA-256 而不是明文，回调时一次性消费并删除（防重放）
--   * 一个用户只绑一个微软账号（PRIMARY 由 user_id 唯一索引保证），多账号等 P2 再放开
--   * access_token 用 TEXT：Graph 的 token 常带 1~4KB 的 JWT，加密后 base64 还要再长 1/3

CREATE TABLE oauth_account (
  id                VARCHAR(26)   NOT NULL,
  user_id           VARCHAR(26)   NOT NULL,
  provider          VARCHAR(32)   NOT NULL,
  account_id        VARCHAR(191)  NOT NULL,
  email             VARCHAR(255)  NULL,
  display_name      VARCHAR(255)  NULL,
  tenant_id         VARCHAR(64)   NULL,
  scope             VARCHAR(1024) NULL,
  access_token_enc  TEXT          NOT NULL,
  refresh_token_enc TEXT          NULL,
  token_expires_at  BIGINT        NOT NULL,
  -- active | needs_reauth | revoked
  status            VARCHAR(16)   NOT NULL,
  last_error        VARCHAR(512)  NULL,
  last_verified_at  BIGINT        NULL,
  created_at        BIGINT        NOT NULL,
  updated_at        BIGINT        NOT NULL,
  PRIMARY KEY (id)
);

-- 单用户单账号：换绑时走 UPDATE 而不是插第二条
CREATE UNIQUE INDEX ux_oauth_account_user ON oauth_account (user_id);
CREATE UNIQUE INDEX ux_oauth_account_ext ON oauth_account (provider, account_id);

CREATE TABLE oauth_state (
  state_hash   CHAR(64)     NOT NULL,
  user_id      VARCHAR(26)  NOT NULL,
  code_verifier VARCHAR(128) NOT NULL,
  redirect_uri VARCHAR(512)  NOT NULL,
  created_at   BIGINT        NOT NULL,
  expires_at   BIGINT        NOT NULL,
  PRIMARY KEY (state_hash)
);

CREATE INDEX ix_oauth_state_expires_at ON oauth_state (expires_at);
