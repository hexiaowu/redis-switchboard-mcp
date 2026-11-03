import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '../errors.js';
import type { RedisClient, RedisProvider } from '../redis-manager.js';
import { jsonResult, runTool } from './common.js';

export const keyInfoInputSchema = z.object({
  key: z.string().min(1).max(4_096).describe('Key name to inspect.'),
  db: z
    .number()
    .int()
    .min(0)
    .max(255)
    .optional()
    .describe('Logical Redis database index (0-255). Defaults to the instance configuration.'),
  instance: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Configured Redis instance name. Required when several instances are configured without a default.'),
});

export type KeyInfoArgs = z.infer<typeof keyInfoInputSchema>;

export function createKeyInfoHandler(
  provider: RedisProvider,
): (args: KeyInfoArgs) => Promise<CallToolResult> {
  return (args) =>
    runTool(async () => {
      const instance = provider.resolveInstance(args.instance);
      const db = provider.resolveDb(instance, args.db);
      const client = await provider.getClient(instance, db);

      const type = await client.type(args.key);
      if (type === 'none') {
        return jsonResult({
          instance: instance.name,
          db,
          key: args.key,
          exists: false,
          type: 'none',
        });
      }

      const [pttlResult, memoryResult, encodingResult, lengthResult] = await Promise.allSettled([
        client.pttl(args.key),
        client.call('MEMORY', 'USAGE', args.key),
        client.call('OBJECT', 'ENCODING', args.key),
        readLength(client, type, args.key),
      ]);

      const pttl = pttlResult.status === 'fulfilled' ? pttlResult.value : null;
      const memoryUsageBytes =
        memoryResult.status === 'fulfilled' && typeof memoryResult.value === 'number'
          ? memoryResult.value
          : null;
      const encoding =
        encodingResult.status === 'fulfilled' && typeof encodingResult.value === 'string'
          ? encodingResult.value
          : null;
      const length =
        lengthResult.status === 'fulfilled' && typeof lengthResult.value === 'number'
          ? lengthResult.value
          : null;

      const warnings: string[] = [];
      if (memoryResult.status === 'rejected') {
        warnings.push(`MEMORY USAGE failed: ${errorMessage(memoryResult.reason)}`);
      }
      if (encodingResult.status === 'rejected') {
        warnings.push(`OBJECT ENCODING failed: ${errorMessage(encodingResult.reason)}`);
      }
      if (lengthResult.status === 'rejected') {
        warnings.push(`Length lookup failed: ${errorMessage(lengthResult.reason)}`);
      }

      const ttlMs = pttl !== null && pttl >= 0 ? pttl : null;
      const persistent = pttl === -1;
      const expiredDuringInspection = pttl === -2;

      return jsonResult({
        instance: instance.name,
        db,
        key: args.key,
        exists: true,
        type,
        ttlMs,
        persistent,
        memoryUsageBytes,
        encoding,
        length,
        lengthUnit: lengthUnitFor(type),
        ...(expiredDuringInspection
          ? { note: 'The key expired or was deleted while it was being inspected.' }
          : {}),
        ...(warnings.length === 0 ? {} : { warnings }),
      });
    });
}

async function readLength(client: RedisClient, type: string, key: string): Promise<number | null> {
  switch (type) {
    case 'string':
      return client.strlen(key);
    case 'list':
      return client.llen(key);
    case 'hash':
      return client.hlen(key);
    case 'set':
      return client.scard(key);
    case 'zset':
      return client.zcard(key);
    case 'stream':
      return client.xlen(key);
    default:
      return null;
  }
}

function lengthUnitFor(type: string): 'bytes' | 'items' | 'entries' | null {
  switch (type) {
    case 'string':
      return 'bytes';
    case 'stream':
      return 'entries';
    case 'list':
    case 'hash':
    case 'set':
    case 'zset':
      return 'items';
    default:
      return null;
  }
}
