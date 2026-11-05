<div align="center">

# 隐语 · Ciphera Chat

**无需账号，以邀请密钥开启一段加密对话。**

浏览器端加密 · 独立聊天服务 · 本机记录恢复 · 桌面与移动布局

![Node.js](https://img.shields.io/badge/Node.js-22.16%2B-339933?logo=nodedotjs&logoColor=white)
![SQLite](https://img.shields.io/badge/Storage-SQLite%20WAL-003B57?logo=sqlite&logoColor=white)
![Encryption](https://img.shields.io/badge/Encryption-AES--256--GCM-2468C5)
![Tests](https://img.shields.io/badge/Tests-Node%20Test%20%2B%20Playwright-2EAD33?logo=playwright&logoColor=white)

[项目简介](#项目简介) · [快速开始](#快速开始) · [使用指南](#使用指南) · [HTTPS 部署](#https-部署) · [备份与恢复](#备份与恢复) · [安全边界](#安全边界)

</div>

---

## 项目简介

隐语是一款无账号、以完整邀请密钥作为入口的聊天室。房间名称、昵称和消息在浏览器中通过 Web Crypto 加密，然后发送给 Node.js 服务。服务端使用 SQLite 保存密文、成员关系及同步所需元数据。

项目提供可直接运行的原生前端、本地 HTTP 服务、单机 Docker Compose / Caddy 配置，以及服务端和浏览器测试。前端位于 `dist/`，可直接修改并由服务提供，**不需要额外构建命令**。

> **当前状态：** 已实现聊天与恢复相关流程；仓库没有独立安全审计报告。提供的容器配置尚未完成实际 Docker / 公网部署验收，不能将本地测试描述为公网生产验收。

## 功能亮点

### 房间与成员

- 无账号创建房间，创建者自动成为管理员。
- 使用完整邀请密钥加入，服务端验证邀请令牌。
- 每个浏览器身份最多同时加入 **3 个房间**，每个房间最多 **32 位成员**。
- 管理员可更换邀请、移除成员；管理员退出时，权限按加入顺序交接。
- 最后一名成员退出后删除服务器房间及关联记录。

### 消息与交互

- 浏览器 AES-256-GCM 加密，支持 Unicode、多行消息和安全文本显示。
- 分页增量同步，发送失败可沿用同一消息编号重试，避免重复。
- 支持发送后 30 秒 / 5 分钟 / 1 小时删除，或不自动删除。
- 按日期分组、消息复制、会话内搜索、未读提示及回到最新消息。
- 聊天室 / 消息搜索、深浅主题、桌面与移动端布局。

### 本机恢复

- 加密保存本机房间记录和未发送草稿，刷新后恢复。
- 创建 / 加入请求先保存恢复信息；回执丢失后可重试原请求。
- 本机记录损坏、密钥或身份凭证缺失时停止写入并保留原数据。
- 支持 Web Locks 的浏览器中，同一来源只允许一个活动写入窗口。
- 前台页面在断网时仍会清理已到期消息。

## 架构与数据流

```text
浏览器 A                         浏览器 B
身份凭证 / 房间密钥              身份凭证 / 房间密钥
        │ 浏览器加密                    │ 浏览器解密
        └──────── 同源 HTTPS ──────────┘
                         │
                  Node.js HTTP 服务
                  成员验证 / 同步 / 到期清理
                         │
                    SQLite WAL
             房间密文 / 成员关系 / 消息密文 / 回执
```

运行时仅依赖 Node.js 内置模块；`@playwright/test` 是开发测试依赖。同步采用 HTTP 轮询，页面约每 4 秒触发一次全房间同步，不使用 WebSocket。

## 快速开始

### 环境要求

- Node.js **22.16 或更新版本**；容器配置采用 Node.js 24。
- 支持 Web Crypto 的现代浏览器。
- 浏览器测试需要 npm、Chrome / Chromium；HTTPS 测试还需要支持相应参数的 OpenSSL。

### 本机启动

在包含 `package.json` 的项目目录执行：

```bash
npm start
```

打开 **<http://127.0.0.1:4173>**。

运行服务本身无需安装第三方包。需要运行测试时再执行 `npm ci`。按 `Ctrl+C` 停止服务。

### 模拟两个用户

1. 在普通浏览器窗口创建房间，填写昵称和房间名。
2. 复制完整邀请密钥，通过可信渠道交给另一位用户。
3. 在另一个浏览器或独立无痕会话中选择“使用密钥加入”。
4. 双向发送消息，并刷新页面检查记录恢复。

普通模式下同一浏览器配置的多个窗口通常共享身份；建议使用独立浏览器配置或无痕会话模拟不同用户。

## 使用指南

### 邀请与权限

完整邀请格式为 `CYPH-<房间密钥>.<邀请令牌>`。应复制界面提供的全部内容，不要只分享其中一段。

更换邀请会阻止旧邀请再次加入，已有成员继续使用原房间加密密钥。移除成员撤销其当前设备的服务访问权限，不能远程删除其已保存内容。

### 消息保留时间

保留时间按房间保存在**当前设备**，只影响该设备接下来发送的消息；从服务器确认发送成功的时间开始计时。修改设置不会改变历史消息。

过期消息会从服务器消息表和在线页面中清理，但用于幂等重试的消息回执仍保留至房间删除。到期删除不等于抹除对方截图、备份或自行保存的副本。

### 清空与退出

- **清空本机记录**：清理当前设备已加载的消息，服务器和其他设备的记录保留；草稿保留。
- **退出聊天室**：删除本机该房间密钥、草稿和记录，并请求退出服务器成员关系。
- **清除浏览器站点数据**：可能导致身份凭证与解密密钥永久丢失。服务器数据库备份无法恢复这些浏览器秘密。

旧版原型房间作为本机记录保留，需要创建新版房间才能跨设备聊天。

## 运行配置

支持以下环境变量：

- `HOST`：监听地址，默认 `127.0.0.1`。
- `PORT`：服务端口，默认 `4173`。
- `DATABASE_PATH`：SQLite 数据库完整路径，默认 `data/chat.sqlite`。

示例：

```bash
HOST=127.0.0.1 PORT=4180 DATABASE_PATH="$PWD/data/chat.sqlite" npm start
```

不要让多个聊天服务实例共享同一个数据库运行。当前方案面向单实例、单机部署。

## HTTPS 部署

远程设备使用 Web Crypto 需要安全上下文，跨设备部署应使用 HTTPS。静态网页托管只能提供页面，不能运行本项目的聊天后端。

### Docker Compose + Caddy

准备公网服务器、已指向服务器的域名、Docker Compose，并放通 80 / 443 端口。在项目目录执行：

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
CHAT_DOMAIN=chat.example.com
CHAT_DATABASE_FILE=chat.sqlite
```

将域名替换为实际域名，然后启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 chat https
```

Caddy 负责 HTTPS 反向代理及证书申请 / 续期。聊天数据库保存于 `chat-data` 卷，证书及配置分别保存于 `caddy-data` 和 `caddy-config` 卷。

升级：

```bash
docker compose up -d --build
```

停止并保留持久卷：

```bash
docker compose down
```

避免使用 `docker compose down -v` 清除需要保留的数据卷。实际部署后还需验证 DNS、证书信任、异地设备访问及备份恢复。

### 自行配置反向代理

```bash
HOST=0.0.0.0 PORT=4173 DATABASE_PATH="$PWD/data/chat.sqlite" npm start
```

将 HTTPS 反向代理指向后端，保留正确的 `Host` 请求头，并让页面与 API 同源。环境变量本身不会为后端启用 TLS。

## 备份与恢复

### 必须区分的两类数据

- **服务器数据库**：房间密文、成员关系、消息密文和回执。
- **浏览器存储**：设备身份凭证、房间解密密钥和本机加密记录。

数据库备份只涵盖第一类。保留服务器备份不能补救浏览器密钥丢失，也不能自动在另一浏览器恢复原身份。

### 本机在线备份

项目提供 SQLite 在线备份工具，可包含已经提交的 WAL 数据并执行完整性检查。目标父目录须已存在；目标文件存在时拒绝覆盖。

```bash
node scripts/database.mjs backup data/chat.sqlite /安全目录/chat-backup.sqlite
```

不要仅复制运行中的单个数据库文件。

### 恢复到新文件

```bash
node scripts/database.mjs restore /安全目录/chat-backup.sqlite data/restored.sqlite
```

停止原服务后，指定新文件启动：

```bash
DATABASE_PATH="$PWD/data/restored.sqlite" npm start
```

建议先在独立环境验证恢复结果，并保留原数据库。

### 容器备份与恢复

在线备份并取出：

```bash
docker compose exec chat node scripts/database.mjs backup /app/data/chat.sqlite /app/data/chat-backup.sqlite
docker compose cp chat:/app/data/chat-backup.sqlite ./chat-backup.sqlite
```

如备份已在共享卷中，可停止聊天服务并恢复到新的文件：

```bash
docker compose stop chat
docker compose run --rm --no-deps chat node scripts/database.mjs restore /app/data/chat-backup.sqlite /app/data/restored.sqlite
```

然后修改 `.env` 为 `CHAT_DATABASE_FILE=restored.sqlite`，执行 `docker compose up -d chat`。正式使用时应定期把备份复制到服务器之外。

## 容量与协议边界

- 每个浏览器身份最多 3 个房间，每个房间最多 32 位成员。
- 每房间最多 5,000 条未到期消息，密文容量上限约 64 MB。
- 每房间累计消息回执上限 50,000 条；达到后需要创建新房间。
- 单次 JSON 请求最多 32 KB，单个密文字段最多 16,000 个字符。
- 页面输入框最多 2,000 个字符。
- 消息 TTL 支持 `0`、`30`、`300`、`3600` 秒。
- 每个设备有请求频率限制；创建 / 加入使用额外频率限制。

达到容量或频率限制时，接口会返回明确错误；页面不会自动扩容数据库或创建新房间。

## API 概览

除健康检查外，API 使用 `Authorization: Bearer <设备凭证>` 验证浏览器身份。房间标识为 64 位十六进制字符串。

- `GET /api/health`：健康状态和协议版本。
- `GET /api/rooms`：当前设备房间。
- `POST /api/rooms`：创建房间，接受加密元数据与个人资料。
- `POST /api/rooms/:id/join`：验证邀请并加入。
- `GET /api/rooms/:id/sync?after=0`：增量消息、成员和当前角色，每次最多 100 条消息。
- `POST /api/rooms/:id/messages`：发送加密消息，按消息编号幂等重试。
- `POST /api/rooms/:id/invite`：管理员更新邀请。
- `DELETE /api/rooms/:id/members/:device`：管理员移除成员。
- `POST /api/rooms/:id/leave`：退出并处理管理员交接。

接口包含来源检查、安全响应头和请求体校验；它们不能代替完整的公网防滥用体系。

## 目录结构

```text
.
├── README.md
├── package.json / package-lock.json
├── server.mjs              # HTTP 服务、成员权限与 SQLite
├── dist/                   # 可直接运行的前端实现
│   ├── index.html
│   ├── app.js              # UI、同步、草稿和本机恢复
│   ├── crypto.js           # 房间密钥与 AES-GCM
│   ├── icons.js            # 本地 SVG 图标
│   └── styles.css
├── scripts/database.mjs    # 在线备份与恢复
├── test/                   # Node.js 测试及浏览器测试服务
├── e2e/                    # Playwright / HTTPS 测试
├── playwright.config.mjs
├── Dockerfile
├── compose.yaml
├── Caddyfile
├── .env.example
└── data/chat.sqlite        # 运行数据，不应提交
```

`.openai/hosting.json` 保留静态托管配置；单独发布 `dist/` 不会提供本项目所需聊天 API。

## 开发与测试

安装锁定依赖：

```bash
npm ci
```

服务端与加密测试：

```bash
npm test
```

浏览器与 HTTPS 回归：

```bash
npm run test:browser
```

Playwright 默认使用 macOS 的 Google Chrome。其他环境指定浏览器可执行文件：

```bash
CHROME_PATH=/path/to/chromium npm run test:browser
```

HTTPS 测试需要 OpenSSL，可通过 `OPENSSL_PATH` 指定其路径。测试使用本地自签名证书并跳过证书信任检查，不等于验证了公网证书链。

测试覆盖加密上下文、跨会话通信、邀请与权限、消息幂等、分页、到期清理、草稿恢复、存储失败、并发窗口保护、备份恢复、真实服务重启和响应式布局。浏览器测试启动独立 `4174` 端口服务；服务端测试使用内存或临时数据库。

## 安全边界

请在评估适用场景前理解以下实现限制：

- 使用共享房间密钥，尚未引入经过独立审计的群组协议、前向保密或成员变更后的消息密钥轮换。
- 服务器无需消息解密密钥，但可见连接信息、消息时间与大小、房间及成员关系，并会接收加入验证所需的邀请令牌。
- 当前没有独立发送者签名或端到端身份验证；持有共享密钥的成员可构造消息内容，昵称不能作为身份凭证。
- 更换邀请不等于更换加密密钥。撤销设备访问不能收回其已复制的密钥和消息，也不能阻止其通过其他身份及有效邀请再次加入。
- 本机加密密钥与加密后的本机记录位于同一浏览器存储中，不能防御有权限读取整个浏览器数据的人。
- 未经独立安全审计，不应将本项目描述为已满足高敏感通信要求。

## 常见问题

<details>
<summary><strong>远程打开页面后无法启动加密功能</strong></summary>

检查页面是否通过 HTTPS 访问，以及浏览器是否支持 Web Crypto。本机回环地址可以用于开发；普通远程 HTTP 地址通常不具备所需安全上下文。

</details>

<details>
<summary><strong>页面提示“此地址尚未接入聊天服务”</strong></summary>

确认正在运行 `server.mjs`，并让页面与 `/api/` 同源。静态文件服务器或只发布 `dist/` 无法代替聊天服务。

</details>

<details>
<summary><strong>为什么第二个窗口不能继续编辑？</strong></summary>

支持 Web Locks 时，页面保护同一浏览器来源下的单一写入窗口，避免覆盖草稿和加密快照。关闭原窗口后可在新窗口点击“重新打开”。

</details>

<details>
<summary><strong>恢复数据库后为何仍看不到消息？</strong></summary>

还需要原浏览器身份凭证和房间解密密钥。服务器备份无法恢复丢失的浏览器秘密。

</details>

## 贡献与许可证

提交变更时应说明场景、行为变化及验证方式。涉及协议、加密、本机存储或恢复流程的修改，应补充相应失败与重试场景的测试，并同步文档。

当前项目未提供 `LICENSE` 文件，不默认授予开源使用许可。请勿提交真实设备凭证、邀请密钥、`.env` 或 `data/` 运行数据。
