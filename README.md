# GRID

待办 + Outlook 日历 + 每日打卡，自托管，只做 Android 与 Web。

一个人自己能用的程度：四象限与清单、重复规则（含截止日期）、自建日历 + Outlook 双向同步、每日打卡（连续天数 / 热力图 / 补卡）、甘特只读、跨端同步（CRDT 式字段级合并）、Android APK。

| 目录 | 说明 |
|---|---|
| `apps/web` | React 19 + Vite 8，桌面优先的 Web 端 |
| `apps/mobile` | Expo Router + React Native，Android |
| `packages/core` | 双端共享层：zod 模型、重复规则展开、类型化 API 客户端 |
| `packages/server` | Fastify 5 + 双数据库驱动（SQLite / MySQL） |
| `deploy/` | 部署、备份、恢复、探活脚本 + systemd unit + nginx 模板 |
| `tools/` | 调试与验收脚本（截图、浏览器验收、备份拉取） |
| `docs/` | PRD、架构、数据模型、UI 规范、里程碑、验收清单、实现决策、Outlook 接入、部署手册、桌面小组件、批量导入 |

---

## 本地跑起来

```bash
# 1. 依赖（Node ≥ 22.12、pnpm 10）
pnpm install

# 2. 环境变量
cp .env.example .env

# 3. 建表
pnpm db:migrate

# 4. 创建账号（密码至少 12 位，自己定一个）
pnpm seed:user --email me@example.com --password '换成一个足够长的口令'

# 5. 同时起前端(5173)与后端(3000)
pnpm dev
```

打开 http://localhost:5173 登录。

**默认不需要安装任何数据库。** `.env` 里的 `DB_URL=sqlite:./.data/grid.db` 走 Node 22 内置的 `node:sqlite`，
数据文件在 `.data/grid.db`。删掉 `.env` 与 `.data/` 就能从零重来。

### 想本地就和生产同构（可选）

```bash
# 需要 Docker
docker compose -f docker-compose.dev.yml up -d
# 然后把 .env 改成 mysql://grid_rw:devpass@127.0.0.1:3307/grid
```

也可以直接连服务器上的 MySQL 8.0 实例（它只绑 127.0.0.1，所以要走隧道）：

```bash
ssh -N -L 3307:127.0.0.1:3307 root@你的服务器
# .env: DB_URL=mysql://grid_rw:密码@127.0.0.1:3307/grid
```

---

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 前端 + 后端并行 |
| `pnpm dev:server` / `pnpm dev:web` | 只起一个 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm build` | 构建（web → dist，server → packages/server/dist） |
| `pnpm db:migrate` | 执行迁移（幂等，启动时也会自动跑） |
| `pnpm seed:user --email x --password y` | 创建唯一管理员 |
| `pnpm reset:password --email x` | 重置密码（不给 `--password` 则生成随机密码并打印一次） |
| `pnpm healthcheck` | 打一次 `/api/healthz` |
| `cd packages/server && ./node_modules/.bin/tsx ../../tools/widget-check.ts` | 小组件读接口验收（含四条权限反向断言） |
| `cd packages/server && ./node_modules/.bin/tsx ../../tools/import-check.ts` | CSV 导入解析验收（31 条） |
| `pnpm check:secrets` | 检查 `.env` 的真实值有没有漏进被追踪的文件（提交前跑一下） |
| `bash deploy/backup.sh` | 立刻做一次备份（服务器上跑） |
| `bash deploy/restore.sh` | 从备份恢复（不带参数会列出可选项） |
| `bash deploy/healthcheck.sh` | 探活 + 检查备份新鲜度 |

---

## 冒烟验收（改完之后先过这 5 条）

对应 `docs/06-验收清单.md` A 组。它不覆盖全部功能，只覆盖"地基还在不在"——
认证、会话、锁定、登出、探活。任何一次改动之后跑一遍，成本 2 分钟。

| # | 动作 | 期望 |
|---|---|---|
| 1 | `pnpm dev` | 5173 出登录页，3000 出 `{"ok":true,"db":"up"}` |
| 2 | 连输 5 次错误密码 | 前 4 次提示剩余次数，第 5 次提示已锁定，第 6 次返回 429 且带 `Retry-After: 600` |
| 3 | 登录后刷新 | 仍保持登录 |
| 4 | 点登出 | 回登录页，DevTools → Application 里 IndexedDB 无残留库、localStorage 为空 |
| 5 | `curl -s localhost:3000/api/healthz` | 含 `rssMB`（判断 2C2G 是否够用的第一个真实数据点） |

> 记下 `rssMB`。若服务器 `free -m` 的 available < 900MB，按 docs/02 §9.4 走降级决策（复用现有 5.7 建库）。

---

## 接入 Outlook（可选）

没配也能正常用；配了才会在首页出现「连接 Outlook」。

**完整步骤见 [`docs/08-Outlook接入指南.md`](docs/08-Outlook接入指南.md)**，最短路径：

1. <https://entra.microsoft.com> → 应用注册 → 新注册
   - 帐户类型：**任何组织目录中的帐户和个人 Microsoft 帐户**
   - 重定向 URI 平台 **Web**：`https://todo.stellamp.me/api/oauth/microsoft/callback`
2. 证书和密码 → 客户端密码 → 复制**「值」**列（不是「密码 ID」）
3. API 权限 → Microsoft Graph → 委托的权限：`User.Read`、`Calendars.ReadWrite`、`offline_access`
4. `.env` 填三项（缺一项会拒绝启动）：

```ini
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
TOKEN_ENC_KEY=$(openssl rand -base64 32)
```

5. 重启，登录后点「连接 Outlook」，回跳后点「验证令牌」

令牌以 AES-256-GCM 密文存 `oauth_account`，**明文与密文都不下发浏览器**。断开连接只删本地记录，不动你微软侧的日历。

---

## 部署

**完整步骤见 [`docs/09-部署手册.md`](docs/09-部署手册.md)**（按"照着敲"的顺序写，每步都有验证命令与失败对照表）。

首次上线做一次 0–8 节：升 Node ≥ 22.12 → 建 `grid` 库与 `grid_rw` 账号（**现有 MySQL 5.7 就够**）→ 拉代码填 `.env` → `db:migrate` + `seed:user` → 构建 → systemd → nginx 证书 → 连 Outlook。

之后每次更新只需：

```bash
cd /www/wwwroot/todo && bash deploy/deploy.sh
```

---

## 备份与恢复

三层，缺一层就有一种数据丢失方式挡不住：

| 风险 | 手段 | 谁来做 |
|---|---|---|
| 误删 / 改错 | 每 6 小时自动备份，本机留 14 天 + 每周日留 8 周 | `deploy/backup.sh` → `/www/backup/grid/` |
| 磁盘坏 / 重装系统 | 从服务器拉到你自己电脑 | `tools/pull-backup.ps1` |
| 库被 DROP / 账号被盗 | 一键导出全部数据为 JSON | 设置页 → 备份与导出（`GET /api/export`） |

### 1. 服务器自动备份

宝塔 → 计划任务 → Shell 脚本，周期「N 小时 = 6」：

```bash
bash /www/wwwroot/todo/deploy/backup.sh
```

脚本会按 `DB_URL` 自动选 `mysqldump` 或 `VACUUM INTO`。每份都验两样：`gzip -t` 能解开，以及 dump 末尾有 mysqldump 的 `Dump completed` 标记——只看文件大小是不够的，连接中途断掉时前半截照样会落盘，而恢复时才炸。

结果写进 `/www/backup/grid/status.txt`，`healthcheck.sh` 靠它判断"备份是不是已经不跑了"。备份挂掉是完全静默的，这是唯一能发现它的地方。

### 2. 异地：拉到自己的电脑

**本机备份和数据库在同一块盘上**，ECS 磁盘挂了、重装系统覆盖了 `/www`，两边一起没。这一层才扛得住服务器整个消失，而且不需要对象存储：

```powershell
# 一次性：配好免密登录
ssh-keygen -t ed25519
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@todo.stellamp.me "mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"

# 之后随时（也可挂任务计划程序每天 21:00 跑）
powershell -ExecutionPolicy Bypass -File "E:\11_WorkBuddyFiles\Todo\tools\pull-backup.ps1"
```

默认把最新 3 份拉到 `%USERPROFILE%\GridBackup`，本地留 40 份，校验下载到的确实是 gzip。**只读不删**，服务器上的东西一份都不动。

### 3. 恢复

```bash
bash /www/wwwroot/todo/deploy/restore.sh          # 不带参数会列出最近 10 份
bash /www/wwwroot/todo/deploy/restore.sh /www/backup/grid/daily/grid_2026-11-24_0200.sql.gz
```

顺序是刻意的：先把**当前**库另存到 `pre-restore/`（恢复错文件还能回去）→ 停服务 → 灌数据 → 起服务 → 探活。要输入 `yes` 才执行。

> 没验证过的备份不算备份。完整演练步骤（含行数核对）见 `docs/09` §10.6。

### 4. 告警（可选）

`.env` 加一行，备份失败或连续 14 小时没成功就会推到群里：

```ini
BACKUP_WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=xxx
```

`bash deploy/healthcheck.sh` 退出码：`0` 正常 / `1` 服务异常 / `2` 服务正常但备份异常。

---

## 调试脚本要的密码

`tools/shot.mjs`、`tools/browser-check.mjs`、`tools/calendar-check.ts` 会拿真实账号打登录接口，所以口令从环境变量读，**不写进仓库**：

```bash
GRID_TEST_PASSWORD=你的本地口令 node tools/shot.mjs calendar
# 邮箱默认 me@example.com，不同的话用 GRID_TEST_EMAIL
```

---

## Outlook 排障

| 现象 | 原因与处理 |
|---|---|
| 首页 Outlook 区块显示「未配置」 | `.env` 三项没配齐，或没重启。`curl -s 你的域名/api/oauth/microsoft` 应返回 `"configured":true` |
| 启动报「Microsoft OAuth 配置不完整」 | 只填了部分项。要么三项齐全，要么全留空 |
| 回调跳到 `?ms=error&reason=state_invalid` | state 过期/已用过/伪造。重新点「连接 Outlook」 |
| 回调跳到 `?ms=error&reason=code_rejected` | 授权码被拒。看 `journalctl -u grid` 里 `oauth code exchange failed` 的 AADSTS 码，对照 docs/08 §5 |
| 点「验证令牌」提示授权失效 | 微软侧撤回了授权。点「重新授权」 |
| 想撤销授权 | 断开连接只删本地；彻底撤销去 <https://account.live.com/consent/Manage> |

---

## 排障

| 现象 | 原因与处理 |
|---|---|
| 登录报 `页面状态已过期` | CSRF cookie 丢了。刷新页面重新取一次，或检查是否清过 cookie |
| 登录报 `请求来源不被允许` | 用的地址不是 `.env` 里 `APP_ORIGIN`。开发环境允许 localhost/127.0.0.1 任意端口，生产只认精确值 |
| 启动即退出并提示数据库连不上 | 看 `.env` 的 `DB_URL`；sqlite 路径是相对仓库根目录解析的 |
| 生产登录后立刻掉线 | `COOKIE_SECURE=true` 但没用 https 访问，`__Host-` Cookie 会被浏览器丢弃 |
| `node:sqlite` 有 ExperimentalWarning | Node 22 的正常提示，生产用 MySQL，不受影响 |

---

## 纪律（写代码前先看）

1. `packages/core` 里不允许出现 `window` / `document` / `localStorage` / `expo-*` / `node:*`。
2. SQL 只用可移植子集：`?` 占位符、时间存 BIGINT 毫秒、布尔存 0/1、不用 `ON DUPLICATE KEY` / 窗口函数 / JSON 函数。
3. 主键是 ULID（`VARCHAR(26)`），不用自增 —— 自增 id 做增量同步游标必然漏行。
4. 迁移只增不改：只加表 / 可空列 / 索引。
5. 任何删除操作都要有二次确认或撤销。
6. **这个仓库是公开的**：`.env` 永不入库；口令、密钥、真实邮箱一律从环境变量读，不写进代码、文档或调试脚本。提交前跑 `pnpm check:secrets` —— git 历史是追加的，一旦漏进去就删不干净了。
