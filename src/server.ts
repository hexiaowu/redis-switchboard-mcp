import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RedisProvider } from './redis-manager.js';
import { createExecuteHandler, executeInputSchema } from './tools/execute.js';
import { createKeyInfoHandler, keyInfoInputSchema } from './tools/key-info.js';
import { createReadPageHandler, readPageInputSchema } from './tools/read-page.js';
import { createScanKeysHandler, scanKeysInputSchema } from './tools/scan-keys.js';

export const SERVER_NAME = 'redis-switchboard-mcp';

export function createServer(provider: RedisProvider, version: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    {
      capabilities: { tools: {} },
      // Bound the total size of a tools/call arguments payload. Individual tool
      // schemas also have their own string/array limits.
      maxToolInputElements: 10_000,
    },
  );

  server.registerTool(
    'execute',
    {
      title: 'Execute Redis command',
      description:
        'Execute one Redis command against a logical database chosen per call. ' +
        'Pass `command` as a command line ("GET user:1") or as an argument array (["GET", "user:1"]). ' +
        'The `db` argument selects the database; SELECT is rejected because it is connection-level state. ' +
        'Instances in readonly mode reject write commands. Administrative, destructive and blocking commands are always rejected. ' +
        'Bulk reads that would exceed maxFetchItems/maxFetchChars are rejected; use read_page for collections. ' +
        'Replies are size-bounded, with truncation details in `notes`.',
      inputSchema: executeInputSchema,
      annotations: {
        title: 'Execute Redis command',
        readOnlyHint: false,
        // execute can run DEL/UNLINK/RENAME and other mutating commands, so the
        // conservative MCP default (destructive) applies.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    createExecuteHandler(provider),
  );

  server.registerTool(
    'read_page',
    {
      title: 'Read a page of a Redis collection',
      description:
        'Read a bounded page from a large list, hash, set, sorted set, stream or string without materializing the whole value. ' +
        'Use this instead of HGETALL / SMEMBERS / LRANGE 0 -1 / GET on large values. ' +
        'list: LRANGE with offset+limit; hash/set: HSCAN/SSCAN with cursor; zset: ZRANGE with offset+limit; ' +
        'stream: XRANGE with COUNT; string: GETRANGE with offset+limit (limit = bytes). ' +
        'Returns a nextCursor/nextOffset/nextStart for the following page.',
      inputSchema: readPageInputSchema,
      annotations: {
        title: 'Read a page of a Redis collection',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createReadPageHandler(provider),
  );

  server.registerTool(
    'scan_keys',
    {
      title: 'Scan Redis keys',
      description:
        'Incrementally scan keys using SCAN (never KEYS). Returns a batch of key names plus the next cursor. ' +
        'Pass the returned `cursor` back to continue. SCAN may return duplicate keys across calls; duplicates ' +
        'inside one call are removed. Use `type` to restrict by Redis key type. ' +
        'The call stops after `limit` keys, when the cursor reaches 0, or after the configured iteration cap.',
      inputSchema: scanKeysInputSchema,
      annotations: {
        title: 'Scan Redis keys',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createScanKeysHandler(provider),
  );

  server.registerTool(
    'key_info',
    {
      title: 'Inspect Redis key metadata',
      description:
        'Return metadata for a key without returning its value: type, TTL, memory usage, internal encoding ' +
        'and a type-specific length/count (bytes for strings, entries for streams, items for collections). ' +
        'For a missing key, returns exists=false.',
      inputSchema: keyInfoInputSchema,
      annotations: {
        title: 'Inspect Redis key metadata',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createKeyInfoHandler(provider),
  );

  return server;
}
