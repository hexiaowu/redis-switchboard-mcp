# Changelog

## [0.1.5] - 2026-11-04

Security, correctness and connection-management release based on an independent eight-dimension code audit.

### Fixed

- **Fetch guard (P0)**: `HMGET` now caps fields at 100 and checks per-field `HSTRLEN` plus `MEMORY USAGE` — previously only the field count was bounded, so a 1000 × 512 MB reply could be materialized before truncation. Read-only commands with unbounded replies are now guarded: `LPOS ... COUNT 0`, `XINFO STREAM ... FULL COUNT 0`, `XPENDING`, `MEMORY USAGE ... SAMPLES 0` and `COMMAND` (LIST/DOCS/INFO). Read-write gaps closed: `SET ... GET`, `LMPOP`/`ZMPOP`, `GEORADIUS`/`GEORADIUSBYMEMBER`, `XAUTOCLAIM`, `SLOWLOG GET`.
- **Option shadowing (P1)**: keys literally named `LIMIT` or `COUNT` no longer make the guard skip the size bound (`ZRANGEBYSCORE LIMIT -inf +inf` etc. are now rejected like their normal-key counterparts).
- **`read_page kind="string"` (P1)**: pages are read at the byte level; a literal U+FFFD is kept (it used to be mistaken for a split character, causing an infinite paging loop and silent data loss) and invalid UTF-8 always makes forward progress.
- **Command timeout (P1)**: a timed-out command now poisons the connection (retire + disconnect + evict). ioredis keeps the command queued, so a lost reply could desync the queue and deliver later replies to the wrong command.
- **Reconnect hardening (P1)**: ioredis re-issues its own `SELECT` fire-and-forget on every reconnect; a failing one produced an unhandled rejection that killed the whole process. The promise now carries a no-op catch and a process-level `unhandledRejection` handler was added as a backstop.
- **`commandTimeoutMs: 0` (P1)**: `socketTimeout: 60s` is now always set (ioredis only arms it while a reply is pending), so half-open connections recover instead of hanging forever.
- **Byte bounds (P1)**: `MEMORY USAGE` checks added to the count-only guards (set/zset operations, random members, pops, GEOSEARCH); `SORT ... GET` amplification is accounted for; `read_page` shrinks the page limit from average item size and cuts list/zset/stream pages at an output byte budget; `scan_keys` derives its budget from `maxFetchChars`.
- **Truncation**: UTF-16 surrogate pairs are no longer split into lone surrogates.
- **db 0 reconnect**: db 0 now waits for the transport to be ready like db > 0, instead of failing with `Stream isn't writeable` during a reconnect blip.

### Added

- **Connection pool**: up to `poolSize` (default 4, `REDIS_POOL_SIZE`, 1-16) connections per `(instance, db)`; the pool grows only under concurrency and sequential requests reuse one connection.
- **Idle connection recycling**: `(instance, db)` connections idle for `idleTimeoutMs` (default 5 minutes, `REDIS_IDLE_TIMEOUT_MS`, 0 disables) are closed and evicted; eviction waits for in-flight commands and the next request reconnects on demand.
- **CI**: `windows-latest` added to the matrix; the test script lists test files explicitly (shell glob expansion broke `npm test` on Windows, and directory mode discovers no `.ts` files on Node 20).

### Changed

- **`mode` is now optional and defaults to `readonly`** (breaking for anyone relying on a required mode): precedence is `--mode` > `REDIS_MODE` / instance `mode` > readonly default. An operator who forgets to configure the mode gets read-only access instead of accidental writes. Invalid values are still rejected.

## [0.1.4] - 2026-11-04

- Release automation verification: first version published through npm Trusted Publishing
  (GitHub OIDC) via the release-triggered `Publish npm` workflow. No runtime changes since
  0.1.3.

## [0.1.3] - 2026-11-03

- Harden `normalizeCommand`: a command string whose whole payload is a JSON-serialized argument
  array (e.g. `["GET", "user:1"]`) is now parsed and executed as an argument array. Some MCP
  clients stringify `anyOf` array parameters before sending them, which previously failed with
  `Invalid command name "[GET,"`. Command lines that merely contain bracketed arguments are
  unaffected — a command name can never start with `[`, so the fallback only applies to input
  that previously errored.

## [0.1.2] - 2026-11-03

- Add a `redis-switchboard-mcp` bin alias alongside `rsm`, so `npx -y redis-switchboard-mcp`
  works even when the current working directory is this repository. Without the alias, npx can
  treat the local package as the target and fail with `sh: rsm: command not found`.

## [0.1.1] - 2026-11-03

- Fix the npm README, which incorrectly said the package was not published. No runtime changes.

## [0.1.0] - 2026-11-03

First public release.

### Added

- MCP tools: `execute`, `read_page`, `scan_keys`, `key_info`.
- Per-request logical database switching with a verified `SELECT` per `(instance, db)` connection. A failed `SELECT` fails closed; reconnects re-select and verify the target database before any command runs.
- Multi-instance JSON configuration and single-instance environment configuration.
- Explicit permission modes:
  - `readonly` — explicit read-command whitelist; `SET`, `HSET`, `DEL` and other writes are rejected.
  - `readwrite` — writes are allowed; the always-blocked command list still applies.
- Read-only command whitelist and an always-blocked list for connection state, administration, destructive, pub/sub, blocking and scripting commands.
- Fetch guards for unbounded bulk reads (`GET`, `MGET`, `HGETALL`, `LRANGE`, `ZRANGE`, `XRANGE`, ...) with `maxFetchItems` / `maxFetchChars`.
- Bounded reply truncation with per-container and global item/character budgets.
- Cursor-based `scan_keys` with limit, iteration and wall-clock budgets.
- Bounded collection paging through `read_page` (list / hash / set / zset / stream / string), including UTF-8-safe string paging.
- Redis Cluster detection (db 0 only), per-instance `maxConnections`, credential redaction and TLS support.
- English and Chinese READMEs.
- GitHub Actions CI on Node.js 20, 22 and 24.
- 132 tests, including an in-process fake Redis server and MCP stdio handshake tests.

### Configuration notes

- `host` and `port` are required; there is no built-in endpoint default.
- `mode` is required in JSON instance configs and must be `readonly` or `readwrite`.
- For single-instance environment config, `REDIS_HOST`, `REDIS_PORT` and `REDIS_MODE` are required (unless `--mode` overrides the mode).
- JSON config and the single-instance `REDIS_HOST` / `REDIS_PORT` / `REDIS_MODE` environment variables are mutually exclusive.

### Removed

- The earlier boolean `readOnly` config, `REDIS_READONLY` environment variable and `--readonly` flag were removed in favor of `mode` / `REDIS_MODE` / `--mode`.
- The URL-based configuration (`url`, `REDIS_URL`, `--url`) was removed; use `host` + `port` instead.
