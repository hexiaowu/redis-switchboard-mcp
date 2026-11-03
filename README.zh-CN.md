# redis-switchboard-mcp

[English](README.md) | [简体中文](README.zh-CN.md)

一个按请求切换 Redis 逻辑库的 MCP 服务器，不依赖 Redis 连接级的 `SELECT`。

```text
execute    → 在指定 db 执行一条 Redis 命令
read_page  → 分页读取 list / hash / set / zset / stream / string
scan_keys  → 基于游标的 SCAN，带数量、迭代和时间限制
key_info   → 类型 / TTL / 内存 / 编码 / 长度
```

`redis-switchboard-mcp` 面向 MCP 客户端的真实使用方式：大量相互独立、经常并发的工具调用，可能同时访问多个环境和多个 Redis 逻辑库。

---

## 为什么需要它

Redis 的 `SELECT` 改变的是**连接**的数据库，而不是某一条命令的数据库。一个共享连接、按需执行 `SELECT` 的 MCP 服务器很容易串库：并发调用、连接池复用、自动重连都可能让客户端停在错误的库上。

本项目的工具调用本身不会执行 `SELECT`，也不信任 ioredis 在建立连接时的 `SELECT`——ioredis 会吞掉失败的 `SELECT`，仍然把连接报告为 ready。具体做法：

1. 每个工具都接受 `db` 参数。
2. 按 `(instance, db)` 缓存连接——每个逻辑库一条专用连接。
3. 连接始终先建立在 db 0；`db > 0` 时显式执行 `SELECT db` 并等待成功。任何工具命令执行前都必须先通过验证；`SELECT` 失败会断开并报错，而不是悄悄退回 db 0。
4. 断线重连后，会重新选择并验证目标库，验证通过前不接收命令。
5. 拒绝 `SELECT`、`MOVE`、`SWAPDB`、`COPY ... DB` 以及事务 / pub/sub 等连接状态命令。

对调用方来说，效果是无状态的：db 2 和 db 4 的 `execute` 可以并发执行，不会互相污染。

---

## 功能

- **每次调用切换逻辑库**（`db: 0-255`）。
- **多 Redis 实例**：JSON 配置，通过 `instance` 参数选择。
- **显式权限模式**（`readonly` / `readwrite`）；`readonly` 使用显式读命令白名单。
- **命令黑名单**：连接状态、管理、破坏性、阻塞类命令。
- **默认禁用 Lua**（`EVAL` / `EVALSHA` / `FCALL`）。
- **输出截断**：单容器 + 全局 item / 字符预算。
- **集合分页**：`read_page` 真正从 Redis 按页读取，避免 list/hash/set/stream 一次性全量拉取。
- **抓取守卫**：`execute` 对无界 `GET`/`MGET`/`HMGET`、`LRANGE 0 -1`、`HGETALL`/`HKEYS`/`HVALS`、`SMEMBERS`、`ZRANGE 0 -1`、`ZUNION`/`ZINTER`/`ZDIFF`、无 `COUNT` 的 `XRANGE`、超大 `HSCAN`/`SSCAN`/`ZSCAN` `COUNT`、无 `LIMIT` 的 `SORT_RO`、负数随机 count、过大的集合运算等，在命令执行前直接拒绝，并提示使用 `read_page`。
- **有界 SCAN**：`limit`、迭代次数上限、墙钟时间预算。
- **集群检测**：Redis Cluster 只允许 db 0。
- **连接数上限**：每个实例 `maxConnections`，默认 32。
- **凭证脱敏**：错误信息中移除 URL / password / AUTH 凭据。
- **不向 stdout 打日志**：stdout 专用于 MCP stdio 传输。

---

## 环境要求

- Node.js **20 或更新**
- Redis 6+ 推荐（`SORT_RO` 等需要 Redis 7+）
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

> `npm install -g` / `npx` 需要该包已经发布到 npm。发布前请先从源码构建。

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
      "args": [
        "-y",
        "redis-switchboard-mcp",
        "--config",
        "/Users/me/.config/redis-switchboard.config.json"
      ]
    }
  }
}
```

也可以用 `REDIS_MCP_CONFIG=/path/to/config.json` 指定同一个文件。

> **注意：** 本进程的诊断日志全部写到 stderr。不要向 stdout 输出任何内容——stdout 属于 MCP 传输。

> **在本仓库内运行：** 0.1.2+ 增加了 `redis-switchboard-mcp` 这个 bin 别名，
> 因此即使 MCP 客户端的 `cwd` 是仓库根目录，`npx -y redis-switchboard-mcp` 也能正常启动。
> 0.1.1 及更早版本需要在 npx 上加 `--prefix` 指向仓库外目录，或使用
> `node /absolute/path/to/redis-switchboard-mcp/dist/index.js`（先 `npm run build`）。

---

<h2 align="center">⚙️ 配置</h2>

<h3 align="center">🔀 优先级</h3>

1. 命令行参数（`--config`、`--db` 等）
2. 环境变量
3. 默认值

`--config` 选择 JSON 配置文件。`--name` / `--db` 只适用于单实例环境变量形式；多实例请直接编辑 JSON。

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
| `REDIS_HOST` | ✅ 必填 | — | Redis 主机 |
| `REDIS_PORT` | ✅ 必填 | — | Redis 端口 |
| `REDIS_USERNAME` | ⚪ 可选 | — | ACL 用户名 |
| `REDIS_PASSWORD` | 🔶 条件必填 | — | 密码（Redis 开启认证时必填） |
| `REDIS_DB` | ⚪ 可选 | `0` | 工具未传 `db` 时的默认逻辑库 |
| `REDIS_TLS` | ⚪ 可选 | `false` | 启用 TLS |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | ⚪ 可选 | `true` | 是否校验证书 |
| `REDIS_MODE` | ✅ 必填 | — | 权限模式：`readonly` 或 `readwrite`（未使用 `--mode` 时必填） |
| `REDIS_ALLOWED_DBS` | ⚪ 可选 | — | 逗号分隔的库白名单，例如 `0,2,4` |
| `REDIS_ALLOW_SCRIPTING` | ⚪ 可选 | `false` | 允许 `EVAL` / `EVALSHA` / `FCALL`（见安全说明） |
| `REDIS_MAX_CONNECTIONS` | ⚪ 可选 | `32` | 每个实例的连接缓存上限（1-256） |
| `REDIS_CONNECT_TIMEOUT_MS` | ⚪ 可选 | `5000` | TCP / 建连超时 |
| `REDIS_COMMAND_TIMEOUT_MS` | ⚪ 可选 | `15000` | 单条命令超时；`0` 表示禁用 |
| `REDIS_MAX_RESULT_ITEMS` | ⚪ 可选 | `200` | 回复中单个数组 / 对象的 item 上限 |
| `REDIS_MAX_RESULT_CHARS` | ⚪ 可选 | `4000` | 回复中单个字符串的字符上限 |
| `REDIS_MAX_RESULT_DEPTH` | ⚪ 可选 | `4` | 最大嵌套深度 |
| `REDIS_MAX_FETCH_ITEMS` | ⚪ 可选 | `1000` | 单次 `execute` 批量读取允许抓取的最大 item 数 |
| `REDIS_MAX_FETCH_CHARS` | ⚪ 可选 | `1000000` | 单次 `execute` 字符串读取允许抓取的最大字节数 |
| `REDIS_SCAN_COUNT` | ⚪ 可选 | `500` | 默认 SCAN `COUNT` 提示值 |
| `REDIS_MAX_SCAN_ITERATIONS` | ⚪ 可选 | `200` | 单次 `scan_keys` 最大 SCAN 轮数 |
| `REDIS_SCAN_TIME_BUDGET_MS` | ⚪ 可选 | `10000` | 单次 `scan_keys` 墙钟时间预算 |

<p align="center"><strong>连接方式：</strong> 以下方式任选其一。</p>

| 方式 | 是否必填 | 用法 |
| :---: | :---: | :---: |
| JSON 配置文件 | 🔶 条件必填 | 设置 `REDIS_MCP_CONFIG`（或 `--config`） |
| Host + Port | ✅ 必填 | 设置 `REDIS_HOST` 和 `REDIS_PORT` |

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
      "passwordEnv": "PROD_REDIS_PASSWORD",
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
| `$schema` | ⚪ 可选 | — | 会被忽略，仅用于编辑器 schema 提示 |

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
| `mode` | ✅ 必填 | — | 权限模式：`readonly` 或 `readwrite` |
| `allowScripting` | ⚪ 可选 | `false` | 允许 `EVAL` / `EVALSHA` / `FCALL` |
| `allowedDbs` | ⚪ 可选 | — | 限制该实例可访问的逻辑库 |
| `maxConnections` | ⚪ 可选 | `32` | `(instance, db)` 连接缓存上限 |
| `connectTimeoutMs` | ⚪ 可选 | `5000` | 建连超时 |
| `commandTimeoutMs` | ⚪ 可选 | `15000` | 单条命令超时；`0` 表示禁用 |
| `maxResultItems` | ⚪ 可选 | `200` | 单容器 item 上限 |
| `maxResultChars` | ⚪ 可选 | `4000` | 单字符串字符上限 |
| `maxResultDepth` | ⚪ 可选 | `4` | 嵌套深度上限 |
| `maxFetchItems` | ⚪ 可选 | `1000` | 单次 `execute` 批量读取最大 item 数 |
| `maxFetchChars` | ⚪ 可选 | `1000000` | 单次 `execute` 字符串读取最大字节数 |
| `scanCount` | ⚪ 可选 | `500` | 默认 SCAN `COUNT` 提示值 |
| `maxScanIterations` | ⚪ 可选 | `200` | SCAN 轮数上限 |
| `scanTimeBudgetMs` | ⚪ 可选 | `10000` | `scan_keys` 墙钟预算 |

建议使用 `passwordEnv` 而不是把密码写在文件里，并把配置文件权限设为 `chmod 600`。

---

## 工具

### `execute`

在指定逻辑库执行一条 Redis 命令。

```json
{ "command": "GET user:42", "db": 2 }
```

```json
{ "command": ["HGET", "user:42", "name"], "db": 4, "instance": "cache-prod" }
```

- `command` 可以是命令行（支持引号和反斜杠转义），也可以是参数数组。此外，如果命令行整体是一个
  JSON 序列化的参数数组（如 `["GET", "user:1"]`，某些 MCP 客户端会把数组参数字符串化后发送），
  也会被识别并按数组解析。
- `db` 每次调用独立选择逻辑库，默认使用实例的 `db`。
- 多实例且未配置默认实例时，必须传 `instance`。
- 实例 `mode` 为 `readonly` 时，写命令会被拒绝。
- `SELECT` 永远被拒绝——请用 `db` 参数。
- 批量读取会在执行前被守卫拦截：`GET`/`MGET`/`GETDEL`/`GETEX`/`GETSET`、`GETRANGE`、`LRANGE`、`HGETALL`/`HKEYS`/`HVALS`、`SMEMBERS`、`ZRANGE`/`ZRANGEBY*`/`ZUNION`/`ZINTER`/`ZDIFF`、`XRANGE`、`SORT`/`SORT_RO`、`LCS`、pop count、负数随机 count 和过大的集合运算，都会按 `maxFetchItems`/`maxFetchChars` 检查，无界形式返回 `COMMAND_REJECTED`。`HMGET` 按请求字段数限制。请改用 `read_page` 或有界写法。守卫是检查后执行，不是原子操作。

响应：

```json
{
  "instance": "cache-dev",
  "db": 2,
  "command": "GET",
  "argCount": 1,
  "elapsedMs": 1,
  "reply": "alice",
  "truncated": false
}
```

回复被截断时 `truncated` 为 `true`，`notes` 会说明哪些部分被缩短。

### `read_page`

从大集合中读取**一页有界数据**。这是 `HGETALL`、`SMEMBERS`、`LRANGE key 0 -1`、大字符串 `GET` 等操作的安全替代。

```json
{ "kind": "list", "key": "queue", "db": 2, "offset": 0, "limit": 100 }
```

| `kind` | Redis 命令 | 分页字段 |
| --- | --- | --- |
| `list` | `LRANGE key offset offset+limit-1` | `nextOffset` |
| `string` | `GETRANGE key offset offset+limit-1`（`limit` 表示字节数） | `nextOffset` |
| `hash` | `HSCAN key cursor COUNT limit [MATCH pattern]` | `nextCursor` |
| `set` | `SSCAN key cursor COUNT limit [MATCH pattern]` | `nextCursor` |
| `zset` | `ZRANGE key offset offset+limit-1 [WITHSCORES]` | `nextOffset` |
| `stream` | `XRANGE key start end COUNT limit` | `nextStart` |

响应（list）：

```json
{
  "instance": "cache-dev",
  "db": 2,
  "kind": "list",
  "key": "queue",
  "limit": 100,
  "items": ["job:1", "job:2"],
  "offset": 0,
  "returned": 2,
  "total": 12345,
  "nextOffset": 2,
  "complete": false,
  "outputBytes": 12
}
```

- `limit` 默认 100，最大 1000，同时受 `maxFetchItems` 和 `maxFetchChars` 推导出的输出预算限制。`outputBytes` 表示这一页的字节数。
- `limit` 限制的是元素/字段数量，不是单个元素的字节大小。单个巨大的 list 元素或 hash value 仍会被完整拉取；大字符串请用 `kind: "string"` + `GETRANGE`。
- 单个字符串会按 `maxResultChars` 截断；`truncatedItems` 表示被截断的 item 数；`notes` 报告 limit 缩减和 SCAN 批次溢出。
- `hash` / `set` 使用 SCAN，单次可能略多于 `COUNT`；为了保证不丢字段/成员，会整批返回，`outputBytes` 会报告实际大小（可能比页面预算多出一个 SCAN 批次）。
- `kind: "string"` 时 `offset` 和 `limit` 都是**字节**偏移（Redis 的 `GETRANGE`/`STRLEN` 按字节），分页会保持 UTF-8 字符边界：末尾不完整的字符会留给下一页，因此单页可能比 `limit` 多返回几个字节。
- stream 分页把 `nextStart` 原样作为下一次的 `start` 传入；它是排他游标（带 `(` 前缀）。如果一页刚好填满 `limit`，可能需要再请求一次空页才能确认 `complete`。
- hash / set 分页把 `nextCursor` 原样作为下一次的 `cursor` 传入。

### `scan_keys`

基于游标的 `SCAN`（永远不用 `KEYS`）。

```json
{ "pattern": "session:*", "db": 2, "limit": 200, "type": "hash" }
```

响应：

```json
{
  "instance": "cache-dev",
  "db": 2,
  "pattern": "session:*",
  "type": "hash",
  "cursor": "18432",
  "keys": ["session:1", "session:2"],
  "returned": 2,
  "limit": 200,
  "complete": false,
  "hasMore": true,
  "scannedEntries": 412,
  "iterations": 2,
  "elapsedMs": 3,
  "outputChars": 42,
  "duplicateKeys": 0,
  "truncatedKeyNames": 0,
  "notes": ["Result limit (200) reached; returned 240 key(s), rounded up to the SCAN batch boundary so no keys were dropped. Pass the returned cursor to continue."]
}
```

把 `cursor` 原样传回（优先用字符串形式）即可继续。说明：

- SCAN 不是快照；key 可能消失、出现，或在多次调用之间重复。
- **单次调用内**的重复 key 会被去除。
- 调用会在达到 `limit`（向上取整到当前 SCAN 批次）、游标为 `0`、达到 `maxScanIterations`、达到约 1MB key 名预算或时间预算时停止。当前批次的 key 一定会返回，因此可能略超 `limit` 或 key 名预算，但不会丢 key（`count` 被限制在 1000 以内，最大约 4MB）。
- `count` 最大 1000；key 名最长 4096 字符。
- `scannedEntries` 是 SCAN 批次返回的名字数量，不是精确扫描过的 key 数。

### `key_info`

只返回元数据，不返回值。

```json
{ "key": "user:42", "db": 2 }
```

响应：

```json
{
  "instance": "cache-dev",
  "db": 2,
  "key": "user:42",
  "exists": true,
  "type": "hash",
  "ttlMs": 3600000,
  "persistent": false,
  "memoryUsageBytes": 184,
  "encoding": "listpack",
  "length": 3,
  "lengthUnit": "items"
}
```

`lengthUnit`：字符串为 `bytes`，stream 为 `entries`，list/hash/set/zset 为 `items`。如果 `MEMORY USAGE` 或 `OBJECT ENCODING` 不可用（旧版 Redis、ACL 限制），对应字段为 `null`，并返回 `warnings`。

---

## 安全模型

### 权限模式

权限模式是显式枚举，没有 `readOnly` 布尔值，也没有隐式默认值：

| 模式 | 行为 |
| :---: | :---: |
| `readonly` | 只接受显式读命令白名单；`SET`、`HSET`、`DEL`、`RESTORE` 等写命令直接拒绝。即使 `allowScripting: true`，`EVAL`/`FCALL` 也会被拒绝。 |
| `readwrite` | 允许 `SET`、`HSET`、`DEL` 等写命令；下面的「永远拒绝的命令」仍然生效；`EVAL`/`FCALL` 仅在 `allowScripting: true` 时允许。 |

JSON 里写 `"mode": "readonly"` / `"mode": "readwrite"`；单实例环境变量用 `REDIS_MODE=readonly|readwrite`（未使用 `--mode` 时必填）；`--mode readonly|readwrite` 会覆盖所有实例。

`REDIS_MODE` 不能和 JSON 配置文件同时使用，请在每个实例里配置 `mode`（或用 `--mode` 覆盖所有实例）。

建议同时配置只读 Redis ACL 作为第二层防护——`readonly` 模式是便利措施，不能替代服务端 ACL。

**迁移说明：** `readOnly`（JSON）、`REDIS_READONLY` 和 `--readonly` 已移除，请改用 `mode`、`REDIS_MODE` 和 `--mode`。

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

`EVAL`、`EVALSHA`、`EVAL_RO`、`EVALSHA_RO`、`FCALL`、`FCALL_RO` **默认禁用**。`allowScripting: true` / `REDIS_ALLOW_SCRIPTING=1` 可为受信任调用方开启。

> Lua 脚本可以调用被黑名单拒绝的命令，并且取决于 Redis 版本，可能访问其他逻辑库。开启 `allowScripting` 相当于同时放弃命令黑名单和 `allowedDbs` 边界：只对受信任调用方开启，并用 Redis ACL 兜底。

### 输出和抓取边界

- 单数组 / 对象：`maxResultItems`
- 单字符串 / Buffer：`maxResultChars`
- 嵌套深度：`maxResultDepth`
- 整个回复：由上述值推导出的全局 item / 字符预算（约 1000+ 节点 / 100KB-1MB），防止嵌套回复膨胀到 GB 级
- `execute` 批量读取：命令执行前检查 `maxFetchItems`（默认 1000）和 `maxFetchChars`（默认 1,000,000）；无界 `GET`、`LRANGE`、`HGETALL`、`SMEMBERS`、`ZRANGE`、`XRANGE` 及过大的集合运算会被拒绝
- `MGET` 单次最多 100 个 key；`HMGET` 最多 `maxFetchItems` 个字段
- `read_page`：服务端分页，`limit` 最大 1000，且受 `maxFetchItems` 限制
- `scan_keys`：`limit`、`maxScanIterations`、`scanTimeBudgetMs`
- `maxConnections`：限制每个实例的连接总数

### 凭证

- 优先使用 `passwordEnv` / `REDIS_PASSWORD`，不要把密码写进 JSON。
- 含密码的配置文件建议 `chmod 600`。
- 错误信息会脱敏 `password=...`、引号/JSON 密码字段、回显的 `AUTH` 参数，以及错误中可能出现的连接 URL。
- TLS 默认校验证书；`tlsRejectUnauthorized: false` 仅用于自签名开发环境。

### 传输

本包是 **stdio** MCP 服务器，不开放 HTTP 端口，也不实现 MCP 认证。启动它的 MCP 客户端就是信任边界。

---

## 行为和限制

- **不使用工具级 `SELECT`**：逻辑库按调用选择，这是本项目的核心。
- **Redis Cluster**：只有 db 0。检测到 `cluster_enabled:1` 后拒绝 db > 0。连接的是单节点，其他 slot 的 key 可能返回 `MOVED`；它不是集群感知的分片客户端。
- **事务**：`MULTI` / `EXEC` / `WATCH` 是连接级状态，会跨请求泄漏，已禁用。
- **Pub/sub / `MONITOR`**：会改变连接模式，已禁用。
- **阻塞命令**：会占住共享连接，已禁用；请使用非阻塞写法（例如用 `XRANGE` 代替阻塞 `XREAD`）。
- **命令超时是客户端行为**：ioredis 会拒绝 promise，但不会取消 Redis 端命令；超时的写命令可能已经执行。重试前请先确认状态。`commandTimeoutMs: 0` 会禁用超时。
- **断线时在途命令不会重发**：`autoResendUnfulfilledCommands` 已关闭，避免非幂等写命令被执行两次；socket 断开时已发送的命令可能报错，但 Redis 可能已经执行。
- **二进制值**：回复按 UTF-8 字符串解码。`DUMP` 等二进制负载可能无法往返；客户端产生 Buffer 时会返回有界 base64。
- **守卫依赖元数据命令**：`execute` 的抓取守卫会执行 `STRLEN`、`LLEN`、`HLEN`、`SCARD`、`ZCARD`、`XLEN`、`TYPE`、`MEMORY USAGE`；`read_page` 会执行对应 `kind` 的长度命令。Redis 用户必须被允许执行这些命令；大小/类型命令返回 `NOPERM` 时会直接失败。
- **守卫开销和误报**：受守卫的 `execute` 会增加 1-3 次元数据往返（`MGET` 最多 100 次，集合/有序集合运算最多 64 次），`MEMORY USAGE` 本身是慢命令。字节检查使用整个 key 的 `MEMORY USAGE`，因此一个很大的 key 即使只读很小的 `LRANGE`/`ZRANGE`/`XRANGE` 范围也可能被拒绝；按页读取请用 `read_page`。守卫是检查后执行（TOCTOU），并发写入者可能在检查后把 key 变大。
- **抓取守卫覆盖范围**：已覆盖 `GET`/`MGET`/`GETDEL`/`GETEX`/`GETSET`、`GETRANGE`/`SUBSTR`、`HGET`、`DUMP`、`LRANGE`、`HGETALL`/`HKEYS`/`HVALS`、`SMEMBERS`、`SINTER`/`SUNION`/`SDIFF`、`ZRANGE`/`ZRANGEBY*`/`ZUNION`/`ZINTER`/`ZDIFF`、`XRANGE`/`XREVRANGE`、`HSCAN`/`SSCAN`/`ZSCAN` 的 `COUNT`、`SORT`/`SORT_RO`、`LCS`、`GEOSEARCH`/`GEORADIUS_RO`/`GEORADIUSBYMEMBER_RO`、随机成员和 pop count。它**不是穷尽式**的：`LINDEX`、`XPENDING`、`XINFO STREAM ... FULL`、`SET ... GET`、`LMPOP`/`ZMPOP` 未被守卫；只按 item 数检查的命令也不会限制单个字段/成员的字节大小。这些场景请配合受限 ACL、`commandTimeoutMs` 和尽可能小的命令使用。
- **大读取**：`execute` 会拒绝常见的无界批量读取形式，`read_page` 提供真正的服务端分页。对于守卫未覆盖的特殊命令，Redis/ioredis 仍可能在 `truncateReply` 之前完整物化回复。大集合优先用 `key_info`、`read_page`、`scan_keys`，并配合 ACL / `commandTimeoutMs`。
- **SCAN 一致性**：SCAN 是增量扫描，不是快照；结果可能遗漏或重复。
- **连接缓存**：每个 `(instance, db)` 一条连接，默认每个实例最多 32 条。达到上限后是硬性错误，不会驱逐空闲连接；如果长期使用很多逻辑库，请提高 `maxConnections` 或重启进程。
- **集群 + ACL**：如果 ACL 拒绝 `INFO cluster`，显式 `SELECT` 验证仍会以清晰错误拒绝集群上的 db > 0；db 0 不需要 `SELECT`。

---

## 开发

```bash
npm ci
npm run check      # 类型检查（src + tests）+ 测试
npm run build      # 编译到 dist/
npm run dev        # 用 tsx 直接运行 src
```

测试使用进程内的轻量 RESP 服务器（`test/fake-redis-server.ts`），**不需要本地 Redis**。覆盖：

- 命令 tokenize、黑名单、readonly 策略
- 回复截断和全局预算
- 环境变量 / JSON / CLI 配置
- 每库 client 隔离、并发首次建连、失败驱逐
- 连接数上限和错误映射
- `execute` / `read_page` / `scan_keys` / `key_info` 基于真实 ioredis 的端到端测试
- `GET` / `LRANGE` / `HGETALL` / `SMEMBERS` / `ZRANGE` / `XRANGE` / 随机成员 / 集合运算的抓取守卫
- MCP stdio 握手和 `tools/list`

项目结构：

```text
src/
  index.ts          CLI 入口和 stdio 传输
  lib.ts            无副作用的库入口
  server.ts         MCP server + 工具注册
  config.ts         环境变量 / JSON / CLI 配置
  commands.ts       tokenizer、黑名单、readonly 白名单
  truncate.ts       有界回复序列化
  redis-manager.ts  按 (instance, db) 缓存连接
  fetch-guard.ts    execute 批量读取的大小守卫
  tools/            execute、read_page、scan_keys、key_info
test/               单元、集成和 MCP 握手测试
```

---

## 发布

发布由 [`.github/workflows/publish.yml`](.github/workflows/publish.yml) 自动化：

- **发布 GitHub Release** 时触发，或通过 `workflow_dispatch` 手动指定已有 tag。
- 使用 **npm Trusted Publishing（GitHub OIDC）**，不需要长期 npm token。
- 检出对应 tag、安装依赖，然后执行 `npm publish --access public`。
- 上传前 `prepublishOnly` 会跑类型检查、测试类型检查、构建和完整测试。

### 一次性配置（Trusted Publishing）

1. 打开 npm 包设置 → **Trusted Publisher** → **GitHub Actions**。
2. 填写：
   - **Organization or user：** `hexiaowu`
   - **Repository：** `redis-switchboard-mcp`
   - **Workflow filename：** `publish.yml`（只写文件名，带 `.yml`，不要写 `.github/workflows/`）
   - **Environment name：** 留空
3. 点击 **Add trusted publisher** —— 这个按钮不叫 “Save”。
4. 配置后的第一次发布要在 **2 天**内成功，否则该 trusted publisher 配置会失效。

如果网页没有显示添加按钮，可以用 npm CLI（npm 11.15+）：

```bash
npm install -g npm@11
npm trust github redis-switchboard-mcp \
  --file publish.yml \
  --repo hexiaowu/redis-switchboard-mcp \
  --allow-publish \
  --yes
npm trust list redis-switchboard-mcp
```

如果 `npm trust` 提示必须先登录，先执行 `npm login --auth-type=web` 完成 2FA。

workflow 已经包含 `permissions: id-token: write`；npm 会自动生成 provenance，不需要额外传 `--provenance`。

如果你更想用 token，可以添加 `NPM_TOKEN` repository secret，并在 publish step 上设置
`env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }`。token 需要 Read and write 权限，并开启 **Bypass 2FA**。

### 发布流程

```bash
# 1. 升版本并更新 CHANGELOG.md
npm version patch --no-git-tag-version
# 编辑 CHANGELOG.md

# 2. 提交并打 tag
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v0.1.2"
git tag -a v0.1.2 -m "v0.1.2"
git push origin main --tags

# 3. 创建 GitHub Release（会触发发布 workflow）
gh release create v0.1.2 --title "v0.1.2" --notes "..."
```

workflow 成功后验证：

```bash
npm view redis-switchboard-mcp version dist-tags
```

不要把 npm token 或 `.npmrc` 提交到仓库。

## 许可证

MIT
