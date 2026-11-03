# redis-switchboard-mcp

[English](README.md) | [简体中文](README.zh-CN.md)

A Redis MCP server that switches **logical databases per request** instead of relying on Redis's connection-level `SELECT`.

```text
execute    → run a Redis command against db 2, db 4, ...
read_page  → bounded page of a list / hash / set / zset / stream / string
scan_keys  → cursor-based SCAN with limits
key_info   → type / TTL / memory / encoding / length
```

`redis-switchboard-mcp` is designed for the way MCP clients actually work: many independent tool calls, often concurrent, against several environments and several Redis logical databases.

---

## Why this exists

Redis's `SELECT` changes the database of a **connection**, not of a command. An MCP server that shares one connection and runs `SELECT` on demand will silently mix databases: a concurrent call, a pooled connection, or an automatic reconnect can leave the client on the wrong DB.

Tool calls never run `SELECT` themselves, and the server does not trust ioredis's connection-time `SELECT` (ioredis swallows a failed `SELECT` and still reports the connection as ready). Instead:

1. Every tool accepts a `db` argument.
2. Clients are cached per `(instance, db)` — one dedicated connection per logical database.
3. Each connection starts on db 0 and explicitly runs `SELECT db` for db > 0. The result is verified before any tool command runs; a failed `SELECT` disconnects and errors instead of silently using db 0.
4. After a reconnect, the target database is selected and verified again before commands are allowed.
5. `SELECT`, `MOVE`, `SWAPDB`, `COPY ... DB` and transaction/pub-sub state commands are rejected.

The result is stateless from the caller's point of view: `execute` in db 2 and db 4 can run concurrently without leaking state.

---

## Features

- **Per-call database selection** for every tool (`db: 0-255`).
- **Multiple Redis instances** from a JSON config, selected with the `instance` argument.
- **Explicit permission mode** (`readonly` / `readwrite`); `readonly` uses an explicit read-command whitelist. The mode is optional: an instance without a configured mode defaults to `readonly`.
- **Command blocklist** for connection-level, administrative, destructive and blocking commands.
- **Lua scripting disabled by default** (`EVAL`/`EVALSHA`/`FCALL`).
- **Bounded output** with per-container and global item/character budgets.
- **Paged collection reads** via `read_page`, so large lists/hashes/sets/streams are never fetched in one shot.
- **Fetch guards** in `execute`: unbounded `GET`/`MGET`/`HMGET`, `LRANGE 0 -1`, `HGETALL`/`HKEYS`/`HVALS`, `SMEMBERS`, `ZRANGE 0 -1`, `ZUNION`/`ZINTER`/`ZDIFF`, `XRANGE` without `COUNT`, huge `HSCAN`/`SSCAN`/`ZSCAN` `COUNT`, `SORT_RO` without `LIMIT`, negative random counts and oversized set operations are rejected with a pointer to `read_page`.
- **Bounded scans** with `limit`, SCAN iteration cap, and a wall-clock budget.
- **Cluster detection** — logical DBs other than 0 are rejected on a Redis Cluster.
- **Connection cache limit** per instance (`maxConnections`, default 32), with a small pool per `(instance, db)` (`poolSize`, default 4) and **idle connection recycling** (`idleTimeoutMs`, default 5 minutes): a connection that has not run any command for 5 minutes is closed and evicted, so databases you stop using stop holding server resources.
- **Credential redaction** in error messages.
- **No stdout logging** — stdout is reserved for the MCP stdio transport.

---

## Requirements

- Node.js **20 or newer**
- Redis 6+ recommended (Redis 7+ for `SORT_RO` and some `SCAN TYPE` features)
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

If the package is installed globally, `"command": "rsm"` and no args also work.

### Multiple instances from a JSON file

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

The same file can be selected with `REDIS_MCP_CONFIG=/path/to/config.json`.

> **Note:** diagnostics are written to stderr. Never print to stdout from this process — the MCP transport owns it.

> **Running from this repository:** version 0.1.2+ includes a `redis-switchboard-mcp` bin alias,
> so `npx -y redis-switchboard-mcp` works even when the MCP client's `cwd` is the repository root.
> For 0.1.1 and earlier, add `--prefix` pointing outside the repository or use
> `node /absolute/path/to/redis-switchboard-mcp/dist/index.js` (run `npm run build` first).

---

<h2 align="center">⚙️ Configuration</h2>

<h3 align="center">🔀 Precedence</h3>

1. Command-line flags (`--config`, `--db`, ...)
2. Environment variables
3. Defaults

`--config` selects a JSON config file. `--name`/`--db` apply only to the single-instance environment form; edit the JSON file for per-instance values.

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
| `REDIS_HOST` | ✅ Required | — | Redis host |
| `REDIS_PORT` | ✅ Required | — | Redis port |
| `REDIS_USERNAME` | ⚪ Optional | — | ACL username |
| `REDIS_PASSWORD` | 🔶 Conditional | — | Password (required when Redis requires authentication) |
| `REDIS_DB` | ⚪ Optional | `0` | Default logical database when `db` is omitted |
| `REDIS_TLS` | ⚪ Optional | `false` | Enable TLS |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | ⚪ Optional | `true` | Verify the server certificate |
| `REDIS_MODE` | ⚪ Optional | `readonly` | Permission mode: `readonly` or `readwrite` (defaults to `readonly` when omitted) |
| `REDIS_ALLOWED_DBS` | ⚪ Optional | — | Comma-separated allowlist, e.g. `0,2,4` |
| `REDIS_ALLOW_SCRIPTING` | ⚪ Optional | `false` | Allow `EVAL`/`EVALSHA`/`FCALL` (see security caveat) |
| `REDIS_MAX_CONNECTIONS` | ⚪ Optional | `32` | Per-instance connection cache limit (1-256) |
| `REDIS_POOL_SIZE` | ⚪ Optional | `4` | Connections pooled per `(instance, db)` (1-16) |
| `REDIS_IDLE_TIMEOUT_MS` | ⚪ Optional | `300000` | Close an idle `(instance, db)` connection after this long without a command; `0` disables |
| `REDIS_CONNECT_TIMEOUT_MS` | ⚪ Optional | `5000` | TCP/connect timeout |
| `REDIS_COMMAND_TIMEOUT_MS` | ⚪ Optional | `15000` | Per-command timeout; `0` disables it |
| `REDIS_MAX_RESULT_ITEMS` | ⚪ Optional | `200` | Per-array/object item cap in replies |
| `REDIS_MAX_RESULT_CHARS` | ⚪ Optional | `4000` | Per-string cap in replies |
| `REDIS_MAX_RESULT_DEPTH` | ⚪ Optional | `4` | Maximum nested container depth |
| `REDIS_MAX_FETCH_ITEMS` | ⚪ Optional | `1000` | Max items one `execute` bulk read may fetch |
| `REDIS_MAX_FETCH_CHARS` | ⚪ Optional | `1000000` | Max bytes one `execute` string read may fetch |
| `REDIS_SCAN_COUNT` | ⚪ Optional | `500` | Default SCAN `COUNT` hint |
| `REDIS_MAX_SCAN_ITERATIONS` | ⚪ Optional | `200` | Maximum SCAN round trips per call |
| `REDIS_SCAN_TIME_BUDGET_MS` | ⚪ Optional | `10000` | Wall-clock budget per `scan_keys` call |

<p align="center"><strong>Connection methods:</strong> choose one of the following.</p>

| Method | Required | How |
| :---: | :---: | :---: |
| JSON config | 🔶 Conditional | Set `REDIS_MCP_CONFIG` (or `--config`) |
| Host + port | ✅ Required | Set `REDIS_HOST` and `REDIS_PORT` |

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

<p align="center"><strong>Top-level fields</strong></p>

<p align="center"><strong>Legend:</strong> ✅ Required · 🔶 Conditionally required · ⚪ Optional</p>

| Field | Required | Default | Description |
| :---: | :---: | :---: | :---: |
| `instances` | ✅ Required | — | Array with at least one instance |
| `defaultInstance` | ⚪ Optional | — | Instance used when a tool call omits `instance` |
| `$schema` | ⚪ Optional | — | Ignored; useful for editor schema hints |

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
| `allowedDbs` | ⚪ Optional | — | Restrict which logical DBs this instance may access |
| `maxConnections` | ⚪ Optional | `32` | Cache limit for `(instance, db)` connections |
| `poolSize` | ⚪ Optional | `4` | Connections pooled per `(instance, db)` (1-16) |
| `idleTimeoutMs` | ⚪ Optional | `300000` | Close an idle `(instance, db)` connection after this long without a command; `0` disables |
| `connectTimeoutMs` | ⚪ Optional | `5000` | TCP/connect timeout |
| `commandTimeoutMs` | ⚪ Optional | `15000` | Per-command timeout; `0` disables |
| `maxResultItems` | ⚪ Optional | `200` | Per-container item cap |
| `maxResultChars` | ⚪ Optional | `4000` | Per-string character cap |
| `maxResultDepth` | ⚪ Optional | `4` | Nested container depth limit |
| `maxFetchItems` | ⚪ Optional | `1000` | Max items one `execute` bulk read may fetch |
| `maxFetchChars` | ⚪ Optional | `1000000` | Max bytes one `execute` string read may fetch |
| `scanCount` | ⚪ Optional | `500` | Default SCAN `COUNT` hint |
| `maxScanIterations` | ⚪ Optional | `200` | SCAN round-trip cap |
| `scanTimeBudgetMs` | ⚪ Optional | `10000` | `scan_keys` wall-clock budget |

Use `passwordEnv` rather than storing a password in the file, and keep the file `chmod 600`.

---

## Tools

### `execute`

Run one Redis command against a specific logical database.

```json
{ "command": "GET user:42", "db": 2 }
```

```json
{ "command": ["HGET", "user:42", "name"], "db": 4, "instance": "cache-prod" }
```

- `command` is a command line (quotes and backslash escapes supported) or an argument array. A
  command line whose whole payload is a JSON-serialized argument array (e.g. `["GET", "user:1"]`,
  as produced by some MCP clients that stringify array parameters) is also accepted and parsed.
- `db` selects the logical database per call. It defaults to the instance's `db`.
- `instance` is required when several instances are configured without a default.
- Write commands are rejected when the instance `mode` is `readonly`.
- `SELECT` is always rejected — pass `db` instead.
- Bulk reads are guarded before execution: `GET`/`MGET`/`GETDEL`/`GETEX`/`GETSET`, `GETRANGE`, `LRANGE`, `HGETALL`/`HKEYS`/`HVALS`, `SMEMBERS`, `ZRANGE`/`ZRANGEBY*`/`ZUNION`/`ZINTER`/`ZDIFF`, `XRANGE`, `SORT`/`SORT_RO`, `LCS`, pop counts, negative random counts and oversized set operations are checked against `maxFetchItems`/`maxFetchChars` and rejected with `COMMAND_REJECTED` when unbounded. `HMGET` is limited by requested field count. Use `read_page` or a bounded variant. The guard is advisory (metadata is checked just before the command), not atomic.

Response:

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

When a reply is cut, `truncated` is `true` and `notes` explains which parts were shortened.

### `read_page`

Read **one bounded page** from a large collection. This is the safe alternative to `HGETALL`, `SMEMBERS`, `LRANGE key 0 -1`, `GET` on a big string, etc.

```json
{ "kind": "list", "key": "queue", "db": 2, "offset": 0, "limit": 100 }
```

| `kind` | Redis command | Paging |
| --- | --- | --- |
| `list` | `LRANGE key offset offset+limit-1` | `nextOffset` |
| `string` | `GETRANGE key offset offset+limit-1` (`limit` = bytes) | `nextOffset` |
| `hash` | `HSCAN key cursor COUNT limit [MATCH pattern]` | `nextCursor` |
| `set` | `SSCAN key cursor COUNT limit [MATCH pattern]` | `nextCursor` |
| `zset` | `ZRANGE key offset offset+limit-1 [WITHSCORES]` | `nextOffset` |
| `stream` | `XRANGE key start end COUNT limit` | `nextStart` |

Response (list):

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

- `limit` defaults to 100 and is capped at 1,000, by `maxFetchItems`, and by an output budget derived from `maxFetchChars` and `maxResultChars`. `outputBytes` reports the page size in bytes.
- `limit` bounds the number of elements/fields, not the byte size of one element. A single large list element or hash value is still fetched in full; use `kind: "string"` with `GETRANGE` for large string values.
- Per-item strings are truncated at `maxResultChars`; `truncatedItems` reports how many were cut. `notes` reports limit reductions and SCAN batch overflows.
- `hash`/`set` use SCAN, so one call may return slightly more than `COUNT`; the whole batch is returned to avoid dropping fields/members, and `outputBytes` reports the actual size (it can exceed the page budget by one SCAN batch).
- For `kind: "string"`, `offset` and `limit` are **byte** offsets (Redis `GETRANGE`/`STRLEN` are byte-based). Pages are kept on UTF-8 character boundaries: a trailing incomplete character is left for the next page, so a page can return a few bytes more than `limit`.
- For stream paging, pass `nextStart` back as `start`; it is exclusive (`(` prefix). A page that exactly fills `limit` may need one extra empty request to confirm `complete`.
- For hash/set paging, pass `nextCursor` back as `cursor`.

### `scan_keys`

Cursor-based `SCAN` (never `KEYS`).

```json
{ "pattern": "session:*", "db": 2, "limit": 200, "type": "hash" }
```

Response:

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

Pass `cursor` back unchanged (prefer the string form) to continue. Notes:

- SCAN is not a snapshot; keys may appear, disappear or be returned twice across calls.
- Duplicates **inside one call** are removed.
- The call stops after `limit` (rounded up to the current SCAN batch), when the cursor reaches `0`, after `maxScanIterations`, when the ~1 MB key-name budget is reached, or when the time budget is exhausted. Keys from the current batch are always returned, so a call can exceed `limit` and the key-name budget by up to one batch (`count` is clamped to 1,000, so the worst case is roughly 4 MB with 4,096-character keys).
- `count` is clamped to 1,000 to keep one batch bounded; key names are capped at 4,096 characters.
- `scannedEntries` is the number of names returned by SCAN batches, not an exact count of visited keys.

### `key_info`

Metadata only — never the value itself.

```json
{ "key": "user:42", "db": 2 }
```

Response:

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

`lengthUnit` is `bytes` for strings, `entries` for streams, and `items` for lists/hashes/sets/sorted sets. If `MEMORY USAGE` or `OBJECT ENCODING` is unavailable (old Redis, restrictive ACL), the field is `null` and a `warnings` array is added.

---

## Security model

### Permission modes

The permission mode is an explicit enum with no `readOnly` boolean. When the mode is not configured, the instance defaults to `readonly`:

| Mode | Behavior |
| :---: | :---: |
| `readonly` | Only an explicit read-command whitelist is accepted; `SET`, `HSET`, `DEL`, `RESTORE`, ... are rejected. `EVAL`/`FCALL` remain rejected even if `allowScripting` is true. |
| `readwrite` | Write commands such as `SET`, `HSET`, `DEL` are allowed; the always-rejected list below still applies, and `EVAL`/`FCALL` are allowed only when `allowScripting` is true. |

Set it in JSON as `"mode": "readonly"` / `"mode": "readwrite"`, in environment configuration with `REDIS_MODE=readonly|readwrite`, or override every instance with `--mode readonly|readwrite`. Precedence: `--mode` wins over `REDIS_MODE` / the instance `mode` field; an instance with no mode configured at all is `readonly`.

`REDIS_MODE` cannot be combined with a JSON config file; set `mode` per instance instead (or use `--mode` to override all instances).

With no mode configured the instance is read-only; set `mode: "readwrite"` (JSON), `REDIS_MODE=readwrite` (environment) or `--mode readwrite` explicitly to allow writes. Use a Redis ACL with a read-only user as a second layer of defense — `readonly` mode is a convenience, not a replacement for server-side ACLs.

**Migration:** `readOnly` (JSON), `REDIS_READONLY` and `--readonly` were removed. Use `mode`, `REDIS_MODE` and `--mode` instead.

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

`EVAL`, `EVALSHA`, `EVAL_RO`, `EVALSHA_RO`, `FCALL` and `FCALL_RO` are **disabled by default**. `allowScripting: true` / `REDIS_ALLOW_SCRIPTING=1` enables them for trusted callers.

> A Lua script can call commands that the blocklist otherwise rejects, and depending on the Redis version it may be able to reach other logical databases. Treat `allowScripting` as disabling both the blocklist and the `allowedDbs` boundary: only enable it for trusted callers and enforce limits with a Redis ACL.

### Output and fetch bounds

- Per array/object: `maxResultItems`
- Per string/buffer: `maxResultChars`
- Nesting: `maxResultDepth`
- Whole reply: global item and character budgets derived from the above (roughly 1000+ items / 100 KB-1 MB), preventing nested replies from multiplying into gigabytes
- `execute` bulk reads: `maxFetchItems` (default 1000) and `maxFetchChars` (default 1,000,000) are checked **before** the command runs; unbounded `GET`, `LRANGE`, `HGETALL`, `SMEMBERS`, `ZRANGE`, `XRANGE` and oversized set operations are rejected
- `MGET` is limited to 100 keys per call; `HMGET` is limited to `maxFetchItems` requested fields
- `read_page`: server-side paging with `limit` capped at 1,000 / `maxFetchItems`
- `scan_keys`: `limit`, `maxScanIterations`, `scanTimeBudgetMs`
- `maxConnections`: bounds total sockets per instance

### Credentials

- A Redis user must be allowed to run `SELECT` to use any database other than 0. Without `+select`, `db > 0` fails closed with a `DB_ERROR` instead of silently using db 0.
- Prefer `passwordEnv` / `REDIS_PASSWORD` over inline JSON passwords.
- Keep a config file containing secrets at `chmod 600`.
- Error messages redact `password=...`, quoted/JSON password fields, echoed `AUTH` arguments, and any connection URL that may appear in an error.
- TLS certificate verification is on by default; `tlsRejectUnauthorized: false` disables it and should only be used for self-signed development servers.

### Transport

This package exposes a **stdio** MCP server. It does not open an HTTP port and does not implement MCP authentication. The MCP client that launches it is the trust boundary.

---

## Behavior and limitations

- **No `SELECT`**: logical DB selection is per call. This is the point of the project.
- **Redis Cluster**: only db 0 exists. The server detects `cluster_enabled:1` and rejects db > 0. It connects to a single node, so keys owned by other slots can return `MOVED`; it is not a cluster-aware sharding client.
- **No transactions**: `MULTI`/`EXEC`/`WATCH` are connection-level and would leak between requests.
- **No pub/sub or `MONITOR`**: they change the connection mode.
- **No blocking commands**: they would pin a shared connection. Use non-blocking variants (`XRANGE` instead of blocking `XREAD`, etc.).
- **Command timeouts are client-side**: ioredis rejects the promise but does not cancel the command in Redis, so a timed-out write may still have been applied. Verify state before retrying. `commandTimeoutMs: 0` disables the timeout; a very slow normal command can then occupy its connection.
- **Commands in flight during a disconnect are not resent**: `autoResendUnfulfilledCommands` is disabled to avoid applying a non-idempotent write twice. A command that was sent when the socket dropped can fail even though Redis may have executed it.
- **Binary values**: replies are decoded as UTF-8 strings. `DUMP` and other binary payloads may not round-trip; buffers are returned as bounded base64 when the client produces them.
- **Metadata commands for guards**: `execute`'s fetch guard issues `STRLEN`, `LLEN`, `HLEN`, `SCARD`, `ZCARD`, `XLEN`, `TYPE` and `MEMORY USAGE`; `read_page` issues the corresponding size command for its `kind`. The Redis user must be allowed to run them; `NOPERM` on a size/type command fails closed.
- **Guard overhead and false positives**: a guarded `execute` adds 1-3 metadata round trips (up to 100 for `MGET`, up to 64 for set/zset operations), and `MEMORY USAGE` is a slow command. The byte check uses whole-key `MEMORY USAGE`, so a very large key can be rejected even for a small `LRANGE`/`ZRANGE`/`XRANGE` page; use `read_page` for page-sized reads. The guard is advisory (TOCTOU): a concurrent writer can grow a key after the check.
- **Fetch guard coverage**: covered forms include `GET`/`MGET`/`GETDEL`/`GETEX`/`GETSET`, `GETRANGE`/`SUBSTR`, `HGET`, `DUMP`, `LRANGE`, `HGETALL`/`HKEYS`/`HVALS`, `SMEMBERS`, `SINTER`/`SUNION`/`SDIFF`, `ZRANGE`/`ZRANGEBY*`/`ZUNION`/`ZINTER`/`ZDIFF`, `XRANGE`/`XREVRANGE`, `HSCAN`/`SSCAN`/`ZSCAN` `COUNT`, `SORT`/`SORT_RO`, `LCS`, `GEOSEARCH`/`GEORADIUS_RO`/`GEORADIUSBYMEMBER_RO`, random members and pop counts. It is **not exhaustive**: `LINDEX`, `XPENDING`, `XINFO STREAM ... FULL`, `SET ... GET`, `LMPOP`/`ZMPOP` are not guarded, and item-count-only checks do not bound the byte size of an individual field/member. For those, use a restricted ACL, `commandTimeoutMs`, and the smallest possible command.
- **Large reads**: `execute` rejects the common unbounded bulk-read forms and `read_page` provides server-side paging. A command that is not covered by the guard (for example an unusual command with a large reply) can still be fully materialized by Redis/ioredis before `truncateReply` runs. Prefer `key_info` for metadata, `scan_keys` for key enumeration, `read_page` for collections, and a restricted ACL / `commandTimeoutMs` for very large data.
- **SCAN consistency**: SCAN is incremental and not a snapshot; results can be missed or duplicated across calls.
- **Connection cache**: each `(instance, db)` pair keeps up to `poolSize` (default 4) pooled connections. The per-instance cap is `maxConnections` (default 32) and is a hard stop. Connections idle for longer than `idleTimeoutMs` (default 5 minutes) are closed automatically; a connection with a command that timed out is dropped immediately and replaced on the next request. Raise `maxConnections` if you legitimately use many logical DBs.
- **Cluster + ACL**: if `INFO cluster` is denied by ACL, the explicit `SELECT` verification still rejects db > 0 on a cluster with a clear error. db 0 does not require `SELECT`.

---

## Development

```bash
npm ci
npm run check      # typecheck src + tests, then run the test suite
npm run build      # compile to dist/
npm run dev        # run from src with tsx
```

The test suite uses a small in-process RESP server (`test/fake-redis-server.ts`), so it does **not** require a local Redis. It covers:

- command tokenization, blocklist and readonly policy
- reply truncation and global budgets
- environment / JSON / CLI configuration
- per-database client isolation and promise caching
- connection cache limits and error mapping
- `execute`, `read_page`, `scan_keys`, `key_info` end-to-end over real ioredis
- fetch guards for `GET` / `LRANGE` / `HGETALL` / `SMEMBERS` / `ZRANGE` / `XRANGE` / random members / set operations
- MCP handshake and `tools/list` over stdio

Project layout:

```text
src/
  index.ts          CLI entry and stdio transport
  lib.ts            Side-effect-free library entry
  server.ts         MCP server + tool registration
  config.ts         env / JSON / CLI configuration
  commands.ts       tokenizer, blocklist, readonly whitelist
  truncate.ts       bounded reply serialization
  redis-manager.ts  per-(instance, db) client cache
  fetch-guard.ts    preflight size guards for execute bulk reads
  tools/            execute, read_page, scan_keys, key_info handlers
test/               unit, integration and MCP handshake tests
```

---

## Publishing

Publishing is automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

- Triggered when a **GitHub Release is published**, or manually via `workflow_dispatch` with an existing tag.
- Uses **npm Trusted Publishing (GitHub OIDC)** — no long-lived npm token.
- Checks out the tag, installs dependencies, then runs `npm publish --access public`.
- `prepublishOnly` runs typecheck, test typecheck, build and the full test suite before uploading.

### One-time setup (Trusted Publishing)

1. Open the npm package settings → **Trusted Publisher** → **GitHub Actions**.
2. Fill in:
   - **Organization or user:** `hexiaowu`
   - **Repository:** `redis-switchboard-mcp`
   - **Workflow filename:** `publish.yml` (filename only, include `.yml`; do not include `.github/workflows/`)
   - **Environment name:** leave blank
3. Click **Add trusted publisher** — the button is not labeled “Save”.
4. The first publish after configuring must succeed within 2 days to validate the setup.

If the website does not show the add control, use the npm CLI (npm 11.15+):

```bash
npm install -g npm@11
npm trust github redis-switchboard-mcp \
  --file publish.yml \
  --repo hexiaowu/redis-switchboard-mcp \
  --allow-publish \
  --yes
npm trust list redis-switchboard-mcp
```

If `npm trust` reports that you must be logged in, run `npm login --auth-type=web` first and complete 2FA.

The workflow already has `permissions: id-token: write`; npm generates provenance automatically, so `--provenance` is not required.

If you prefer a token instead, add an `NPM_TOKEN` repository secret and put
`env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }` on the publish step. Use a granular token with Read and write access and **Bypass 2FA** enabled.

### Release flow

```bash
# 1. Bump the version and update CHANGELOG.md
npm version patch --no-git-tag-version
# edit CHANGELOG.md

# 2. Commit and tag
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v0.1.2"
git tag -a v0.1.2 -m "v0.1.2"
git push origin main --tags

# 3. Create a GitHub Release (this triggers the publish workflow)
gh release create v0.1.2 --title "v0.1.2" --notes "..."
```

After the workflow succeeds:

```bash
npm view redis-switchboard-mcp version dist-tags
```

Do not commit npm tokens or `.npmrc` files to the repository.

## License

MIT
