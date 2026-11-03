#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, parseCli } from './config.js';
import { errorMessage } from './errors.js';
import { RedisManager } from './redis-manager.js';
import { createServer } from './server.js';
import { getVersion } from './version.js';

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const version = getVersion();

  if (cli.help) {
    printHelp(version);
    return;
  }
  if (cli.version) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const config = loadConfig({ cli, env: process.env });
  const manager = new RedisManager(config);
  const server = createServer(manager, version);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  const instanceNames = config.instances.map((instance) => instance.name).join(', ');
  const modes = new Set(config.instances.map((instance) => instance.mode));
  const modeLabel = modes.size === 1 ? [...modes][0] : 'mixed';
  // stdout belongs to the MCP transport, so diagnostics go to stderr.
  process.stderr.write(
    `[redis-switchboard-mcp] v${version} ready (instances: ${instanceNames}; ${modeLabel})\n`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    try {
      await server.close();
    } catch {
      // The transport may already be closed.
    }
    try {
      await manager.close();
    } catch {
      // Best effort during shutdown.
    }
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.stdin.once('end', () => {
    void shutdown();
  });

  // Background reconnects can produce rejections nobody observes (for example
  // ioredis re-issuing SELECT after a failover). Keep serving instead of
  // letting Node's default unhandled-rejection policy kill the process.
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(`[redis-switchboard-mcp] unhandled rejection: ${errorMessage(reason)}\n`);
  });
}

function printHelp(version: string): void {
  process.stdout.write(
    [
      `redis-switchboard-mcp v${version}`,
      '',
      'Usage: rsm [options]',
      '',
      'Options:',
      '  --config <path>  JSON config file describing one or more Redis instances',
      '  --name <name>    Instance name (default: "default")',
      '  --db <n>         Default logical database, 0-255 (default: 0)',
      '  --mode <mode>    Permission mode: readonly | readwrite (overrides JSON modes)',
      '  -h, --help       Show this help',
      '  -v, --version    Show the version',
      '',
      'Environment:',
      '  REDIS_MCP_CONFIG                 Path to a JSON config file (alternative to host/port)',
      '  REDIS_HOST / REDIS_PORT          Redis endpoint (required for single-instance env config)',
      '  REDIS_USERNAME / REDIS_PASSWORD  ACL credentials',
      '  REDIS_DB                         Default logical database (default: 0)',
      '  REDIS_NAME                       Instance name (default: default)',
      '  REDIS_MODE                       "readonly" or "readwrite" (default: readonly)',
      '  REDIS_TLS                        "1" to enable TLS',
      '  REDIS_TLS_REJECT_UNAUTHORIZED    "0" to skip certificate verification',
      '  REDIS_ALLOWED_DBS                Comma-separated allowlist, e.g. "0,2,4"',
      '  REDIS_ALLOW_SCRIPTING            "1" to allow EVAL/EVALSHA/FCALL',
      '  REDIS_MAX_CONNECTIONS            Per-instance connection cache limit (default: 32)',
      '  REDIS_POOL_SIZE                  Connections pooled per (instance, db) (default: 4)',
      '  REDIS_IDLE_TIMEOUT_MS            Close idle (instance, db) connections after this long; 0 disables (default: 300000)',
      '  REDIS_CONNECT_TIMEOUT_MS         TCP/connect timeout (default: 5000)',
      '  REDIS_COMMAND_TIMEOUT_MS         Command timeout, 0 disables (default: 15000)',
      '  REDIS_MAX_RESULT_ITEMS           Per-container item cap (default: 200)',
      '  REDIS_MAX_RESULT_CHARS           Per-string character cap (default: 4000)',
      '  REDIS_MAX_RESULT_DEPTH           Max nested depth (default: 4)',
      '  REDIS_MAX_FETCH_ITEMS            Max items one execute read may fetch (default: 1000)',
      '  REDIS_MAX_FETCH_CHARS            Max bytes one execute string read may fetch (default: 1000000)',
      '  REDIS_SCAN_COUNT                 Default SCAN COUNT (default: 500)',
      '  REDIS_MAX_SCAN_ITERATIONS        Max SCAN round trips (default: 200)',
      '  REDIS_SCAN_TIME_BUDGET_MS        Time budget for one scan_keys call (default: 10000)',
      '',
      'Tools: execute, read_page, scan_keys, key_info',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`[redis-switchboard-mcp] ${errorMessage(error)}\n`);
  process.exit(1);
});
