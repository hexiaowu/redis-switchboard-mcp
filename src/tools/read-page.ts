import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RedisClient, RedisProvider } from '../redis-manager.js';
import { truncateString } from '../truncate.js';
import { jsonResult, runTool } from './common.js';

const MAX_PAGE_LIMIT = 1_000;
const DEFAULT_PAGE_LIMIT = 100;

export const readPageInputSchema = z.object({
  kind: z
    .enum(['list', 'hash', 'set', 'zset', 'stream', 'string'])
    .describe(
      'Collection type. list uses LRANGE, hash/set use HSCAN/SSCAN, zset uses ZRANGE, stream uses XRANGE, string uses GETRANGE.',
    ),
  key: z.string().min(1).max(4_096).describe('Key to read.'),
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
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .describe(
      `Page size (1-${MAX_PAGE_LIMIT}, default ${DEFAULT_PAGE_LIMIT}). For kind="string" this is the number of bytes. ` +
        'The effective size is also capped by maxFetchItems/maxFetchChars.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Zero-based offset for list and zset; byte offset for string pages.'),
  cursor: z
    .union([z.string().regex(/^\d+$/).max(20), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
    .optional()
    .describe('SCAN cursor for hash/set pages. Pass the returned nextCursor back unchanged.'),
  match: z.string().max(1_024).optional().describe('MATCH pattern for hash/set SCAN pages.'),
  withScores: z.boolean().default(false).describe('ZSET only: include scores in the result.'),
  start: z.string().max(128).optional().describe('STREAM only: start ID (default "-").'),
  end: z.string().max(128).optional().describe('STREAM only: end ID (default "+").'),
});

export type ReadPageArgs = z.infer<typeof readPageInputSchema>;

interface ReadPageNotes {
  notes: string[];
}

export function createReadPageHandler(
  provider: RedisProvider,
): (args: ReadPageArgs) => Promise<CallToolResult> {
  return (args) =>
    runTool(async () => {
      const instance = provider.resolveInstance(args.instance);
      const db = provider.resolveDb(instance, args.db);
      const client = await provider.getClient(instance, db);

      const perItem = args.kind === 'hash' || args.kind === 'stream' ? 2 : 1;
      const limitCap =
        args.kind === 'string'
          ? instance.maxFetchChars
          : Math.max(
              1,
              Math.floor(
                instance.maxFetchChars / (perItem * Math.max(1, instance.maxResultChars)),
              ),
            );
      const limit = Math.min(args.limit, instance.maxFetchItems, MAX_PAGE_LIMIT, limitCap);

      const notes: string[] = [];
      if (limit < args.limit) {
        notes.push(
          `Page limit reduced from ${args.limit} to ${limit} (maxFetchItems/maxFetchChars).`,
        );
      }

      let truncatedItems = 0;
      let outputBytes = 0;
      const limitString = (value: string): string => {
        const limited = truncateString(value, instance.maxResultChars);
        if (limited.truncated) {
          truncatedItems += 1;
        }
        outputBytes += Buffer.byteLength(limited.value, 'utf8');
        return limited.value;
      };

      const payload = await readPage(client, args, limit, limitString, { notes });
      const payloadOutputBytes =
        args.kind === 'string' ? Number(payload.returned ?? 0) : outputBytes;

      if (truncatedItems > 0) {
        notes.push(
          `${truncatedItems} item string(s) were truncated at maxResultChars=${instance.maxResultChars}.`,
        );
      }

      return jsonResult({
        instance: instance.name,
        db,
        kind: args.kind,
        key: args.key,
        limit,
        ...payload,
        outputBytes: payloadOutputBytes,
        ...(truncatedItems === 0 ? {} : { truncatedItems }),
        ...(notes.length === 0 ? {} : { notes }),
      });
    });
}

async function readPage(
  client: RedisClient,
  args: ReadPageArgs,
  limit: number,
  limitString: (value: string) => string,
  context: ReadPageNotes,
): Promise<Record<string, unknown>> {
  switch (args.kind) {
    case 'list':
      return readList(client, args, limit, limitString);
    case 'string':
      return readString(client, args, limit);
    case 'hash':
      return readHash(client, args, limit, limitString, context);
    case 'set':
      return readSet(client, args, limit, limitString, context);
    case 'zset':
      return readZset(client, args, limit, limitString);
    case 'stream':
      return readStream(client, args, limit, limitString);
  }
}

async function readList(
  client: RedisClient,
  args: ReadPageArgs,
  limit: number,
  limitString: (value: string) => string,
): Promise<Record<string, unknown>> {
  const offset = args.offset;
  const [reply, totalReply] = await Promise.all([
    client.call('LRANGE', args.key, offset, offset + limit - 1),
    client.call('LLEN', args.key),
  ]);

  const items = (reply as unknown[]).map((item) => limitString(String(item)));
  const total = toNumber(totalReply);
  const nextOffset = offset + items.length;

  return {
    items,
    offset,
    returned: items.length,
    total,
    nextOffset,
    complete: nextOffset >= total,
  };
}

async function readString(
  client: RedisClient,
  args: ReadPageArgs,
  limit: number,
): Promise<Record<string, unknown>> {
  const offset = args.offset;
  // GETRANGE/STRLEN use byte offsets. Fetch at least 4 bytes so a complete
  // multi-byte character can be returned for tiny limits.
  const window = Math.max(limit, 4);
  const [reply, totalReply] = await Promise.all([
    client.call('GETRANGE', args.key, offset, offset + window - 1),
    client.call('STRLEN', args.key),
  ]);

  let chunk = typeof reply === 'string' ? reply : '';
  // A page ending in the middle of a UTF-8 character decodes with a trailing
  // replacement character. Drop it and leave nextOffset at the start of the
  // incomplete character so the next page begins on a character boundary.
  while (chunk.endsWith('\uFFFD')) {
    chunk = chunk.slice(0, -1);
  }

  const total = toNumber(totalReply);
  const returnedBytes = Buffer.byteLength(chunk, 'utf8');
  const nextOffset = offset + returnedBytes;

  return {
    chunk,
    offset,
    returned: returnedBytes,
    total,
    nextOffset,
    complete: nextOffset >= total,
  };
}

async function readHash(
  client: RedisClient,
  args: ReadPageArgs,
  limit: number,
  limitString: (value: string) => string,
  context: ReadPageNotes,
): Promise<Record<string, unknown>> {
  const cursor = args.cursor === undefined ? '0' : String(args.cursor);
  const scanArgs: (string | number)[] = ['HSCAN', args.key, cursor, 'COUNT', limit];
  if (args.match !== undefined) {
    scanArgs.push('MATCH', args.match);
  }

  const [reply, totalReply] = await Promise.all([
    client.call(String(scanArgs[0]), ...scanArgs.slice(1)),
    client.call('HLEN', args.key),
  ]);
  const [nextCursor, flat] = reply as [string, string[]];

  const items: { field: string; value: string }[] = [];
  const seenFields = new Set<string>();
  let duplicateItems = 0;
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const field = flat[index]!;
    if (seenFields.has(field)) {
      duplicateItems += 1;
      continue;
    }
    seenFields.add(field);
    items.push({
      field: limitString(field),
      value: limitString(flat[index + 1]!),
    });
  }

  if (items.length > limit) {
    context.notes.push(
      `HSCAN returned ${items.length} entries for COUNT=${limit}; all were returned to avoid dropping fields.`,
    );
  }

  return {
    items,
    cursor: nextCursor,
    nextCursor,
    returned: items.length,
    total: toNumber(totalReply),
    complete: nextCursor === '0',
    ...(duplicateItems === 0 ? {} : { duplicateItems }),
  };
}

async function readSet(
  client: RedisClient,
  args: ReadPageArgs,
  limit: number,
  limitString: (value: string) => string,
  context: ReadPageNotes,
): Promise<Record<string, unknown>> {
  const cursor = args.cursor === undefined ? '0' : String(args.cursor);
  const scanArgs: (string | number)[] = ['SSCAN', args.key, cursor, 'COUNT', limit];
  if (args.match !== undefined) {
    scanArgs.push('MATCH', args.match);
  }

  const [reply, totalReply] = await Promise.all([
    client.call(String(scanArgs[0]), ...scanArgs.slice(1)),
    client.call('SCARD', args.key),
  ]);
  const [nextCursor, members] = reply as [string, string[]];
  const items: string[] = [];
  const seenMembers = new Set<string>();
  let duplicateItems = 0;
  for (const member of members) {
    if (seenMembers.has(member)) {
      duplicateItems += 1;
      continue;
    }
    seenMembers.add(member);
    items.push(limitString(member));
  }

  if (items.length > limit) {
    context.notes.push(
      `SSCAN returned ${items.length} members for COUNT=${limit}; all were returned to avoid dropping members.`,
    );
  }

  return {
    items,
    cursor: nextCursor,
    nextCursor,
    returned: items.length,
    total: toNumber(totalReply),
    complete: nextCursor === '0',
    ...(duplicateItems === 0 ? {} : { duplicateItems }),
  };
}

async function readZset(
  client: RedisClient,
  args: ReadPageArgs,
  limit: number,
  limitString: (value: string) => string,
): Promise<Record<string, unknown>> {
  const offset = args.offset;
  const rangeArgs: (string | number)[] = ['ZRANGE', args.key, offset, offset + limit - 1];
  if (args.withScores) {
    rangeArgs.push('WITHSCORES');
  }

  const [reply, totalReply] = await Promise.all([
    client.call(String(rangeArgs[0]), ...rangeArgs.slice(1)),
    client.call('ZCARD', args.key),
  ]);
  const flat = reply as string[];
  const items: unknown[] = [];

  if (args.withScores) {
    for (let index = 0; index + 1 < flat.length; index += 2) {
      items.push({
        member: limitString(flat[index]!),
        score: toScore(flat[index + 1] ?? ''),
      });
    }
  } else {
    for (const member of flat) {
      items.push(limitString(member));
    }
  }

  const total = toNumber(totalReply);
  const nextOffset = offset + items.length;

  return {
    items,
    offset,
    returned: items.length,
    total,
    nextOffset,
    complete: nextOffset >= total,
    withScores: args.withScores,
  };
}

async function readStream(
  client: RedisClient,
  args: ReadPageArgs,
  limit: number,
  limitString: (value: string) => string,
): Promise<Record<string, unknown>> {
  const start = args.start ?? '-';
  const end = args.end ?? '+';

  const [reply, totalReply] = await Promise.all([
    client.call('XRANGE', args.key, start, end, 'COUNT', limit),
    client.call('XLEN', args.key),
  ]);
  const entries = reply as [string, string[]][];

  const items = entries.map(([id, fields]) => {
    const pairs: [string, string][] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      pairs.push([limitString(fields[index]!), limitString(fields[index + 1]!)]);
    }
    return { id, fields: pairs };
  });

  const complete = items.length < limit;
  const last = items[items.length - 1];
  const nextStart = complete || last === undefined ? null : `(${last.id}`;

  return {
    items,
    start,
    end,
    nextStart,
    returned: items.length,
    total: toNumber(totalReply),
    complete,
  };
}

function toScore(value: string): number | string {
  const normalized = value.toLowerCase();
  if (normalized === 'inf' || normalized === '+inf') {
    return 'inf';
  }
  if (normalized === '-inf') {
    return '-inf';
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
