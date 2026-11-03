import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RedisProvider } from '../redis-manager.js';
import { truncateString } from '../truncate.js';
import { jsonResult, runTool } from './common.js';

const MAX_LIMIT = 10_000;
const MAX_BATCH = 1_000;
const MAX_KEY_NAME_CHARS = 4_096;
const SCAN_CHAR_BUDGET = 1_000_000;

export const scanKeysInputSchema = z.object({
  pattern: z
    .string()
    .max(1_024)
    .default('*')
    .describe('Redis glob-style match pattern, for example "user:*" or "*:cache". Defaults to "*".'),
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
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(
      `Target number of keys per call (1-${MAX_LIMIT}). Defaults to the instance maxResultItems setting. ` +
        'The returned count can exceed this by one SCAN batch so that no keys are dropped.',
    ),
  cursor: z
    .union([z.string().regex(/^\d+$/).max(20), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
    .optional()
    .describe(
      'Opaque SCAN cursor returned by a previous call. Pass it back unchanged (prefer the string form) to continue scanning.',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe('SCAN COUNT hint per iteration. Values above 1000 are clamped to keep a single batch bounded.'),
  type: z
    .enum(['string', 'list', 'set', 'zset', 'hash', 'stream'])
    .optional()
    .describe('Only return keys of this type (Redis 6+ SCAN TYPE option).'),
});

export type ScanKeysArgs = z.infer<typeof scanKeysInputSchema>;

export function createScanKeysHandler(
  provider: RedisProvider,
): (args: ScanKeysArgs) => Promise<CallToolResult> {
  return (args) =>
    runTool(async () => {
      const instance = provider.resolveInstance(args.instance);
      const db = provider.resolveDb(instance, args.db);
      const limit = Math.min(args.limit ?? instance.maxResultItems, MAX_LIMIT);
      const count = Math.min(args.count ?? instance.scanCount, Math.max(1, limit), MAX_BATCH);

      const client = await provider.getClient(instance, db);

      const keys: string[] = [];
      const seen = new Set<string>();
      const returnedNames = new Set<string>();
      let cursor = args.cursor === undefined ? '0' : String(args.cursor);
      let iterations = 0;
      let scannedEntries = 0;
      let duplicateKeys = 0;
      let truncatedKeyNames = 0;
      let truncatedKeyCollisions = 0;
      let outputChars = 0;
      let charBudgetReached = false;
      const startedAt = performance.now();

      do {
        const scanArgs: (string | number)[] = ['MATCH', args.pattern, 'COUNT', count];
        if (args.type !== undefined) {
          scanArgs.push('TYPE', args.type);
        }

        const [nextCursor, batch] = await client.scan(cursor, ...scanArgs);
        cursor = String(nextCursor);
        iterations += 1;
        scannedEntries += batch.length;

        // Process the entire batch even after `limit` or the character budget is
        // reached. The SCAN cursor has already moved past this batch, so
        // dropping keys here would lose them permanently.
        for (const key of batch) {
          if (seen.has(key)) {
            duplicateKeys += 1;
            continue;
          }
          seen.add(key);

          const limitedKey = truncateString(key, MAX_KEY_NAME_CHARS);
          if (limitedKey.truncated) {
            truncatedKeyNames += 1;
          }

          if (returnedNames.has(limitedKey.value)) {
            truncatedKeyCollisions += 1;
            continue;
          }
          returnedNames.add(limitedKey.value);
          keys.push(limitedKey.value);
          outputChars += limitedKey.value.length;

          if (outputChars >= SCAN_CHAR_BUDGET) {
            charBudgetReached = true;
          }
        }
      } while (
        cursor !== '0' &&
        keys.length < limit &&
        !charBudgetReached &&
        iterations < instance.maxScanIterations &&
        performance.now() - startedAt < instance.scanTimeBudgetMs
      );

      const elapsedMs = Math.round(performance.now() - startedAt);
      const hasMore = cursor !== '0';
      const stoppedByIterationLimit = hasMore && iterations >= instance.maxScanIterations;
      const stoppedByTimeBudget = hasMore && elapsedMs >= instance.scanTimeBudgetMs;
      const notes: string[] = [];

      if (hasMore && keys.length >= limit) {
        notes.push(
          `Result limit (${limit}) reached; returned ${keys.length} key(s), rounded up to the SCAN batch boundary so no keys were dropped. Pass the returned cursor to continue.`,
        );
      }
      if (hasMore && charBudgetReached) {
        notes.push(
          `Result character budget (${SCAN_CHAR_BUDGET}) reached; returned the whole SCAN batch so no keys were dropped. Pass the returned cursor to continue.`,
        );
      }
      if (stoppedByIterationLimit) {
        notes.push(
          `Stopped after ${iterations} SCAN iterations (maxScanIterations=${instance.maxScanIterations}); pass the returned cursor to continue.`,
        );
      }
      if (stoppedByTimeBudget) {
        notes.push(
          `Stopped after ${elapsedMs} ms (scanTimeBudgetMs=${instance.scanTimeBudgetMs}); pass the returned cursor to continue.`,
        );
      }
      if (duplicateKeys > 0) {
        notes.push(`SCAN returned ${duplicateKeys} duplicate key name(s), which were removed.`);
      }
      if (truncatedKeyNames > 0) {
        notes.push(
          `${truncatedKeyNames} key name(s) exceeded ${MAX_KEY_NAME_CHARS} characters and were truncated; they may not be usable in follow-up calls.`,
        );
      }
      if (truncatedKeyCollisions > 0) {
        notes.push(
          `${truncatedKeyCollisions} distinct key name(s) collided after the ${MAX_KEY_NAME_CHARS}-character cap and were omitted; use a narrower pattern.`,
        );
      }

      return jsonResult({
        instance: instance.name,
        db,
        pattern: args.pattern,
        type: args.type ?? null,
        cursor,
        keys,
        returned: keys.length,
        limit,
        complete: cursor === '0',
        hasMore,
        scannedEntries,
        iterations,
        elapsedMs,
        outputChars,
        duplicateKeys,
        truncatedKeyNames,
        truncatedKeyCollisions,
        ...(notes.length === 0 ? {} : { notes }),
      });
    });
}
