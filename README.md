# s2a-maid

通过 Telegram 群管理 Sub2API 账户并监控额度的轻量工具，使用 Bun、TypeScript、grammY 和 SQLite 构建。

主要功能：

- 上传现有 Sub2API 账户文件生成可复用模板；
- 将多种 ChatGPT/Codex 登录文件转换为 S2A 账户格式并创建账户；
- 通过 Telegram 内联按钮选择监控分组；
- 查看分组账户、逐账户用量和可用账户总额度；
- 定时检查低额度账户，并向指定 Telegram 群发送去重告警。

## 环境要求

- [Bun](https://bun.sh/)
- 可访问的 Sub2API 实例
- Sub2API 管理员 API Key 或管理员 JWT
- Telegram Bot

## 安装

```sh
bun install
cp config.example.toml config.toml
chmod 600 config.toml
```

编辑 `config.toml` 后启动：

```sh
bun run start
```

也可以指定其他配置文件：

```sh
bun run start -- --config /etc/s2a-maid.toml
```

开发与验证：

```sh
bun run dev
bun test
bun run check
```

## Docker

构建镜像时会先执行完整测试和 TypeScript 类型检查；任一步失败，镜像构建都会失败：

```sh
docker build -t s2a-maid:latest .
```

容器运行时需要把包含真实配置的目录挂载到 `/data`：

```sh
mkdir -p ./s2a-maid-data
cp config.example.toml ./s2a-maid-data/config.toml
# 编辑 ./s2a-maid-data/config.toml，填写 Telegram 和 Sub2API 配置
chmod 600 ./s2a-maid-data/config.toml

docker run -d \\
  --name s2a-maid \\
  --restart unless-stopped \\
  -v "$(pwd)/s2a-maid-data:/data" \\
  s2a-maid:latest
```

数据库默认保存在 `/data/s2a-maid.sqlite`。不要把真实 `config.toml`、数据库或账户导出文件复制进镜像；它们应通过挂载或密钥管理提供。

## 配置

完整示例见 [`config.example.toml`](./config.example.toml)。机器人默认读取当前目录的 `config.toml`，不读取 `.env`。

```toml
[telegram]
bot_token = ""
api_base_url = "https://api.telegram.org"
allowed_chat_ids = [-1001234567890]
alert_chat_id = -1001234567890

[telegram.api_headers]
# Authorization = "Bearer proxy-token"

[sub2api]
base_url = "http://127.0.0.1:8080"
admin_api_key = ""
jwt = ""

[monitor]
# 可留空，启动后在 Telegram 群中使用 /group 选择
group_id = ""
interval_seconds = 300
low_quota_percent = 10

[database]
path = "./s2a-maid.sqlite"
```

### Sub2API 认证

优先使用管理员 API Key：

```http
x-api-key: <admin-api-key>
```

如果没有 API Key，则使用管理员 JWT：

```http
Authorization: Bearer <jwt>
```

同时填写时优先使用 `admin_api_key`。

### Telegram Bot API 代理

`telegram.api_base_url` 支持兼容 Telegram Bot API 的代理服务。代理需要额外请求头时，写入 `[telegram.api_headers]`，这些请求头会用于 grammY API 请求和文件下载。

## Telegram 设置

1. 在 BotFather 创建 Bot；
2. 将 Bot 加入授权群并允许发送消息；
3. 在 BotFather 执行 `/setprivacy`，选择该 Bot，再选择 `Disable`。

关闭群组隐私模式后，Bot 才能稳定收到群内普通 JSON 文本和文件。机器人只处理 `telegram.allowed_chat_ids` 中的 `group` 或 `supergroup`，私聊、频道和其他群不会触发操作。

## 命令

| 命令 | 作用 |
|---|---|
| `/template` | 上传现有 S2A 账户文件，使用第一条账户生成模板 |
| `/acc` | 上传账户或登录文件，转换并创建 Sub2API 账户 |
| `/accounts` | 查看当前监控分组中的账户及可用状态 |
| `/usage` | 查看逐账户用量、可用账户总额度和分组限额 |
| `/monitor` | 查看监控分组、间隔、阈值和上次检查状态 |
| `/group`、`/groups` | 使用内联按钮选择监控分组 |
| `/cancel` | 取消当前等待的模板或账户上传 |
| `/help`、`/start` | 查看命令说明 |

## 账户模板

发送 `/template` 后上传单个 S2A 账户、账户数组或包含 `accounts` 的 Sub2API 导出文件。机器人使用第一条账户生成模板。

模板只保存可复用配置，不保存账户身份或动态状态：

- 保留平台、账户类型、并发数、优先级、倍率等静态配置；
- 仅保留 `credentials.model_mapping`，不保留 access token、refresh token 等账户凭据；
- 不保留账户名称、ID、分组关系或代理关联；
- 不保留 `codex_5h_*`、`codex_7d_*`、usage、quota、reset 等动态用量快照。

发送 `/acc` 时，转换后的账户覆盖模板同名字段，并自动加入 `/group` 当前选中的分组。

## 支持的输入格式

转换规则参考 [GPTSession2CPAandSub2API](https://github.com/gtxx3600/GPTSession2CPAandSub2API)。支持单个对象、对象数组和 `{ "accounts": [...] }` 容器，也支持混合格式批量输入。

- 原生 S2A/Sub2API account JSON；
- ChatGPT Web Session；
- 9router Codex OAuth JSON；
- Codex 原生 `auth.json`；
- AxonHub Codex `auth.json`；
- Codex-Manager 批量导入 JSON。

非原生格式会明确提示转换来源和目标，例如：

```text
Codex auth.json → S2A 账户格式
```

转换结果统一生成 `platform: "openai"`、`type: "oauth"` 的 S2A 账户，并按来源保留可用字段：

- `access_token`
- `refresh_token`
- `id_token`
- `session_token`
- `account_id`
- `chatgpt_account_id`
- `chatgpt_user_id`
- `workspace_id`
- `email`
- `plan_type`
- `expires_at`
- `expires_in`

有真实 `refresh_token` 时，不会把短期 access token 的过期时间当作账户过期时间。没有 refresh token 时，会根据 access token JWT 的 `exp` 设置 `expires_at`，并启用过期自动暂停。

每个 Telegram 更新使用稳定的 `Idempotency-Key`，降低 Telegram 重试造成重复创建的风险。

## 用量与监控

分组通过 `/group` 选择并保存到 SQLite，重启后继续使用。监控器启动后立即检查一次，之后按 `monitor.interval_seconds` 周期执行。

用量来自：

```http
GET /api/v1/admin/accounts/{id}/usage
```

当前支持常见的 5 小时、7 天、每日和每周窗口。显示时使用中文名称。

### 可用账户规则

总额度和自动告警只统计：

- `status == "active"`；
- `schedulable != false`。

错误、暂停、不可调度和查询失败的账户不会计入总额度，也不会触发低额度告警。

分组总额度按可用账户的同类窗口剩余百分比求和。例如两个账户分别剩余 80% 和 60%，合计为 140%，即约 1.4 个满额账户的剩余容量。Sub2API 分组配置中的每日、每周和每月 USD 限额会单独显示，不与账户窗口百分比混合。

低额度告警按“账户 + 用量窗口”去重。额度恢复到阈值以上后会清除去重记录，之后再次低于阈值时可重新告警。

## 本地存储

SQLite 保存：

- 清理后的账户模板；
- 每个群成员当前等待的输入模式；
- 当前监控分组；
- 已发送的低额度告警记录。

默认数据库为 `s2a-maid.sqlite`，启用 WAL。数据库和本地配置均已加入 `.gitignore`。

## 安全注意事项

- 不要提交 `config.toml`、SQLite 文件或账户导出文件；
- `config.toml` 建议保持 `600` 权限；
- 账户文件可能包含 access token、refresh token 和身份信息；
- Telegram 群历史可能保留上传的文件，建议仅在受控群中使用；
- 当前授权以 Telegram 群 ID 为边界，授权群内成员都可以使用管理命令；
- 批量创建不是事务操作，中途失败时可能已经创建部分账户。

## 项目结构

```text
src/index.ts              入口与生命周期
src/bot.ts                Telegram 命令和文件处理
src/accounts.ts           账户解析、模板提取与合并
src/session-converter.ts  多格式登录文件转换
src/sub2api.ts            Sub2API 管理 API 客户端
src/monitor.ts            定时额度监控
src/usage.ts              用量窗口提取与中文显示
src/database.ts           SQLite 存储
src/config.ts             TOML 配置加载与校验
src/telegram.ts           Telegram 请求头和文件下载
```
