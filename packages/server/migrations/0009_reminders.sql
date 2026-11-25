-- 0009_reminders.sql —— 本地提醒的两个时间字段（docs/11 §8）
--
-- 为什么是"提前多少分钟"而不是"提醒的绝对时间"：
--   已有 task.remind_at 是绝对时间戳，但用户在界面上选的是「提前 15 分钟」。
--   存绝对时间会有一个必然出错的场景：任务改到明天，提醒还停在今天。
--   而三端（App / Web / 同步）都要各自记得"改时间时重算 remind_at"，
--   漏一端的症状是"改了会议时间，提醒在昨天响了"。
--
--   存相对量就没有这个问题：锚点变了，提醒自动跟着走。
--   remind_at 保留不动（历史字段，不再写入），避免破坏已有数据。
--
-- habit.remind_minute 是"一天中的第几分钟"（0..1439），不是时间戳：
--   打卡提醒是"每天 21:00"，它与日期无关，存时刻比存时间戳准确得多。
--
-- 两列都可空：NULL = 不提醒。迁移只允许加可空列，不回填。

ALTER TABLE task ADD COLUMN remind_lead_minutes INT NULL;

ALTER TABLE habit ADD COLUMN remind_minute INT NULL;
