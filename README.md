# GRID

待办 + Outlook 日历 + 每日打卡，自托管，只做 Android 与 Web。

当前进度：**M0 地基**（认证、会话、登录锁定、迁移、部署链路）+ **Outlook 授权通道**（能连上、能验活、令牌加密落库）。日历同步与待办功能从 M1/M4 开始。

| 目录 | 说明 |
|---|---|
| `apps/web` | React 19 + Vite 8，桌面优先的 Web 端 |
| `packages/core` | 双端共享层：zod 模型、类型化 API 客户端 |
| `packages/server` | Fastify 5 + 双数据库驱动（SQLite / MySQL） |
| `deploy/` | 部署脚本、systemd unit、nginx 模板、备份 |
| `docs/` | PRD、架构、数据模型、UI 规范、里程碑、验收清单、实现决策、Outlook 接入指南 |

---

## 本地跑起来

```bash
# 1. 依赖（Node ≥ 22.12、pnpm 10）
pnpm install

# 2. 环境变量
cp .env.example .env

# 3. 建表
pnpm db:migrate

# 4. 创建账号（密码至少 12 位）
pnpm seed:user --email me@example.com --password 'grid-dev-pass-2026'

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

---

## M0 验收（对应 docs/06-验收清单.md A 组）

| # | 动作 | 期望 |
|---|---|---|
| 1 | `pnpm dev` | 5173 出登录页，3000 出 `{"ok":true,"db":"up"}` |
| 2 | 连输 5 次错误密码 | 前 4 次提示剩余次数，第 5 次提示已锁定，第 6 次返回 429 且带 `Retry-After: 600` |
| 3 | 登录后刷新 | 仍保持登录 |
| 4 | 点登出 | 回登录页，DevTools → Application 里 IndexedDB 无残留库、localStorage 为空 |
| 5 | `curl -s localhost:3000/api/healthz` | 含 `rssMB`（判断 2C2G 是否够用的第一个真实数据点） |

> M0 出口条件：记下 `rssMB`。若服务器 `free -m` 的 available < 900MB，按 docs/02 §9.4 走降级决策（复用现有 5.7 建库）。

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
