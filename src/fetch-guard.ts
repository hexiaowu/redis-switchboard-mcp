import type { InstanceConfig } from './config.js';
import type { CommandArgs } from './commands.js';
import type { RedisClient } from './redis-manager.js';
import { CommandRejectedError, errorMessage } from './errors.js';

const MAX_SET_OPERATION_KEYS = 64;
const MAX_BULK_KEYS = 100;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = -MAX_SAFE_BIGINT;

/**
 * Guard the `execute` tool against commands that would materialize a huge reply
 * before the output truncator ever runs.
 *
 * The tool can still execute bounded forms of these commands (for example
 * LRANGE 0 99 or XRANGE key - + COUNT 100). Unbounded forms are rejected with a
 * pointer at the read_page tool.
 */
export async function enforceFetchLimit(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  switch (args[0]) {
    case 'GET':
    case 'GETDEL':
    case 'GETEX':
    case 'GETSET':
      await guardGet(client, args, instance);
      return;
    case 'HGET':
      await guardHGet(client, args, instance);
      return;
    case 'DUMP':
      await guardDump(client, args, instance);
      return;
    case 'GETRANGE':
    case 'SUBSTR':
      await guardStringRange(client, args, instance);
      return;
    case 'LRANGE':
      await guardListRange(client, args, instance);
      return;
    case 'HGETALL':
    case 'HKEYS':
    case 'HVALS':
      await guardBulkCollection(
        client,
        args,
        instance,
        args[0],
        'HLEN',
        'Use read_page kind="hash" or HSCAN with COUNT.',
      );
      return;
    case 'HSCAN':
    case 'SSCAN':
    case 'ZSCAN':
      guardScanCount(args, instance);
      return;
    case 'MGET':
      await guardMGet(client, args, instance);
      return;
    case 'HMGET':
      guardHMGet(args, instance);
      return;
    case 'SORT':
    case 'SORT_RO':
      await guardSortRo(client, args, instance);
      return;
    case 'ZUNION':
    case 'ZINTER':
    case 'ZDIFF':
      await guardZSetOperation(client, args, instance);
      return;
    case 'LCS':
      await guardLcs(client, args, instance);
      return;
    case 'GEOSEARCH':
    case 'GEORADIUS_RO':
    case 'GEORADIUSBYMEMBER_RO':
      await guardGeoSearch(client, args, instance);
      return;
    case 'SMEMBERS':
      await guardBulkCollection(
        client,
        args,
        instance,
        'SMEMBERS',
        'SCARD',
        'Use read_page kind="set" or SSCAN with COUNT.',
      );
      return;
    case 'ZRANGE':
    case 'ZREVRANGE':
      await guardZRange(client, args, instance);
      return;
    case 'ZRANGEBYSCORE':
    case 'ZREVRANGEBYSCORE':
    case 'ZRANGEBYLEX':
    case 'ZREVRANGEBYLEX':
      await guardZRangeBy(client, args, instance);
      return;
    case 'XRANGE':
    case 'XREVRANGE':
      await guardXRange(client, args, instance);
      return;
    case 'HRANDFIELD':
    case 'SRANDMEMBER':
    case 'ZRANDMEMBER':
      guardRandom(args, instance);
      return;
    case 'SINTER':
    case 'SUNION':
    case 'SDIFF':
      await guardSetOperation(client, args, instance);
      return;
    case 'LPOP':
    case 'RPOP':
    case 'SPOP':
    case 'ZPOPMIN':
    case 'ZPOPMAX':
      guardPopCount(args, instance);
      return;
    default:
      return;
  }
}

async function guardGet(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  if (key === undefined) {
    return;
  }

  const length = await numberReply(client, 'STRLEN', key);
  if (length !== null && length > instance.maxFetchChars) {
    throw new CommandRejectedError(
      `GET is rejected: the string is ${length} bytes (maxFetchChars=${instance.maxFetchChars}). ` +
        'Use GETRANGE or read_page kind="string" to fetch it in pages.',
    );
  }
}

async function guardHGet(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  const field = args[2];
  if (key === undefined || field === undefined) {
    return;
  }

  const length = await numberReply(client, 'HSTRLEN', key, field);
  if (length !== null && length > instance.maxFetchChars) {
    throw new CommandRejectedError(
      `HGET is rejected: the field value is ${length} bytes (maxFetchChars=${instance.maxFetchChars}). ` +
        'Use read_page kind="hash" or a smaller field.',
    );
  }
}

async function guardDump(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  if (key === undefined) {
    return;
  }

  const memory = await memoryUsage(client, key);
  if (memory !== null && memory > instance.maxFetchChars) {
    throw new CommandRejectedError(
      `DUMP is rejected: the key uses about ${memory} bytes (maxFetchChars=${instance.maxFetchChars}). ` +
        'Use a type-specific bounded read instead.',
    );
  }
}

async function guardStringRange(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  const start = parseInteger(args[2]);
  const stop = parseInteger(args[3]);
  if (key === undefined || start === null || stop === null) {
    return;
  }

  const length = await numberReply(client, 'STRLEN', key);
  if (length === null) {
    return;
  }

  const requested = resolveRange(length, start, stop);
  if (requested > instance.maxFetchChars) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: the requested range is ${requested} bytes (maxFetchChars=${instance.maxFetchChars}). ` +
        'Use a smaller range or read_page kind="string".',
    );
  }
}

async function guardListRange(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  const start = parseInteger(args[2]);
  const stop = parseInteger(args[3]);
  if (key === undefined || start === null || stop === null) {
    return;
  }

  const [length, memory] = await Promise.all([
    numberReply(client, 'LLEN', key),
    memoryUsage(client, key),
  ]);
  if (length === null) {
    return;
  }

  checkMemory('LRANGE', memory, instance, 'Use read_page kind="list" to fetch it in pages.');

  const requested = resolveRange(length, start, stop);
  if (requested > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `LRANGE is rejected: it would fetch ${requested} of ${length} list items (maxFetchItems=${instance.maxFetchItems}). ` +
        'Use read_page kind="list" or a smaller LRANGE range.',
    );
  }
}

async function guardBulkCollection(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
  command: string,
  sizeCommand: string,
  hint: string,
): Promise<void> {
  const key = args[1];
  if (key === undefined) {
    return;
  }

  const [size, memory] = await Promise.all([
    numberReply(client, sizeCommand, key),
    memoryUsage(client, key),
  ]);

  checkMemory(command, memory, instance, hint);
  if (size !== null && size > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${command} is rejected: it would fetch ${size} items (maxFetchItems=${instance.maxFetchItems}). ${hint}`,
    );
  }
}

function guardScanCount(args: CommandArgs, instance: InstanceConfig): void {
  // HSCAN/SSCAN/ZSCAN key cursor [MATCH pattern] [COUNT count] [NOVALUES].
  // Parse positionally so a MATCH pattern literally named COUNT cannot hide the
  // real COUNT option.
  let index = 3;

  while (index < args.length) {
    const token = args[index]!.toUpperCase();
    if (token === 'MATCH') {
      index += 2;
    } else if (token === 'COUNT') {
      const count = parseInteger(args[index + 1]);
      if (count !== null && count < 0) {
        throw new CommandRejectedError(
          `${args[0]} is rejected: COUNT ${count} is negative. Use a non-negative COUNT or read_page.`,
        );
      }
      if (count !== null && count > instance.maxFetchItems) {
        throw new CommandRejectedError(
          `${args[0]} is rejected: COUNT ${count} exceeds maxFetchItems=${instance.maxFetchItems}. ` +
            'Use a smaller COUNT or read_page.',
        );
      }
      index += 2;
    } else {
      index += 1;
    }
  }
}

async function guardMGet(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const keys = args.slice(1);
  if (keys.length === 0) {
    return;
  }
  if (keys.length > MAX_BULK_KEYS) {
    throw new CommandRejectedError(
      `MGET is rejected: ${keys.length} keys exceed the guard limit of ${MAX_BULK_KEYS}. ` +
        'Split the request or use read_page kind="string".',
    );
  }

  const lengths = await Promise.all(keys.map((key) => numberReply(client, 'STRLEN', key)));
  let total = 0;
  for (const length of lengths) {
    if (length === null) {
      continue;
    }
    if (length > instance.maxFetchChars) {
      throw new CommandRejectedError(
        `MGET is rejected: one value is ${length} bytes (maxFetchChars=${instance.maxFetchChars}). ` +
          'Use GETRANGE or read_page kind="string".',
      );
    }
    total += length;
    if (total > instance.maxFetchChars) {
      throw new CommandRejectedError(
        `MGET is rejected: the requested values total at least ${total} bytes ` +
          `(maxFetchChars=${instance.maxFetchChars}). Split the request or use read_page.`,
      );
    }
  }
}

function guardHMGet(args: CommandArgs, instance: InstanceConfig): void {
  if (args.length < 2) {
    return;
  }

  const fields = args.length - 2;
  if (fields > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `HMGET is rejected: ${fields} requested fields exceed maxFetchItems=${instance.maxFetchItems}. ` +
        'Use read_page kind="hash" or split the request.',
    );
  }
}

function findSortLimit(args: CommandArgs): number | null {
  let index = 2;

  while (index < args.length) {
    const token = args[index]!.toUpperCase();
    if (token === 'LIMIT') {
      const offset = parseInteger(args[index + 1]);
      const count = parseInteger(args[index + 2]);
      if (offset !== null && count !== null) {
        return count;
      }
      index += 3;
    } else if (token === 'BY' || token === 'GET' || token === 'STORE') {
      // Skip the pattern/destination argument; it may itself be named LIMIT.
      index += 2;
    } else {
      index += 1;
    }
  }

  return null;
}

async function guardSortRo(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  if (key === undefined) {
    return;
  }

  const sortLimit = findSortLimit(args);
  if (sortLimit !== null) {
    if (sortLimit < 0) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: LIMIT count ${sortLimit} means all remaining items. Use a non-negative count or read_page.`,
      );
    }
    if (sortLimit > instance.maxFetchItems) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: LIMIT count ${sortLimit} exceeds maxFetchItems=${instance.maxFetchItems}.`,
      );
    }
    return;
  }

  const type = await typeOf(client, key);
  const sizeCommand =
    type === 'list' ? 'LLEN' : type === 'set' ? 'SCARD' : type === 'zset' ? 'ZCARD' : null;

  const [length, memory] = await Promise.all([
    sizeCommand === null ? Promise.resolve(null) : numberReply(client, sizeCommand, key),
    memoryUsage(client, key),
  ]);

  checkMemory('SORT_RO', memory, instance, 'Use SORT_RO ... LIMIT or read_page.');
  if (length !== null && length > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `SORT_RO is rejected: the source has ${length} items (maxFetchItems=${instance.maxFetchItems}). ` +
        'Use SORT_RO ... LIMIT or read_page.',
    );
  }
}

async function guardZSetOperation(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const numKeys = parseInteger(args[1]);
  if (numKeys === null || numKeys <= 0) {
    return;
  }
  if (numKeys > MAX_SET_OPERATION_KEYS) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: ${numKeys} keys exceed the guard limit of ${MAX_SET_OPERATION_KEYS}.`,
    );
  }

  const keys = args.slice(2, 2 + numKeys);
  if (keys.length !== numKeys) {
    return;
  }

  const sizes = await Promise.all(keys.map((key) => numberReply(client, 'ZCARD', key)));
  if (sizes.some((size) => size === null)) {
    return;
  }
  const values = sizes as number[];

  let upperBound: number;
  if (args[0] === 'ZINTER') {
    upperBound = Math.min(...values);
  } else if (args[0] === 'ZUNION') {
    upperBound = values.reduce((total, value) => total + value, 0);
  } else {
    upperBound = values[0]!;
  }

  if (upperBound > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: the result can contain up to ${upperBound} members ` +
        `(maxFetchItems=${instance.maxFetchItems}). Use read_page kind="zset" or smaller inputs.`,
    );
  }
}

async function guardGeoSearch(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  if (key === undefined) {
    return;
  }

  const upper = args.map((arg) => arg.toUpperCase());
  const countIndex = upper.indexOf('COUNT');
  const count = countIndex === -1 ? null : parseInteger(args[countIndex + 1]);

  if (count !== null) {
    if (count < 0) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: COUNT ${count} is negative. Use a non-negative COUNT.`,
      );
    }
    if (count > instance.maxFetchItems) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: COUNT ${count} exceeds maxFetchItems=${instance.maxFetchItems}.`,
      );
    }
    return;
  }

  const cardinality = await numberReply(client, 'ZCARD', key);
  if (cardinality !== null && cardinality > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: without COUNT it can return up to ${cardinality} members ` +
        `(maxFetchItems=${instance.maxFetchItems}). Add COUNT or use read_page.`,
    );
  }
}

async function guardLcs(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const first = args[1];
  const second = args[2];
  if (first === undefined || second === undefined) {
    return;
  }

  const options = args.slice(3).map((arg) => arg.toUpperCase());
  if (options.includes('LEN')) {
    return;
  }

  const [firstLength, secondLength] = await Promise.all([
    numberReply(client, 'STRLEN', first),
    numberReply(client, 'STRLEN', second),
  ]);
  if (firstLength === null || secondLength === null) {
    return;
  }

  const upperBound = Math.min(firstLength, secondLength);
  if (upperBound > instance.maxFetchChars) {
    throw new CommandRejectedError(
      `LCS is rejected: it could return up to ${upperBound} bytes (maxFetchChars=${instance.maxFetchChars}). ` +
        'Use LCS ... LEN to get only the length, or compare smaller strings.',
    );
  }
}

async function guardZRange(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  if (key === undefined) {
    return;
  }

  const upper = args.map((arg) => arg.toUpperCase());
  const byScoreOrLex = upper.includes('BYSCORE') || upper.includes('BYLEX');
  // Options start after key/start/stop; a key literally named LIMIT is not an option.
  const limitIndex = upper.indexOf('LIMIT', 4);
  const [cardinality, memory] = await Promise.all([
    numberReply(client, 'ZCARD', key),
    memoryUsage(client, key),
  ]);

  checkMemory(args[0], memory, instance, 'Use read_page kind="zset" to fetch it in pages.');

  if (limitIndex !== -1) {
    const limitCount = parseInteger(args[limitIndex + 2]);
    if (limitCount !== null && limitCount < 0) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: LIMIT count ${limitCount} means all remaining members. Use a non-negative count or read_page.`,
      );
    }
    if (limitCount !== null && limitCount > instance.maxFetchItems) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: LIMIT count ${limitCount} exceeds maxFetchItems=${instance.maxFetchItems}.`,
      );
    }
    return;
  }

  if (byScoreOrLex) {
    if (cardinality !== null && cardinality > instance.maxFetchItems) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: a BYSCORE/BYLEX query without LIMIT can return up to ${cardinality} items ` +
          `(maxFetchItems=${instance.maxFetchItems}). Add LIMIT or use read_page kind="zset".`,
      );
    }
    return;
  }

  const start = parseInteger(args[2]);
  const stop = parseInteger(args[3]);
  if (start === null || stop === null || cardinality === null) {
    return;
  }

  const requested = resolveRange(cardinality, start, stop);
  if (requested > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: it would fetch ${requested} of ${cardinality} sorted-set members ` +
        `(maxFetchItems=${instance.maxFetchItems}). Use read_page kind="zset" or a smaller range.`,
    );
  }
}

async function guardZRangeBy(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  if (key === undefined) {
    return;
  }

  const upper = args.map((arg) => arg.toUpperCase());
  const limitIndex = upper.indexOf('LIMIT');
  const [cardinality, memory] = await Promise.all([
    numberReply(client, 'ZCARD', key),
    memoryUsage(client, key),
  ]);

  checkMemory(args[0], memory, instance, 'Use read_page kind="zset" to fetch it in pages.');

  if (limitIndex !== -1) {
    const limitCount = parseInteger(args[limitIndex + 2]);
    if (limitCount !== null && limitCount < 0) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: LIMIT count ${limitCount} means all remaining members. Use a non-negative count or read_page.`,
      );
    }
    if (limitCount !== null && limitCount > instance.maxFetchItems) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: LIMIT count ${limitCount} exceeds maxFetchItems=${instance.maxFetchItems}.`,
      );
    }
    return;
  }

  if (cardinality !== null && cardinality > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: it has no LIMIT and may return up to ${cardinality} items ` +
        `(maxFetchItems=${instance.maxFetchItems}). Add LIMIT or use read_page kind="zset".`,
    );
  }
}

async function guardXRange(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  if (key === undefined) {
    return;
  }

  const upper = args.map((arg) => arg.toUpperCase());
  const countIndex = upper.indexOf('COUNT');
  const [length, memory] = await Promise.all([
    numberReply(client, 'XLEN', key),
    memoryUsage(client, key),
  ]);

  checkMemory(args[0], memory, instance, 'Use read_page kind="stream" to fetch it in pages.');

  if (countIndex !== -1) {
    const count = parseInteger(args[countIndex + 1]);
    if (count !== null && count < 0) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: COUNT ${count} is negative. Use a non-negative COUNT or read_page.`,
      );
    }
    if (count !== null && count > instance.maxFetchItems) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: COUNT ${count} exceeds maxFetchItems=${instance.maxFetchItems}.`,
      );
    }
    return;
  }

  if (length !== null && length > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: without COUNT it can return up to ${length} stream entries ` +
        `(maxFetchItems=${instance.maxFetchItems}). Add COUNT or use read_page kind="stream".`,
    );
  }
}

function guardRandom(args: CommandArgs, instance: InstanceConfig): void {
  if (args.length < 3) {
    return;
  }

  const count = parseInteger(args[2]);
  if (count === null) {
    return;
  }

  if (count < 0) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: a negative count can return an unbounded number of duplicate items. ` +
        'Use a positive count or read_page.',
    );
  }
  if (count > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: count ${count} exceeds maxFetchItems=${instance.maxFetchItems}.`,
    );
  }
}

function guardPopCount(args: CommandArgs, instance: InstanceConfig): void {
  if (args.length < 3) {
    return;
  }

  const count = parseInteger(args[2]);
  if (count === null) {
    return;
  }
  if (count < 0) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: a negative count is not useful here. Use a positive count.`,
    );
  }
  if (count > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: count ${count} exceeds maxFetchItems=${instance.maxFetchItems}.`,
    );
  }
}

async function guardSetOperation(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const keys = args.slice(1);
  if (keys.length === 0) {
    return;
  }
  if (keys.length > MAX_SET_OPERATION_KEYS) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: ${keys.length} keys exceed the guard limit of ${MAX_SET_OPERATION_KEYS}. ` +
        'Split the operation or use smaller sets.',
    );
  }

  const sizes = await Promise.all(keys.map((key) => numberReply(client, 'SCARD', key)));
  if (sizes.some((size) => size === null)) {
    return;
  }
  const values = sizes as number[];

  let upperBound: number;
  if (args[0] === 'SINTER') {
    upperBound = Math.min(...values);
  } else if (args[0] === 'SUNION') {
    upperBound = values.reduce((total, value) => total + value, 0);
  } else {
    upperBound = values[0]!;
  }

  if (upperBound > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: the result can contain up to ${upperBound} members ` +
        `(maxFetchItems=${instance.maxFetchItems}). Use read_page kind="set" or smaller sets.`,
    );
  }
}

async function numberReply(
  client: RedisClient,
  command: string,
  ...args: (string | number)[]
): Promise<number | null> {
  try {
    const reply = await client.call(command, ...args);
    if (typeof reply === 'number') {
      return reply;
    }
    if (typeof reply === 'string') {
      const value = Number(reply);
      return Number.isFinite(value) ? value : null;
    }
    return null;
  } catch (error) {
    const message = errorMessage(error);
    if (/NOPERM|no permissions|permission denied/i.test(message)) {
      throw new CommandRejectedError(
        `Cannot verify the size of "${args[0] ?? ''}" because the Redis user cannot run ${command}: ${message}`,
      );
    }
    // Let the real command report WRONGTYPE and other errors.
    return null;
  }
}

async function typeOf(client: RedisClient, key: string): Promise<string | null> {
  try {
    const reply = await client.call('TYPE', key);
    return typeof reply === 'string' ? reply : null;
  } catch (error) {
    const message = errorMessage(error);
    if (/NOPERM|no permissions|permission denied/i.test(message)) {
      throw new CommandRejectedError(
        `Cannot verify the type of "${key}" because the Redis user cannot run TYPE: ${message}`,
      );
    }
    return null;
  }
}

async function memoryUsage(client: RedisClient, key: string): Promise<number | null> {
  try {
    const reply = await client.call('MEMORY', 'USAGE', key);
    return typeof reply === 'number' ? reply : null;
  } catch (error) {
    const message = errorMessage(error);
    if (/NOPERM|no permissions|permission denied|Command timed out/i.test(message)) {
      throw new CommandRejectedError(
        `Cannot verify the memory size of "${key}" because the Redis user cannot run MEMORY USAGE: ${message}`,
      );
    }
    // Older Redis versions may not support MEMORY USAGE; item-count checks still apply.
    return null;
  }
}

function checkMemory(
  command: string,
  bytes: number | null,
  instance: InstanceConfig,
  hint: string,
): void {
  if (bytes !== null && bytes > instance.maxFetchChars) {
    throw new CommandRejectedError(
      `${command} is rejected: the key uses about ${bytes} bytes (maxFetchChars=${instance.maxFetchChars}). ${hint}`,
    );
  }
}

function resolveRange(length: number, start: number, stop: number): number {
  let from = start < 0 ? length + start : start;
  let to = stop < 0 ? length + stop : stop;

  if (from < 0) {
    from = 0;
  }
  if (to >= length) {
    to = length - 1;
  }
  if (from >= length || to < 0 || to < from) {
    return 0;
  }
  return to - from + 1;
}

function parseInteger(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return null;
  }

  try {
    const normalized = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
    const parsed = BigInt(normalized);
    // Redis accepts signed 64-bit integers. JavaScript cannot represent all of
    // them exactly, so clamp to the safe range instead of treating them as
    // "not an integer" (which would let the command bypass every size check).
    if (parsed > MAX_SAFE_BIGINT) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (parsed < MIN_SAFE_BIGINT) {
      return -Number.MAX_SAFE_INTEGER;
    }
    return Number(parsed);
  } catch {
    return null;
  }
}
