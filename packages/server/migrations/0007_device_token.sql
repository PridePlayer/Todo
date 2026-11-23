-- 0007_device_token.sql —— Android 设备令牌（docs/02 §5.3）
--
-- 为什么不复用 session 表：
--   1. 生命周期不同。会话 30 天滑动、绝对上限 90 天；设备令牌 180 天 + 临期静默轮换。
--      塞进一张表就要给"两类行"加判别列，而每个查询都得记得带上它——漏一次就是
--      "网页登录被当成设备"或反过来。
--   2. 吊销语义不同。会话吊销 = 登出；令牌吊销 = 「注销此设备」，之后 401 且要提示
--      "设备授权已过期"，而不是"请重新登录"（App 里没有登录页可回）。
--   3. 轮换需要 rotated_to 指针。会话没有这回事。
--
-- token_hash 存 SHA-256 十六进制（64 字符）：库被读走也拿不到可用令牌。
-- 令牌本身只在签发那一次出现在响应里，之后服务端再也无法重建它。

CREATE TABLE device_token (
  id           VARCHAR(26)  NOT NULL,
  user_id      VARCHAR(26)  NOT NULL,
  token_hash   CHAR(64)     NOT NULL,
  -- 设备名（"Pixel 8" / "红米 Note"），由签发方给，只为在设置页区分
  label        VARCHAR(64)  NOT NULL,
  created_at   BIGINT       NOT NULL,
  last_seen_at BIGINT       NOT NULL,
  -- 180 天；轮换时旧行被压到 now+24h（宽限期），新行是完整 180 天
  expires_at   BIGINT       NOT NULL,
  -- 轮换链：旧令牌指向新令牌，便于排查"这台设备换过几次令牌"
  rotated_to   VARCHAR(26)  NULL,
  revoked_at   BIGINT       NULL,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ux_device_token_hash ON device_token (token_hash);
CREATE INDEX ix_device_token_user ON device_token (user_id, created_at);
CREATE INDEX ix_device_token_expiry ON device_token (expires_at);
