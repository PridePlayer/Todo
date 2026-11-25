-- 0008_device_token_scope.sql —— 设备令牌的权限范围（docs/11 §3）
--
-- 桌面小组件跑在无 UI 的 headless JS 里。那个上下文能不能解开 SecureStore 尚未验证，
-- 所以小组件用的令牌只能放在普通存储里（应用私有目录的明文 JSON）。
-- 保管强度既然降了一档，它被读走时能做的事就必须一并收窄：
-- scope='widget' 的令牌只被允许访问 /api/widget/summary，读不到 sync/export，
-- 也写不了任何东西。
--
-- 为什么是可空列而不是 NOT NULL DEFAULT 'full'：
--   1. 迁移只允许「加表 / 加可空列 / 加索引」，不给默认值能让这条约束不被破坏
--   2. NULL 天然表示「这条记录早于 scope 概念」，读的时候按 full 处理即可，
--      不需要 UPDATE 回填 —— 回填是不可逆的写操作，迁移里不做
--
-- 取值约定：NULL 或 'full' = 全权（App 主令牌），'widget' = 只读摘要

ALTER TABLE device_token ADD COLUMN scope VARCHAR(16) NULL;
