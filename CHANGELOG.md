# Changelog

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
