# redis-switchboard-mcp

[English](https://github.com/hexiaowu/redis-switchboard-mcp/blob/main/README.md) | [简体中文](https://github.com/hexiaowu/redis-switchboard-mcp/blob/main/README.zh-CN.md)

A Redis MCP server that switches **logical databases per request** instead of relying on Redis's connection-level `SELECT`.

```text
execute    → run a Redis command against db 2, db 4, ...
read_page  → bounded page of a list / hash / set / zset / stream / string
scan_keys  → cursor-based SCAN with limits
key_info   → type / TTL / memory / encoding / length
```

`redis-switchboard-mcp` is designed for the way MCP clients actually work: many independent tool calls, often concurrent, against several environments and several Redis logical databases.

Tool parameters and descriptions are delivered to the MCP client through `tools/list`; this README covers configuration, safety limits and runtime behavior.

---

## Why this exists

Redis's `SELECT` changes the database of a **connection**, not of a command. An MCP server that shares one connection and runs `SELECT` on demand will silently mix databases: a concurrent call, a pooled connection, or an automatic reconnect can leave the client on the wrong DB.

This server treats the database as a per-call argument instead. Every tool accepts `db`, each `(instance, db)` gets its own connection selected and verified for that database, and `SELECT` (plus `MOVE`, `SWAPDB`, `COPY ... DB`) is rejected. So `execute` in db 2 and db 4 can run concurrently without leaking state, and a reconnect never lands a command on the wrong database.

---

## Features

- **Per-call database selection** for every tool (`db: 0-255`).
- **Multiple Redis instances** from a JSON config, selected with the `instance` argument.
- **Explicit permission mode** (`readonly` / `readwrite`, default `readonly`); `readonly` uses an explicit read-command whitelist.
- **Command blocklist** for connection-level, administrative, destructive and blocking commands.
- **Lua scripting disabled by default** (`EVAL`/`EVALSHA`/`FCALL`).
- **Bounded output** with per-container and global item/character budgets.
- **Paged collection reads** via `read_page`, so large lists/hashes/sets/streams are never fetched in one shot.
- **Fetch guards** in `execute`: unbounded bulk reads are rejected before they materialize, with a pointer to `read_page` (see [Output and fetch bounds](#output-and-fetch-bounds)).
- **Bounded scans** with `limit`, SCAN iteration cap, and a wall-clock budget.
- **Cluster detection** — logical DBs other than 0 are rejected on a Redis Cluster.
- **Connection cache limit** per instance (`maxConnections`, default 32), with a small pool per `(instance, db)` (`poolSize`, default 4) and **idle connection recycling** (`idleTimeoutMs`, default 5 minutes): a connection that has not run any command for 5 minutes is closed and evicted, so databases you stop using stop holding server resources.
- **Credential redaction** in error messages.
- **No stdout logging** — stdout is reserved for the MCP stdio transport.

---

## Requirements

- Node.js **20 or newer**
- Redis 6 or newer (`SCAN TYPE`); `SORT_RO` requires Redis 7+
- A standalone Redis server, or a Redis Cluster used at **db 0 only**

---

## Installation

### From npm

```bash
npm install -g redis-switchboard-mcp
rsm --help
```

Or run it without a global install:

```bash
npx -y redis-switchboard-mcp
```

### From source

```bash
git clone https://github.com/hexiaowu/redis-switchboard-mcp.git
cd redis-switchboard-mcp
npm ci
npm run build
node dist/index.js
```

---

## MCP client configuration

### Single instance, environment variables

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

If the package is installed globally, `"command": "rsm"` with no `args` also works.

### Multiple instances from a JSON file

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

> **Note:** diagnostics are written to stderr; stdout is reserved for the MCP stdio transport.

### Verify the setup

Restart the MCP client, then ask it to run a command:

```json
{ "command": "PING", "db": 0 }
```

A working setup returns `"reply": "PONG"`. Use the `db` argument to target another logical database; it defaults to the instance `db`.

---

<h2 align="center">⚙️ Configuration</h2>

<h3 align="center">🔀 Precedence</h3>

1. Command-line flags (`--config`, `--db`, ...)
2. Environment variables
3. Defaults

`--config` selects a JSON config file. `--name`/`--db` are rejected when a JSON config is used; edit the JSON file for per-instance values.

<h3 align="center">🎛️ Command-line options</h3>

<p align="center"><strong>Legend:</strong> ✅ Required · 🔶 Conditionally required · ⚪ Optional</p>

| Option | Required | Description |
| :---: | :---: | :---: |
| `--config <path>` | 🔶 Conditional | JSON config file describing one or more Redis instances |
| `--name <name>` | ⚪ Optional | Instance name (default: `default`) |
| `--db <n>` | ⚪ Optional | Default logical database, 0-255 (default: 0) |
| `--mode <mode>` | ⚪ Optional | Override permission mode for all instances: `readonly` or `readwrite` |
| `-h`, `--help` | ⚪ Optional | Show help |
| `-v`, `--version` | ⚪ Optional | Show the version |


<h3 align="center">🌱 Environment variables (single instance)</h3>

<p align="center"><strong>Legend:</strong> ✅ Required · 🔶 Conditionally required · ⚪ Optional</p>

| Variable | Required | Default | Description |
| :---: | :---: | :---: | :---: |
| `REDIS_MCP_CONFIG` | 🔶 Conditional | — | Path to a multi-instance JSON config file |
| `REDIS_NAME` | ⚪ Optional | `default` | Instance name for the single-instance form |
| `REDIS_HOST` | 🔶 Conditional | — | Redis host (required when no JSON config is used) |
| `REDIS_PORT` | 🔶 Conditional | — | Redis port (required when no JSON config is used) |
| `REDIS_USERNAME` | ⚪ Optional | — | ACL username |
| `REDIS_PASSWORD` | 🔶 Conditional | — | Password (required when Redis requires authentication) |
| `REDIS_DB` | ⚪ Optional | `0` | Default logical database when `db` is omitted |
| `REDIS_TLS` | ⚪ Optional | `false` | Enable TLS |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | ⚪ Optional | `true` | Verify the server certificate |
| `REDIS_MODE` | ⚪ Optional | `readonly` | Permission mode: `readonly` or `readwrite` (defaults to `readonly` when omitted) |
| `REDIS_ALLOWED_DBS` | ⚪ Optional | — | Comma-separated allowlist, e.g. `0,2,4`; must include `REDIS_DB` |
| `REDIS_ALLOW_SCRIPTING` | ⚪ Optional | `false` | Allow `EVAL`/`EVALSHA`/`FCALL` (see security caveat) |
| `REDIS_MAX_CONNECTIONS` | ⚪ Optional | `32` | Per-instance connection cache limit (1-256) |
| `REDIS_POOL_SIZE` | ⚪ Optional | `4` | Connections pooled per `(instance, db)` (1-16) |
| `REDIS_IDLE_TIMEOUT_MS` | ⚪ Optional | `300000` | Close an idle `(instance, db)` connection after this long without a command; `0` disables |
| `REDIS_CONNECT_TIMEOUT_MS` | ⚪ Optional | `5000` | TCP/connect timeout |
| `REDIS_COMMAND_TIMEOUT_MS` | ⚪ Optional | `15000` | Per-command timeout; `0` disables it (a 60 s socket timeout still applies) |
| `REDIS_MAX_RESULT_ITEMS` | ⚪ Optional | `200` | Per-array/object item cap in replies |
| `REDIS_MAX_RESULT_CHARS` | ⚪ Optional | `4000` | Per-string cap in replies |
| `REDIS_MAX_RESULT_DEPTH` | ⚪ Optional | `4` | Maximum nested container depth |
| `REDIS_MAX_FETCH_ITEMS` | ⚪ Optional | `1000` | Max items one `execute` bulk read may fetch |
| `REDIS_MAX_FETCH_CHARS` | ⚪ Optional | `1000000` | Max bytes one `execute` string read may fetch |
| `REDIS_SCAN_COUNT` | ⚪ Optional | `500` | Default SCAN `COUNT` hint |
| `REDIS_MAX_SCAN_ITERATIONS` | ⚪ Optional | `200` | Maximum SCAN round trips per call |
| `REDIS_SCAN_TIME_BUDGET_MS` | ⚪ Optional | `10000` | Wall-clock budget per `scan_keys` call |

<p align="center"><strong>Connection methods:</strong> exactly one of the following.</p>

| Method | Required | How |
| :---: | :---: | :---: |
| JSON config | 🔶 Conditional | Set `REDIS_MCP_CONFIG` (or `--config`); host, port and mode come from the file |
| Host + port | 🔶 Conditional | Set `REDIS_HOST` and `REDIS_PORT` (and `REDIS_MODE` if needed) |

For the single-instance environment form, `REDIS_HOST` and `REDIS_PORT` are required — there is no built-in host or port default. The JSON config alternative defines `host`/`port` for each instance.

JSON config and `REDIS_HOST`/`REDIS_PORT`/`REDIS_MODE` are **mutually exclusive**: setting them with a JSON config is a configuration error (the process refuses to start and tells you to define host/port/mode per instance in the JSON file). Other single-instance environment variables are not applied when a JSON config is used.

<h3 align="center">🗂️ Multi-instance JSON</h3>

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

<p align="center"><strong>Top-level fields</strong></p>

<p align="center"><strong>Legend:</strong> ✅ Required · 🔶 Conditionally required · ⚪ Optional</p>

| Field | Required | Default | Description |
| :---: | :---: | :---: | :---: |
| `instances` | ✅ Required | — | Array with at least one instance |
| `defaultInstance` | ⚪ Optional | — | Instance used when a tool call omits `instance` |

<p align="center"><strong>Instance fields</strong></p>

<p align="center"><strong>Legend:</strong> ✅ Required · 🔶 Conditionally required · ⚪ Optional</p>

| Field | Required | Default | Description |
| :---: | :---: | :---: | :---: |
| `name` | 🔶 Conditional | `default` | Unique instance name; must be unique when several instances are configured |
| `host` / `port` | ✅ Required | — | Connection endpoint |
| `username` | ⚪ Optional | — | ACL username |
| `password` | 🔶 Conditional | — | Inline password (required when Redis requires authentication) |
| `usernameEnv` / `passwordEnv` | ⚪ Optional | — | Read credentials from an environment variable |
| `db` | ⚪ Optional | `0` | Default logical database |
| `tls` | ⚪ Optional | `false` | Enable TLS |
| `tlsRejectUnauthorized` | ⚪ Optional | `true` | Verify the server certificate |
| `mode` | ⚪ Optional | `readonly` | Permission mode: `readonly` or `readwrite` (defaults to `readonly` when omitted) |
| `allowScripting` | ⚪ Optional | `false` | Allow `EVAL`/`EVALSHA`/`FCALL` |
| `allowedDbs` | ⚪ Optional | — | Restrict which logical DBs this instance may access; must include `db` |
| `maxConnections` | ⚪ Optional | `32` | Cache limit for `(instance, db)` connections |
| `poolSize` | ⚪ Optional | `4` | Connections pooled per `(instance, db)` (1-16) |
| `idleTimeoutMs` | ⚪ Optional | `300000` | Close an idle `(instance, db)` connection after this long without a command; `0` disables |
| `connectTimeoutMs` | ⚪ Optional | `5000` | TCP/connect timeout |
| `commandTimeoutMs` | ⚪ Optional | `15000` | Per-command timeout; `0` disables it (a 60 s socket timeout still applies) |
| `maxResultItems` | ⚪ Optional | `200` | Per-container item cap |
| `maxResultChars` | ⚪ Optional | `4000` | Per-string character cap |
| `maxResultDepth` | ⚪ Optional | `4` | Nested container depth limit |
| `maxFetchItems` | ⚪ Optional | `1000` | Max items one `execute` bulk read may fetch |
| `maxFetchChars` | ⚪ Optional | `1000000` | Max bytes one `execute` string read may fetch |
| `scanCount` | ⚪ Optional | `500` | Default SCAN `COUNT` hint |
| `maxScanIterations` | ⚪ Optional | `200` | SCAN round-trip cap |
| `scanTimeBudgetMs` | ⚪ Optional | `10000` | `scan_keys` wall-clock budget |

Keep a config file containing passwords at `chmod 600`. `passwordEnv`/`usernameEnv` are supported if you prefer to inject credentials from the environment (`password` and `passwordEnv` cannot be combined).

Unknown fields (top-level or per instance) are rejected at startup, so a typo aborts the process.

---

## Security model

### Permission modes

The permission mode is an explicit enum with no `readOnly` boolean, and it defaults to `readonly`:

| Mode | Behavior |
| :---: | :---: |
| `readonly` | Only an explicit read-command whitelist is accepted; `SET`, `HSET`, `DEL`, `RESTORE`, ... are rejected. `EVAL`/`FCALL` remain rejected even if `allowScripting` is true. |
| `readwrite` | Write commands such as `SET`, `HSET`, `DEL` are allowed; the always-rejected list below still applies, and `EVAL`/`FCALL` are allowed only when `allowScripting` is true. |

Set it per instance (`"mode"`), for the single-instance environment form (`REDIS_MODE`), or for every instance at once (`--mode`). A Redis ACL with a read-only user is a second layer of defense — `readonly` mode is a convenience, not a replacement for server-side ACLs.

### Always rejected

| Category | Examples |
| --- | --- |
| Database / connection state | `SELECT`, `MOVE`, `SWAPDB`, `COPY ... DB`, `MULTI`, `EXEC`, `WATCH`, `RESET`, `HELLO`, `AUTH`, `QUIT` |
| Pub/sub and streaming | `SUBSCRIBE`, `PSUBSCRIBE`, `MONITOR`, `SYNC`, `PSYNC` |
| Administration | `CONFIG`, `DEBUG`, `CLIENT`, `ACL`, `MODULE`, `SHUTDOWN`, `SCRIPT`, `FUNCTION` |
| Topology / replication | `CLUSTER`, `REPLICAOF`, `SLAVEOF`, `FAILOVER`, `MIGRATE`, `REPLCONF` |
| Destructive / server-wide | `FLUSHDB`, `FLUSHALL`, `SAVE`, `BGSAVE`, `BGREWRITEAOF` |
| Blocking | `BLPOP`, `BRPOP`, `BLMOVE`, `BZPOPMIN`, `WAIT`, `XREAD`, `XREADGROUP`, ... |
| Slow key enumeration | `KEYS`, raw `SCAN` — use `scan_keys` |

Blocking commands are rejected because they hold a shared per-database connection and can stall every later request on that DB.

### Lua scripting

`EVAL`, `EVALSHA`, `EVAL_RO`, `EVALSHA_RO`, `FCALL` and `FCALL_RO` are **disabled by default**. `allowScripting: true` / `REDIS_ALLOW_SCRIPTING=1` enables them for trusted callers. In `readonly` mode the read-command whitelist still wins, so scripting stays rejected even with `allowScripting` enabled.

> A Lua script can call commands that the blocklist otherwise rejects, and depending on the Redis version it may be able to reach other logical databases. Treat `allowScripting` as disabling both the blocklist and the `allowedDbs` boundary: only enable it for trusted callers and enforce limits with a Redis ACL.

### Output and fetch bounds

Replies are truncated: `maxResultItems` per array/object, `maxResultChars` per string/buffer, `maxResultDepth` for nesting, and a global item/character budget derived from them so nested replies cannot multiply into gigabytes.

`execute` also checks bulk reads **before** the command runs:

| Shape | Guarded commands |
| --- | --- |
| Strings | `GET`, `GETDEL`, `GETEX`, `GETSET`, `SET ... GET`, `GETRANGE`/`SUBSTR`, `MGET` (≤ 100 keys), `HMGET` (≤ 100 fields) |
| Hash / set / zset | `HGET`, `HGETALL`, `HKEYS`, `HVALS`, `SMEMBERS`, `SINTER`/`SUNION`/`SDIFF`, `ZRANGE`/`ZREVRANGE`/`ZRANGEBY*`, `ZUNION`/`ZINTER`/`ZDIFF` |
| Lists | `LRANGE`, `LPOS ... COUNT 0` |
| Streams | `XRANGE`/`XREVRANGE` without `COUNT`, `XINFO STREAM ... FULL`, `XPENDING`, `XAUTOCLAIM` |
| Aggregates | `SORT`/`SORT_RO` without `LIMIT`, `LCS`, `GEOSEARCH`/`GEORADIUS*`, `DUMP` |
| Counts | pop and random-member counts, `HSCAN`/`SSCAN`/`ZSCAN` `COUNT`, `MEMORY USAGE ... SAMPLES 0`, `COMMAND`, `SLOWLOG GET` |

Unbounded forms are rejected with `COMMAND_REJECTED` and a pointer to `read_page`; bounded forms still run. The limits are `maxFetchItems` (default 1000) and `maxFetchChars` (default 1,000,000).

The check is advisory — metadata is read just before the command, so a concurrent writer can still grow the key afterwards — and not exhaustive: `LINDEX` and the `*STORE` variants are not checked, and item-count checks do not bound the byte size of a single field or member.

The guard and `read_page` issue `STRLEN`, `HSTRLEN`, `LLEN`, `HLEN`, `SCARD`, `ZCARD`, `XLEN`, `TYPE` and `MEMORY USAGE`, so the Redis user must be allowed to run them. A `NOPERM` on a guard command fails the `execute` call; `read_page` treats a failed size probe as unavailable and skips the page-size reduction. Since the byte check uses whole-key memory usage, a very large key can be rejected even when you only read a small page — use `read_page` for page-sized reads.

Other bounds:

- `read_page`: server-side paging; `limit` is validated at 1,000 and capped by `maxFetchItems`. Pass `nextOffset`, `nextCursor` or `nextStart` back unchanged until `complete` is `true`.
- `scan_keys`: `limit`, `maxScanIterations`, `scanTimeBudgetMs`
- `maxConnections`: bounds total sockets per instance

### Credentials

- A Redis user must be allowed to run `SELECT` to use any database other than 0. Without `+select`, `db > 0` fails closed with a `DB_ERROR` instead of silently using db 0.
- Prefer `passwordEnv` / `REDIS_PASSWORD` over inline JSON passwords.
- Keep a config file containing secrets at `chmod 600`.
- Error messages redact `password=...`, quoted/JSON password fields, echoed `AUTH` arguments, and any connection URL that may appear in an error.
- TLS certificate verification is on by default; `tlsRejectUnauthorized: false` disables it and should only be used for self-signed development servers.
- TLS supports `tls` and `tlsRejectUnauthorized` only; a custom CA or client certificate (`ca`/`cert`/`key`) cannot be configured.

### Transport

This package exposes a **stdio** MCP server. It does not open an HTTP port and does not implement MCP authentication. The MCP client that launches it is the trust boundary.

### Errors

Failed calls return `isError: true` with a JSON text block `{"error": "...", "code": "..."}`. Codes: `CONFIG_ERROR`, `COMMAND_REJECTED`, `COMMAND_SYNTAX`, `COMMAND_ERROR`, `INSTANCE_ERROR`, `DB_ERROR`, `CONNECTION_ERROR`, `INTERNAL_ERROR`. Redis server errors such as `NOPERM` or `WRONGTYPE` map to `COMMAND_ERROR`.

---

## Behavior and limitations

- **No `SELECT`**: logical DB selection is per call — see [Why this exists](#why-this-exists).
- **Redis Cluster**: only db 0 exists. The server detects `cluster_enabled:1` and rejects db > 0. It connects to a single node, so keys owned by other slots can return `MOVED`; it is not a cluster-aware sharding client.
- **No transactions**: `MULTI`/`EXEC`/`WATCH` are connection-level and would leak between requests.
- **No pub/sub or `MONITOR`**: they change the connection mode.
- **No blocking commands**: they would pin a shared connection. Use non-blocking variants (`XRANGE` instead of blocking `XREAD`, etc.).
- **Command timeouts are client-side**: the timeout rejects the call but does not cancel the command in Redis, so a timed-out write may still have been applied. Verify state before retrying. `commandTimeoutMs: 0` disables the command timeout, but the 60 s socket timeout still applies, so a command that stays silent for 60 s fails anyway.
- **Commands in flight during a disconnect are not resent**: a write that was sent when the socket dropped can fail even though Redis may have executed it. Verify state before retrying.
- **Binary values**: replies are decoded as UTF-8 strings. `DUMP` and other binary payloads may not round-trip; buffers are returned as bounded base64 when the client produces them.
- **Large reads**: a command the guard does not cover (see [Output and fetch bounds](#output-and-fetch-bounds)) can still be fully materialized before output truncation runs. Prefer `key_info` for metadata, `scan_keys` for enumeration, `read_page` for collections, and a restricted ACL / `commandTimeoutMs` for very large data.
- **SCAN consistency**: SCAN is incremental and not a snapshot; results can be missed or duplicated across calls.
- **Connection cache**: each `(instance, db)` pair keeps up to `poolSize` (default 4) pooled connections. The per-instance cap is `maxConnections` (default 32) and is a hard stop. Connections idle for longer than `idleTimeoutMs` (default 5 minutes) are closed automatically; a connection with a command that timed out is dropped immediately and replaced on the next request. Raise `maxConnections` if you legitimately use many logical DBs.
- **Cluster + ACL**: if `INFO cluster` is denied by ACL, the explicit `SELECT` verification still rejects db > 0 on a cluster with a clear error. db 0 does not require `SELECT`.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `DB_ERROR` | `allowedDbs` must contain the requested `db`, and the Redis user needs `+select` for db > 0. |
| `COMMAND_ERROR` with `NOPERM` | The ACL must allow the size/type commands the fetch guard uses (`STRLEN`, `HSTRLEN`, `LLEN`, `HLEN`, `SCARD`, `ZCARD`, `XLEN`, `TYPE`, `MEMORY USAGE`). |
| `CONFIG_ERROR` mentioning `references missing environment variable` | `passwordEnv`/`usernameEnv` must be present in the MCP client's `env` block. |
| `CONFIG_ERROR` mentioning `unknown field(s)` | A JSON field is misspelled; unknown fields abort startup. |
| `MOVED` | The key lives on another cluster node; only db 0 of a single node is supported. |
| `CONNECTION_ERROR` | Host/port unreachable, TLS handshake failed, or the server closed the connection. |

---

## License

MIT
