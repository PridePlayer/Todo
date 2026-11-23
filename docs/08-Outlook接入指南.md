# 08 · Outlook（Microsoft Graph）接入指南

对应域名：**`todo.stellamp.me`**  
本文覆盖「从零到能读到你的微软账号」的全部步骤。日历事件的同步（delta 拉取、回写队列）属于 M4，不在本文范围内。

---

## 0. 当前代码已经做到哪一步

| 能力                   | 状态    | 对应接口                                   |
| -------------------- | ----- | -------------------------------------- |
| 跳转微软授权（PKCE + state） | ✅ 已实现 | `GET /api/oauth/microsoft/start`       |
| 回调换取令牌并加密落库          | ✅ 已实现 | `GET /api/oauth/microsoft/callback`    |
| 查询绑定状态（不下发令牌）        | ✅ 已实现 | `GET /api/oauth/microsoft`             |
| 自动刷新 access token    | ✅ 已实现 | `GET /api/oauth/microsoft/verify`      |
| 断开连接（删本地密文）          | ✅ 已实现 | `POST /api/oauth/microsoft/disconnect` |
| 读取日历事件 / 回写          | ⬜ M4  | —                                      |

**关键设计**：令牌只以密文存在于你的 MySQL 里（AES-256-GCM），连密文都不下发给浏览器。前端拿到的只有邮箱、状态、到期时间。

---

## 1. 前置核对

| 项          | 要求                                                         | 你现在的情况                                                      |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| 域名         | 已备案、能 443 访问                                               | `todo.stellamp.me`（与 `yalta.stellamp.me` 同套体系，A 记录指同一台 ECS） |
| 证书         | Let's Encrypt 或商业证书                                        | 宝塔申请即可，免费                                                   |
| 出站网络       | 服务器能访问 `login.microsoftonline.com` 与 `graph.microsoft.com` | 阿里云 ECS 默认可以，无需备案白名单                                        |
| 微软账号       | 个人号（@outlook.com/@hotmail.com）或工作号都行                       | 选 `common` 时两者通吃                                            |
| Azure 应用注册 | 免费，个人 Microsoft 账号即可注册                                     | 见第 2 节                                                      |

> ⚠️ 回调地址必须是 **HTTPS** 且公网可达。微软只对 `http://localhost` 放行明文，`todo.stellamp.me` 必须走 443。

---

## 2. Azure 门户注册应用（约 10 分钟）

### 2.1 创建应用

1. 打开 <https://entra.microsoft.com>，用你的 Microsoft 账号登录。
2. 左侧 **应用程序 → 应用注册 → 新注册**。
3. 按下表填：

| 字段       | 填什么                                                                                |
| -------- | ---------------------------------------------------------------------------------- |
| 名称       | `GRID Todo`（随意，只影响你自己看）                                                            |
| 受支持的帐户类型 | **任何组织目录中的帐户和个人 Microsoft 帐户**（即 `common`，对应 `AzureADandPersonalMicrosoftAccount`） |
| 重定向 URI  | 平台选 **Web**，填 `https://todo.stellamp.me/api/oauth/microsoft/callback`              |

1. 点 **注册**。
2. 在「概述」页复制 **应用程序(客户端) ID** —— 这是 `MS_CLIENT_ID`。

> 如果你也想在本机开发时跑通整个回调，在同一页 **添加平台 → Web** 再加一条  
> `http://localhost:5173/api/oauth/microsoft/callback`。  
> Entra 对 localhost 允许 http，但路径必须逐字符一致。

### 2.2 生成客户端密码

1. 左侧 **证书和密码 → 客户端密码 → 新客户端密码**。
2. 说明随便写，期限选 **24 个月**。
3. 点 **添加**，**立刻复制「值」列**。

> 这是 `MS_CLIENT_SECRET`。  
> 只显示一次。复制错了不用慌：删掉重建一条即可。  
> 注意别复制成「密码 ID」——那一列是 GUID，填进去会得到 `AADSTS7000215`。

### 2.3 添加 API 权限

1. 左侧 **API 权限 → 添加权限 → Microsoft Graph → 委托的权限**。
2. 勾选这三个，然后 **添加权限**：

| 权限                    | 用途                  | 少会怎样              |
| --------------------- | ------------------- | ----------------- |
| `User.Read`           | 读 `/me`，拿到账号 id 与邮箱 | 连接完成但显示不出账号       |
| `Calendars.ReadWrite` | 读写在你的日历上            | M4 同步时全部 403      |
| `offline_access`      | 拿 `refresh_token`   | 一小时后令牌过期，每次都要重新授权 |

1. **不要**点「代表组织授予管理员同意」，除非你用的是工作号且被要求。个人账号不需要。

### 2.4 确认两个开关（很容易漏）

在 **认证** 页往下翻：

| 开关                     | 应为                             |
| ---------------------- | ------------------------------ |
| 隐式授权 / 混合流（访问令牌、ID 令牌） | **都不勾**。我们走授权码 + PKCE，不需要它     |
| 允许公共客户端流               | **否**。我们是机密客户端，有 client_secret |



---

## 3. 服务器配置

### 3.1 写 .env

在服务器仓库根目录（`/www/wwwroot/todo.stellamp.me/...`）编辑 `.env`：

```bash
# 生成加密密钥，只做一次，之后不要换（换了旧令牌全部解不开）
openssl rand -base64 32
```

把四项填进去：

```ini
MS_CLIENT_ID=第 2.1 步复制的应用程序(客户端) ID
MS_CLIENT_SECRET=第 2.2 步复制的「值」
MS_TENANT=common
MS_REDIRECT_URI=https://todo.stellamp.me/api/oauth/microsoft/callback
MS_SCOPES=offline_access User.Read Calendars.ReadWrite
TOKEN_ENC_KEY=上面 openssl 输出的那串
```

**三条硬性规则**：

1. `MS_CLIENT_ID`、`MS_CLIENT_SECRET`、`TOKEN_ENC_KEY` **必须同时有值**。只填一部分，服务会**拒绝启动**并打印缺哪项——这是故意的，半配置比不配置更难排查。
2. `MS_REDIRECT_URI` 必须与 Azure 里那条**逐字符一致**：`https`、无尾斜杠、大小写一致。
3. `TOKEN_ENC_KEY` 一旦使用就不要再换。换了等于所有已存令牌作废，用户（你）必须重新授权一次。真要换，先断开连接再换。

### 3.2 重启

```bash
bash deploy/deploy.sh
# 或只重启服务
systemctl restart grid
```

启动日志里应该**没有** `[env] 未配置 Microsoft OAuth` 这一行。有它就是没读到配置。

### 3.3 校验配置被正确解析

```bash
curl -s https://todo.stellamp.me/api/oauth/microsoft
```

期望：

```json
{"configured":true,"scopes":["offline_access","User.Read","Calendars.ReadWrite"],"account":null}
```

`configured:false` = 服务端没读到凭据，回到 3.1。

---

## 4. 走一遍授权

1. 浏览器打开 `https://todo.stellamp.me`，登录。
2. 页面上滚到 **Outlook 日历** 区块，点 **连接 Outlook**。
3. 跳到微软登录页 → 选账号 → 同意权限。
4. 自动跳回 `https://todo.stellamp.me/?ms=connected`，面板变成：

```
Outlook 日历   [已连接]

账号   you@outlook.com
账号状态   正常        访问令牌   59 分钟后过期      上次验活   从未
[验证令牌] [重新授权] [断开]
```

1. 点 **验证令牌**。这一步会真的拿 access token 去请求一次 `GET /graph/v1.0/me`，成功后提示「令牌可用，已成功读取到账户信息」，并把「上次验活」更新成当前时间。

> 为什么要有这一步：数据库里有记录 ≠ 令牌能用。微软侧可能已经撤销授权、权限可能被管理员收回。只查表会把这类问题藏起来，直到 M4 同步时成批失败。

### 4.1 在数据库里确认没有明文

```sql
SELECT account_id, email, status,
       LEFT(access_token_enc, 24) AS enc_head,
       token_expires_at
FROM oauth_account;
```

`enc_head` 应以 `v1.` 开头（`v1.<iv>.<tag>.<密文>`）。若看到 `eyJ0eXAi...` 这类 `eyJ` 开头的串，说明存的是明文 JWT —— 立刻停下来检查 `TOKEN_ENC_KEY` 是否被代码真正用上。

---

## 5. 失败对照表

回调出错时，地址栏会是 `https://todo.stellamp.me/?ms=error&reason=<短码>`。**短码是我们自己的固定枚举，不会回显微软原文**（避免把 `error_description` 注入页面）。

| reason            | 含义                  | 处理                  |
| ----------------- | ------------------- | ------------------- |
| `not_configured`  | 服务端没读到 MS 凭据        | 检查 `.env` 三项是否齐全，重启 |
| `unauthenticated` | 点连接时会话已过期           | 重新登录                |
| `denied`          | 你在微软页点了取消           | 重新点连接，这次点「接受」       |
| `consent_failed`  | 微软返回了 consent/权限类错误 | 见下方 AADSTS 对照       |
| `state_invalid`   | state 不存在、已用过或伪造    | 正常安全行为；重新点连接        |
| `state_expired`   | 从点连接到回调超过 10 分钟     | 重来一次                |
| `session_changed` | 中途换了登录账号            | 重来一次                |
| `code_rejected`   | 授权码被拒（重复使用或伪造）      | 重来；若反复出现看 AADSTS    |
| `exchange_failed` | 服务器连不上微软令牌端点        | 检查服务器出站网络 / DNS     |
| `graph_failed`    | 拿到令牌但读不了 `/me`      | 权限没授予，回 2.3         |

微软原始错误只写进服务端日志（`journalctl -u grid -n 50` 或宝塔日志），搜 `oauth code exchange failed`。常见 AADSTS：

| AADSTS          | 真实原因                 | 改哪里                                           |
| --------------- | -------------------- | --------------------------------------------- |
| `AADSTS50011`   | 重定向 URI 与注册值不一致      | 逐字符比对 `MS_REDIRECT_URI` 与 Azure 那条            |
| `AADSTS7000215` | client secret 无效     | 十有八九填成了「密码 ID」，重建成「值」                         |
| `AADSTS700016`  | 在该目录找不到应用            | `MS_TENANT` 写了具体租户，但应用注册在另一个租户；个人号请用 `common` |
| `AADSTS65001`   | 需要管理员同意              | 工作号需管理员点同意；个人号检查是否漏了 scope                    |
| `AADSTS9002313` | 请求格式错误（code 已用过/被截断） | 重新发起授权，不要手动改回调 URL                            |
| `AADSTS50126`   | 账号密码错误               | 微软侧问题，与本服务无关                                  |

---

## 6. 安全边界（哪些是故意不做）

| 事项    | 做法                            | 原因                        |
| ----- | ----------------------------- | ------------------------- |
| 令牌存储  | AES-256-GCM 密文，密钥在 `.env`，不入库 | 库被拖走也拿不到可用令牌              |
| 令牌下发  | 绝不下发到浏览器，连密文也不发               | 前端是 XSS 的第一现场             |
| state | 只存 SHA-256、10 分钟过期、一次性消费      | 防 CSRF 与重放                |
| PKCE  | S256，verifier 64 字符随机         | 即使授权码被截也换不出令牌             |
| 授权范围  | 只申请日历读写 + 读基本资料               | 不读邮件、不读联系人、不读文件           |
| 错误回显  | 只回固定短码                        | 防 `error_description` 注入  |
| 断开连接  | 只删本地密文与记录                     | **不动你微软侧的任何日历数据**，避免误删    |
| 多账号   | 不支持，一个用户绑一个微软账号               | 单用户场景下多账号会让令牌矩阵与冲突检测复杂度翻倍 |

---

## 7. 这一片之后还缺什么

M4 才做的部分，提前说清楚，避免以为「连上了就能同步了」：

1. **增量拉取**：`GET /me/calendarView/delta`，把 `@odata.deltaLink` 存起来，下次带着它拉变更。
2. **回写队列**：本地改动 → 队列表 → worker 逐条 PATCH/POST，失败按 `Retry-After` 退避。
3. **重复事件**：Graph 不收 `EXDATE`，删单次只能按 occurrence id 逐条 DELETE；「本次及后续」要「截断原系列 + 新建系列」。P0 阶段重复事件只读。
4. **夜间对账**：每天凌晨做一次全窗口比对，把幽灵/丢失事件告警出来。

这几项都建立在本文这条 OAuth 通道之上，所以先把这一步跑通是划算的。
