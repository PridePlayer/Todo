-- 0005_outlook_source_cursor.sql —— 每个日历源一条 delta 游标
--
-- 为什么游标放在 calendar_source 而不是 oauth_account：
-- 事件对象里没有 calendarId（$select=parentFolderId 会直接被 Graph 拒绝），
-- 所以只能按日历分别拉 delta（/me/calendars/{id}/events/delta），
-- 那游标天然是"每个日历一条"。放在账户上会变成多路游标挤一个字段，
-- 一交叉就互相覆盖，症状是"某些日历的事件永远刷不出来"。

ALTER TABLE calendar_source ADD COLUMN delta_link TEXT NULL;
