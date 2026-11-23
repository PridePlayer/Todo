# GRID

待办 + Outlook 日历 + 每日打卡，自托管，只做 Android 与 Web。

当前进度：**M0 地基**（认证、会话、登录锁定、迁移、部署链路）。功能从 M1 开始。

| 目录 | 说明 |
|---|---|
| `apps/web` | React 19 + Vite 8，桌面优先的 Web 端 |
| `packages/core` | 双端共享层：zod 模型、类型化 API 客户端 |
| `packages/server` | Fastify 5 + 双数据库驱动（SQLite / MySQL） |
| `deploy/` | 部署脚本、systemd unit、nginx 模板、备份 |
| `docs/` | PRD、架构、数据模型、UI 规范、里程碑、验收清单、实现决策记录 |

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

## 部署

完整步骤见 `docs/02-架构与技术方案.md` §11。服务器上只需：

```bash
cd /www/wwwroot/todo && bash deploy/deploy.sh
```

前提（一次性）：Node 24、pnpm、按 `deploy/env.example` 填 `.env`、MySQL 8.0 独立实例（端口 3307）建好 `grid` 库与 `grid_rw` 账号、nginx 站点按 `deploy/nginx.conf.example` 配好并对 `apps/web/dist`。

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
