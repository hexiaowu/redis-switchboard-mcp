# redis-switchboard-mcp

[English](https://github.com/hexiaowu/redis-switchboard-mcp/blob/main/README.md) | [简体中文](https://github.com/hexiaowu/redis-switchboard-mcp/blob/main/README.zh-CN.md)

一个按请求切换 Redis 逻辑库的 MCP 服务器，不依赖 Redis 连接级的 `SELECT`。

```text
execute    → 在指定 db（如 db 2、db 4）执行一条 Redis 命令
read_page  → 分页读取 list / hash / set / zset / stream / string
scan_keys  → 基于游标的 SCAN，带数量、迭代和时间限制
key_info   → 类型 / TTL / 内存 / 编码 / 长度
```

`redis-switchboard-mcp` 面向 MCP 客户端的真实使用方式：大量相互独立、经常并发的工具调用，可能同时访问多个环境和多个 Redis 逻辑库。

工具的参数和说明由 MCP 客户端通过 `tools/list` 获取；本文档只覆盖配置、安全边界和运行行为。

---

## 为什么需要它

Redis 的 `SELECT` 改变的是**连接**的数据库，而不是某一条命令的数据库。一个共享连接、按需执行 `SELECT` 的 MCP 服务器很容易串库：并发调用、连接池复用、自动重连都可能让客户端停在错误的库上。

本项目把逻辑库当作每次调用的参数：每个工具都接受 `db`，每个 `(instance, db)` 使用自己那条已选定并校验过的连接，`SELECT`（以及 `MOVE`、`SWAPDB`、`COPY ... DB`）被拒绝。因此 db 2 和 db 4 的 `execute` 可以并发执行而不会互相污染，重连后命令也不会落到错误的库上。

---

## 功能

- **每次调用切换逻辑库**（`db: 0-255`）。
- **多 Redis 实例**：JSON 配置，通过 `instance` 参数选择。
- **显式权限模式**（`readonly` / `readwrite`，默认 `readonly`）；`readonly` 使用显式读命令白名单。
- **命令黑名单**：连接状态、管理、破坏性、阻塞类命令。
- **默认禁用 Lua**（`EVAL` / `EVALSHA` / `FCALL`）。
- **输出截断**：单容器 + 全局 item / 字符预算。
- **集合分页**：`read_page` 真正从 Redis 按页读取，避免 list/hash/set/stream 一次性全量拉取。
- **抓取守卫**：`execute` 对无界批量读取在命令执行前直接拒绝，并提示使用 `read_page`（覆盖范围见[输出和抓取边界](#输出和抓取边界)）。
- **有界 SCAN**：`limit`、迭代次数上限、墙钟时间预算。
- **集群检测**：Redis Cluster 只允许 db 0。
- **连接数上限**：每个实例 `maxConnections`，默认 32；每个 `(instance, db)` 维持一个小连接池（`poolSize`，默认 4），并支持**空闲连接回收**（`idleTimeoutMs`，默认 5 分钟）：连续 5 分钟没有任何命令的连接会被关闭并从缓存移除，不再占用的库不会白白持有连接。
- **凭证脱敏**：错误信息中移除 URL / password / AUTH 凭据。
- **不向 stdout 打日志**：stdout 专用于 MCP stdio 传输。

---

## 环境要求

- Node.js **20 或更新**
- Redis 6 或更新（`SCAN TYPE`）；`SORT_RO` 需要 Redis 7+
- 单机 Redis，或只使用 db 0 的 Redis Cluster

---

## 安装

### 从 npm 安装

```bash
npm install -g redis-switchboard-mcp
rsm --help
```

不全局安装也可以直接运行：

```bash
npx -y redis-switchboard-mcp
```

### 从源码运行

```bash
git clone https://github.com/hexiaowu/redis-switchboard-mcp.git
cd redis-switchboard-mcp
npm ci
npm run build
node dist/index.js
```

---

## MCP 客户端配置

### 单实例：环境变量

```json
{
  "mcpServers": {
    "redis": {
      "command": "npx",
      "args": ["-y", "redis-switchboard-mcp"],
      "env": {
        "REDIS_HOST": "127.0.0.1",
        "REDIS_PORT": "6379",
        "REDIS_PASSWORD": "your-password",
        "REDIS_MODE": "readonly"
      }
    }
  }
}
```

如果已全局安装，也可以写成 `"command": "rsm"`，不需要 `args`。

### 多实例：JSON 配置文件

```json
{
  "mcpServers": {
    "redis": {
      "command": "npx",
      "args": ["-y", "redis-switchboard-mcp"],
      "env": {
        "REDIS_MCP_CONFIG": "/Users/me/.config/redis-switchboard.config.json"
      }
    }
  }
}
```

> **注意：** 诊断日志全部写到 stderr；stdout 专用于 MCP stdio 传输。

### 验证配置

重启 MCP 客户端，然后让它执行一条命令：

```json
{ "command": "PING", "db": 0 }
```

配置正常时返回 `"reply": "PONG"`。用 `db` 参数指定其他逻辑库，省略时使用实例的 `db`。

---

<h2 align="center">⚙️ 配置</h2>

<h3 align="center">🔀 优先级</h3>

1. 命令行参数（`--config`、`--db` 等）
2. 环境变量
3. 默认值

`--config` 选择 JSON 配置文件。使用 JSON 配置时 `--name` / `--db` 会直接报错，请改 JSON 文件里的对应字段。

<h3 align="center">🎛️ 命令行参数</h3>

<p align="center"><strong>图例：</strong> ✅ 必填 · 🔶 条件必填 · ⚪ 可选</p>

| 选项 | 是否必填 | 说明 |
| :---: | :---: | :---: |
| `--config <path>` | 🔶 条件必填 | JSON 配置文件，描述一个或多个 Redis 实例 |
| `--name <name>` | ⚪ 可选 | 实例名（默认 `default`） |
| `--db <n>` | ⚪ 可选 | 默认逻辑库，0-255（默认 0） |
| `--mode <mode>` | ⚪ 可选 | 覆盖所有实例的权限模式：`readonly` 或 `readwrite` |
| `-h`, `--help` | ⚪ 可选 | 显示帮助 |
| `-v`, `--version` | ⚪ 可选 | 显示版本 |


<h3 align="center">🌱 环境变量（单实例）</h3>

<p align="center"><strong>图例：</strong> ✅ 必填 · 🔶 条件必填 · ⚪ 可选</p>

| 变量 | 是否必填 | 默认值 | 说明 |
| :---: | :---: | :---: | :---: |
| `REDIS_MCP_CONFIG` | 🔶 条件必填 | — | 多实例 JSON 配置文件路径 |
| `REDIS_NAME` | ⚪ 可选 | `default` | 单实例形式下的实例名 |
| `REDIS_HOST` | 🔶 条件必填 | — | Redis 主机（不使用 JSON 配置时必填） |
| `REDIS_PORT` | 🔶 条件必填 | — | Redis 端口（不使用 JSON 配置时必填） |
| `REDIS_USERNAME` | ⚪ 可选 | — | ACL 用户名 |
| `REDIS_PASSWORD` | 🔶 条件必填 | — | 密码（Redis 开启认证时必填） |
| `REDIS_DB` | ⚪ 可选 | `0` | 工具未传 `db` 时的默认逻辑库 |
| `REDIS_TLS` | ⚪ 可选 | `false` | 启用 TLS |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | ⚪ 可选 | `true` | 是否校验证书 |
| `REDIS_MODE` | ⚪ 可选 | `readonly` | 权限模式：`readonly` 或 `readwrite`（省略时默认 `readonly`） |
| `REDIS_ALLOWED_DBS` | ⚪ 可选 | — | 逗号分隔的库白名单，例如 `0,2,4`；必须包含 `REDIS_DB` |
| `REDIS_ALLOW_SCRIPTING` | ⚪ 可选 | `false` | 允许 `EVAL` / `EVALSHA` / `FCALL`（见安全说明） |
| `REDIS_MAX_CONNECTIONS` | ⚪ 可选 | `32` | 每个实例的连接缓存上限（1-256） |
| `REDIS_POOL_SIZE` | ⚪ 可选 | `4` | 每个 `(instance, db)` 的连接池大小（1-16） |
| `REDIS_IDLE_TIMEOUT_MS` | ⚪ 可选 | `300000` | `(instance, db)` 连接空闲超过该时长后自动关闭；`0` 表示禁用 |
| `REDIS_CONNECT_TIMEOUT_MS` | ⚪ 可选 | `5000` | TCP / 建连超时 |
| `REDIS_COMMAND_TIMEOUT_MS` | ⚪ 可选 | `15000` | 单条命令超时；`0` 表示禁用（仍有 60 秒 socket 超时） |
| `REDIS_MAX_RESULT_ITEMS` | ⚪ 可选 | `200` | 回复中单个数组 / 对象的 item 上限 |
| `REDIS_MAX_RESULT_CHARS` | ⚪ 可选 | `4000` | 回复中单个字符串的字符上限 |
| `REDIS_MAX_RESULT_DEPTH` | ⚪ 可选 | `4` | 最大嵌套深度 |
| `REDIS_MAX_FETCH_ITEMS` | ⚪ 可选 | `1000` | 单次 `execute` 批量读取允许抓取的最大 item 数 |
| `REDIS_MAX_FETCH_CHARS` | ⚪ 可选 | `1000000` | 单次 `execute` 字符串读取允许抓取的最大字节数 |
| `REDIS_SCAN_COUNT` | ⚪ 可选 | `500` | 默认 SCAN `COUNT` 提示值 |
| `REDIS_MAX_SCAN_ITERATIONS` | ⚪ 可选 | `200` | 单次 `scan_keys` 最大 SCAN 轮数 |
| `REDIS_SCAN_TIME_BUDGET_MS` | ⚪ 可选 | `10000` | 单次 `scan_keys` 墙钟时间预算 |

<p align="center"><strong>连接方式：</strong> 以下方式必须且只能选一种。</p>

| 方式 | 是否必填 | 用法 |
| :---: | :---: | :---: |
| JSON 配置文件 | 🔶 条件必填 | 设置 `REDIS_MCP_CONFIG`（或 `--config`）；host、port 和 mode 都写在文件里 |
| Host + Port | 🔶 条件必填 | 设置 `REDIS_HOST` 和 `REDIS_PORT`（需要时再加 `REDIS_MODE`） |

单实例环境变量形式下，`REDIS_HOST` 和 `REDIS_PORT` 都是必填，没有内置默认值。使用 JSON 配置文件时，则在每个实例里分别提供 `host` / `port`。

JSON 配置和 `REDIS_HOST`/`REDIS_PORT`/`REDIS_MODE` 是**互斥**的：同时设置会直接报配置错误并拒绝启动，并提示你在 JSON 里为每个实例定义 host/port/mode。使用 JSON 配置时，其他单实例环境变量也不会生效。

<h3 align="center">🗂️ 多实例 JSON</h3>

```json
{
  "defaultInstance": "cache-dev",
  "instances": [
    {
      "name": "cache-dev",
      "host": "127.0.0.1",
      "port": 6379,
      "db": 0,
      "mode": "readwrite",
      "allowedDbs": [0, 2, 4],
      "maxConnections": 32
    },
    {
      "name": "cache-prod",
      "host": "redis.prod.internal",
      "port": 6380,
      "username": "app",
      "password": "your-password",
      "tls": true,
      "db": 0,
      "mode": "readonly",
      "allowedDbs": [0],
      "commandTimeoutMs": 10000,
      "maxResultItems": 100,
      "maxResultChars": 2000,
      "maxFetchItems": 500,
      "maxFetchChars": 500000
    }
  ]
}
```

<p align="center"><strong>顶层字段</strong></p>

<p align="center"><strong>图例：</strong> ✅ 必填 · 🔶 条件必填 · ⚪ 可选</p>

| 字段 | 是否必填 | 默认值 | 说明 |
| :---: | :---: | :---: | :---: |
| `instances` | ✅ 必填 | — | 至少包含一个实例的数组 |
| `defaultInstance` | ⚪ 可选 | — | 工具调用未传 `instance` 时使用的实例 |

<p align="center"><strong>实例字段</strong></p>

<p align="center"><strong>图例：</strong> ✅ 必填 · 🔶 条件必填 · ⚪ 可选</p>

| 字段 | 是否必填 | 默认值 | 说明 |
| :---: | :---: | :---: | :---: |
| `name` | 🔶 条件必填 | `default` | 唯一实例名；配置多个实例时必须唯一 |
| `host` / `port` | ✅ 必填 | — | 连接地址 |
| `username` | ⚪ 可选 | — | ACL 用户名 |
| `password` | 🔶 条件必填 | — | 内联密码（Redis 需要认证时必填） |
| `usernameEnv` / `passwordEnv` | ⚪ 可选 | — | 从环境变量读取凭证 |
| `db` | ⚪ 可选 | `0` | 默认逻辑库 |
| `tls` | ⚪ 可选 | `false` | 启用 TLS |
| `tlsRejectUnauthorized` | ⚪ 可选 | `true` | 校验证书 |
| `mode` | ⚪ 可选 | `readonly` | 权限模式：`readonly` 或 `readwrite`（省略时默认 `readonly`） |
| `allowScripting` | ⚪ 可选 | `false` | 允许 `EVAL` / `EVALSHA` / `FCALL` |
| `allowedDbs` | ⚪ 可选 | — | 限制该实例可访问的逻辑库；必须包含 `db` |
| `maxConnections` | ⚪ 可选 | `32` | `(instance, db)` 连接缓存上限 |
| `poolSize` | ⚪ 可选 | `4` | 每个 `(instance, db)` 的连接池大小（1-16） |
| `idleTimeoutMs` | ⚪ 可选 | `300000` | `(instance, db)` 连接空闲超过该时长后自动关闭；`0` 表示禁用 |
| `connectTimeoutMs` | ⚪ 可选 | `5000` | 建连超时 |
| `commandTimeoutMs` | ⚪ 可选 | `15000` | 单条命令超时；`0` 表示禁用（仍有 60 秒 socket 超时） |
| `maxResultItems` | ⚪ 可选 | `200` | 单容器 item 上限 |
| `maxResultChars` | ⚪ 可选 | `4000` | 单字符串字符上限 |
| `maxResultDepth` | ⚪ 可选 | `4` | 嵌套深度上限 |
| `maxFetchItems` | ⚪ 可选 | `1000` | 单次 `execute` 批量读取最大 item 数 |
| `maxFetchChars` | ⚪ 可选 | `1000000` | 单次 `execute` 字符串读取最大字节数 |
| `scanCount` | ⚪ 可选 | `500` | 默认 SCAN `COUNT` 提示值 |
| `maxScanIterations` | ⚪ 可选 | `200` | SCAN 轮数上限 |
| `scanTimeBudgetMs` | ⚪ 可选 | `10000` | `scan_keys` 墙钟预算 |

含密码的配置文件建议设为 `chmod 600`。如果希望从环境变量注入凭证，仍可使用 `passwordEnv` / `usernameEnv`（`password` 和 `passwordEnv` 不能同时使用）。

未知字段（顶层或实例级）会导致启动失败，拼写错误会直接让进程退出。

---

## 安全模型

### 权限模式

权限模式是显式枚举，没有 `readOnly` 布尔值，默认 `readonly`：

| 模式 | 行为 |
| :---: | :---: |
| `readonly` | 只接受显式读命令白名单；`SET`、`HSET`、`DEL`、`RESTORE` 等写命令直接拒绝。即使 `allowScripting: true`，`EVAL`/`FCALL` 也会被拒绝。 |
| `readwrite` | 允许 `SET`、`HSET`、`DEL` 等写命令；下面的「永远拒绝的命令」仍然生效；`EVAL`/`FCALL` 仅在 `allowScripting: true` 时允许。 |

可按实例配置（`"mode"`）、单实例环境变量配置（`REDIS_MODE`），或用 `--mode` 一次性覆盖所有实例。建议同时配置只读 Redis ACL 作为第二层防护——`readonly` 模式是便利措施，不能替代服务端 ACL。

### 永远拒绝的命令

| 类别 | 示例 |
| --- | --- |
| 数据库 / 连接状态 | `SELECT`、`MOVE`、`SWAPDB`、`COPY ... DB`、`MULTI`、`EXEC`、`WATCH`、`RESET`、`HELLO`、`AUTH`、`QUIT` |
| Pub/sub 和流式模式 | `SUBSCRIBE`、`PSUBSCRIBE`、`MONITOR`、`SYNC`、`PSYNC` |
| 管理 | `CONFIG`、`DEBUG`、`CLIENT`、`ACL`、`MODULE`、`SHUTDOWN`、`SCRIPT`、`FUNCTION` |
| 拓扑 / 复制 | `CLUSTER`、`REPLICAOF`、`SLAVEOF`、`FAILOVER`、`MIGRATE`、`REPLCONF` |
| 破坏性 / 全局 | `FLUSHDB`、`FLUSHALL`、`SAVE`、`BGSAVE`、`BGREWRITEAOF` |
| 阻塞 | `BLPOP`、`BRPOP`、`BLMOVE`、`BZPOPMIN`、`WAIT`、`XREAD`、`XREADGROUP` 等 |
| 慢速 key 枚举 | `KEYS`、原始 `SCAN`——请用 `scan_keys` |

阻塞命令会长期占用该库的共享连接，导致后续请求卡住，因此直接拒绝。

### Lua 脚本

`EVAL`、`EVALSHA`、`EVAL_RO`、`EVALSHA_RO`、`FCALL`、`FCALL_RO` **默认禁用**。`allowScripting: true` / `REDIS_ALLOW_SCRIPTING=1` 可为受信任调用方开启。`readonly` 模式下读命令白名单优先级更高，即使开启 `allowScripting`，脚本命令仍会被拒绝。

> Lua 脚本可以调用被黑名单拒绝的命令，并且取决于 Redis 版本，可能访问其他逻辑库。开启 `allowScripting` 相当于同时放弃命令黑名单和 `allowedDbs` 边界：只对受信任调用方开启，并用 Redis ACL 兜底。

### 输出和抓取边界

回复会被截断：`maxResultItems` 限制单数组/对象，`maxResultChars` 限制单字符串/Buffer，`maxResultDepth` 限制嵌套深度，并在此基础上推导全局 item / 字符预算，避免嵌套回复膨胀到 GB 级。

`execute` 还会在命令执行前检查批量读取：

| 类别 | 受守卫的命令 |
| --- | --- |
| 字符串 | `GET`、`GETDEL`、`GETEX`、`GETSET`、`SET ... GET`、`GETRANGE`/`SUBSTR`、`MGET`（≤ 100 个 key）、`HMGET`（≤ 100 个字段） |
| Hash / set / zset | `HGET`、`HGETALL`、`HKEYS`、`HVALS`、`SMEMBERS`、`SINTER`/`SUNION`/`SDIFF`、`ZRANGE`/`ZREVRANGE`/`ZRANGEBY*`、`ZUNION`/`ZINTER`/`ZDIFF` |
| List | `LRANGE`、`LPOS ... COUNT 0` |
| Stream | 无 `COUNT` 的 `XRANGE`/`XREVRANGE`、`XINFO STREAM ... FULL`、`XPENDING`、`XAUTOCLAIM` |
| 聚合 | 无 `LIMIT` 的 `SORT`/`SORT_RO`、`LCS`、`GEOSEARCH`/`GEORADIUS*`、`DUMP` |
| 计数 | pop / 随机成员的 count、`HSCAN`/`SSCAN`/`ZSCAN` 的 `COUNT`、`MEMORY USAGE ... SAMPLES 0`、`COMMAND`、`SLOWLOG GET` |

无界形式返回 `COMMAND_REJECTED` 并提示使用 `read_page`；有界写法照常执行。上限由 `maxFetchItems`（默认 1000）和 `maxFetchChars`（默认 1,000,000）决定。

守卫是检查后执行——元数据在命令前读取，并发写入者仍可能在检查后把 key 变大——而且不是穷尽式的：`LINDEX` 和 `*STORE` 系列没有检查，只按 item 数检查的命令也不会限制单个字段/成员的字节大小。

守卫和 `read_page` 会执行 `STRLEN`、`HSTRLEN`、`LLEN`、`HLEN`、`SCARD`、`ZCARD`、`XLEN`、`TYPE`、`MEMORY USAGE`，Redis 用户必须被允许执行这些命令。守卫命令返回 `NOPERM` 会让 `execute` 调用失败；`read_page` 把失败的尺寸探测视为不可用，只跳过页大小缩减。由于字节检查使用整个 key 的 `MEMORY USAGE`，一个很大的 key 即使只读一小段也可能被拒绝——按页读取请用 `read_page`。

其他边界：

- `read_page`：服务端分页；`limit` 校验上限为 1000，并受 `maxFetchItems` 限制。翻页时把 `nextOffset`、`nextCursor` 或 `nextStart` 原样传回，直到 `complete` 为 `true`。
- `scan_keys`：`limit`、`maxScanIterations`、`scanTimeBudgetMs`
- `maxConnections`：限制每个实例的连接总数

### 凭证

- 使用 db > 0 时，Redis 用户必须被允许执行 `SELECT`；没有 `+select` 权限时 `db > 0` 会以 `DB_ERROR` 失败，而不是悄悄使用 db 0。
- 优先使用 `passwordEnv` / `REDIS_PASSWORD`，不要把密码写进 JSON。
- 含密码的配置文件建议 `chmod 600`。
- 错误信息会脱敏 `password=...`、引号/JSON 密码字段、回显的 `AUTH` 参数，以及错误中可能出现的连接 URL。
- TLS 默认校验证书；`tlsRejectUnauthorized: false` 仅用于自签名开发环境。
- TLS 仅支持 `tls` 和 `tlsRejectUnauthorized`；无法配置自定义 CA 或客户端证书（`ca`/`cert`/`key`）。

### 传输

本包是 **stdio** MCP 服务器，不开放 HTTP 端口，也不实现 MCP 认证。启动它的 MCP 客户端就是信任边界。

### 错误

调用失败时返回 `isError: true`，文本内容为 `{"error": "...", "code": "..."}`。错误码：`CONFIG_ERROR`、`COMMAND_REJECTED`、`COMMAND_SYNTAX`、`COMMAND_ERROR`、`INSTANCE_ERROR`、`DB_ERROR`、`CONNECTION_ERROR`、`INTERNAL_ERROR`。Redis 服务端错误（如 `NOPERM`、`WRONGTYPE`）映射为 `COMMAND_ERROR`。

---

## 行为和限制

- **不使用工具级 `SELECT`**：逻辑库按调用选择，见[为什么需要它](#为什么需要它)。
- **Redis Cluster**：只有 db 0。检测到 `cluster_enabled:1` 后拒绝 db > 0。连接的是单节点，其他 slot 的 key 可能返回 `MOVED`；它不是集群感知的分片客户端。
- **事务**：`MULTI` / `EXEC` / `WATCH` 是连接级状态，会跨请求泄漏，已禁用。
- **Pub/sub / `MONITOR`**：会改变连接模式，已禁用。
- **阻塞命令**：会占住共享连接，已禁用；请使用非阻塞写法（例如用 `XRANGE` 代替阻塞 `XREAD`）。
- **命令超时是客户端行为**：超时只会让调用失败，不会取消 Redis 端命令；超时的写命令可能已经执行。重试前请先确认状态。`commandTimeoutMs: 0` 会禁用命令超时，但 60 秒 socket 超时仍然生效，因此静默超过 60 秒的命令仍会失败。
- **断线时在途命令不会重发**：socket 断开时已发送的写命令可能报错，但 Redis 可能已经执行。重试前请先确认状态。
- **二进制值**：回复按 UTF-8 字符串解码。`DUMP` 等二进制负载可能无法往返；客户端产生 Buffer 时会返回有界 base64。
- **大读取**：守卫未覆盖的命令（见[输出和抓取边界](#输出和抓取边界)）仍可能在输出截断前被完整物化。大集合优先用 `key_info`、`read_page`、`scan_keys`，并配合 ACL / `commandTimeoutMs`。
- **SCAN 一致性**：SCAN 是增量扫描，不是快照；结果可能遗漏或重复。
- **连接缓存**：每个 `(instance, db)` 最多保留 `poolSize`（默认 4）条连接；每个实例的总量由 `maxConnections`（默认 32）硬性限制。空闲超过 `idleTimeoutMs`（默认 5 分钟）的连接会自动关闭；发生命令超时的连接会被立即丢弃并在下次请求时重建。如果长期使用很多逻辑库，请提高 `maxConnections`。
- **集群 + ACL**：如果 ACL 拒绝 `INFO cluster`，显式 `SELECT` 验证仍会以清晰错误拒绝集群上的 db > 0；db 0 不需要 `SELECT`。

---

## 常见问题

| 现象 | 排查方向 |
| --- | --- |
| `DB_ERROR` | `allowedDbs` 必须包含请求的 `db`；db > 0 还需要 Redis 用户有 `+select` 权限。 |
| `COMMAND_ERROR` 且信息含 `NOPERM` | ACL 必须放行抓取守卫使用的尺寸/类型命令（`STRLEN`、`HSTRLEN`、`LLEN`、`HLEN`、`SCARD`、`ZCARD`、`XLEN`、`TYPE`、`MEMORY USAGE`）。 |
| `CONFIG_ERROR` 且信息含 `references missing environment variable` | `passwordEnv` / `usernameEnv` 指向的变量必须出现在 MCP 客户端的 `env` 块里。 |
| `CONFIG_ERROR` 且信息含 `unknown field(s)` | JSON 字段拼写错误；未知字段会让进程拒绝启动。 |
| `MOVED` | key 属于其他集群节点；只支持单节点的 db 0。 |
| `CONNECTION_ERROR` | 主机/端口不可达、TLS 握手失败，或服务端关闭了连接。 |

---

## 许可证

MIT
