import type { InstanceConfig } from './config.js';
import type { CommandArgs } from './commands.js';
import type { RedisClient } from './redis-manager.js';
import { CommandRejectedError, errorMessage } from './errors.js';

const MAX_SET_OPERATION_KEYS = 64;
const MAX_BULK_KEYS = 100;
const MAX_HMGET_FIELDS = 100;
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
    case 'SET':
      await guardSet(client, args, instance);
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
    case 'LPOS':
      guardLPos(args, instance);
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
      await guardHMGet(client, args, instance);
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
    case 'GEORADIUS':
    case 'GEORADIUS_RO':
    case 'GEORADIUSBYMEMBER':
    case 'GEORADIUSBYMEMBER_RO':
      await guardGeoSearch(client, args, instance);
      return;
    case 'LMPOP':
    case 'ZMPOP':
      await guardMPop(client, args, instance);
      return;
    case 'XINFO':
      await guardXInfo(client, args, instance);
      return;
    case 'XPENDING':
      guardXPending(args, instance);
      return;
    case 'XAUTOCLAIM':
      guardXAutoClaim(args, instance);
      return;
    case 'XRANGE':
    case 'XREVRANGE':
      await guardXRange(client, args, instance);
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
    case 'HRANDFIELD':
    case 'SRANDMEMBER':
    case 'ZRANDMEMBER':
      await guardRandom(client, args, instance);
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
      await guardPopCount(client, args, instance);
      return;
    case 'MEMORY':
      guardMemory(args, instance);
      return;
    case 'COMMAND':
      guardCommand(args);
      return;
    case 'SLOWLOG':
      guardSlowLog(args, instance);
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

async function guardSet(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  // SET key value ... GET returns the old value unbounded, so the same STRLEN
  // check as guardGet applies. The GET option takes no value; scanning from
  // index 3 (after key/value) keeps a value literally named GET from matching.
  if (args[1] === undefined || findOptionIndex(args, 'GET', 3, false) === -1) {
    return;
  }

  const length = await numberReply(client, 'STRLEN', args[1]);
  if (length !== null && length > instance.maxFetchChars) {
    throw new CommandRejectedError(
      `SET ... GET is rejected: the old value is ${length} bytes (maxFetchChars=${instance.maxFetchChars}). ` +
        'Use GETRANGE or read_page kind="string" to fetch the old value in pages.',
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

async function guardHMGet(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  if (args.length < 2) {
    return;
  }

  const key = args[1];
  if (key === undefined) {
    return;
  }

  const fields = args.slice(2);
  if (fields.length === 0) {
    return;
  }

  if (fields.length > MAX_HMGET_FIELDS) {
    throw new CommandRejectedError(
      `HMGET is rejected: ${fields.length} requested fields exceed the guard limit of ${MAX_HMGET_FIELDS}. ` +
        'Use read_page kind="hash" or HSCAN with COUNT.',
    );
  }

  // Field count alone does not bound the reply: a single field value can be
  // hundreds of megabytes, so sum the field sizes before the command runs.
  const lengths = await Promise.all(fields.map((field) => numberReply(client, 'HSTRLEN', key, field)));
  let total = 0;
  for (const length of lengths) {
    if (length === null) {
      continue;
    }
    total += length;
    if (total > instance.maxFetchChars) {
      throw new CommandRejectedError(
        `HMGET is rejected: the requested fields total at least ${total} bytes ` +
          `(maxFetchChars=${instance.maxFetchChars}). Use read_page kind="hash" or fetch fewer fields.`,
      );
    }
  }

  const memory = await memoryUsage(client, key);
  checkMemory('HMGET', memory, instance, 'Use read_page kind="hash" to fetch it in pages.');
}

/**
 * Find the first occurrence of `token` at or after `from` and return its index.
 * When `requireIntegerValue` is set, the token only counts if the next argument
 * parses as an integer, so an argument literally named COUNT/LIMIT (a key, a
 * score, a member) cannot shadow the real option.
 */
function findOptionIndex(
  args: CommandArgs,
  token: string,
  from: number,
  requireIntegerValue: boolean,
): number {
  for (let index = Math.max(from, 0); index < args.length; index += 1) {
    if (args[index]!.toUpperCase() !== token) {
      continue;
    }
    if (!requireIntegerValue || parseInteger(args[index + 1]) !== null) {
      return index;
    }
  }
  return -1;
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

/**
 * Walk SORT/SORT_RO options the way findSortLimit does and report whether a
 * STORE or STOREDIST destination is present; those forms reply with a small
 * integer instead of the sorted elements.
 */
function sortHasStore(args: CommandArgs): boolean {
  let index = 2;

  while (index < args.length) {
    const token = args[index]!.toUpperCase();
    if (token === 'LIMIT') {
      index += 3;
    } else if (token === 'BY' || token === 'GET') {
      // Skip the pattern argument; it may itself be named STORE.
      index += 2;
    } else if (token === 'STORE' || token === 'STOREDIST') {
      return true;
    } else {
      index += 1;
    }
  }

  return false;
}

/**
 * Count the GET patterns of a SORT/SORT_RO command; each one multiplies the
 * number of values the reply contains. Returns the raw GET count.
 */
function countSortGets(args: CommandArgs): number {
  let gets = 0;
  let index = 2;

  while (index < args.length) {
    const token = args[index]!.toUpperCase();
    if (token === 'LIMIT') {
      index += 3;
    } else if (token === 'BY' || token === 'GET' || token === 'STORE' || token === 'STOREDIST') {
      if (token === 'GET') {
        gets += 1;
      }
      // Skip the pattern/destination argument; it may itself be named GET.
      index += 2;
    } else {
      index += 1;
    }
  }

  return gets;
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

  // SORT ... STORE / STOREDIST replies with the number of stored elements, so
  // the reply-size checks do not apply (the source is still read server-side).
  if (sortHasStore(args)) {
    const memory = await memoryUsage(client, key);
    checkMemory(args[0], memory, instance, 'Use a smaller source or read_page.');
    return;
  }

  const multiplier = 1 + countSortGets(args);
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
    if (sortLimit * multiplier > instance.maxFetchItems) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: LIMIT ${sortLimit} items × ${multiplier} GET patterns can return up to ` +
          `${sortLimit * multiplier} values (maxFetchItems=${instance.maxFetchItems}). ` +
          'Reduce the LIMIT or the number of GET patterns.',
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
  if (length !== null && length * multiplier > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: the source has ${length} items × ${multiplier} GET patterns, so up to ` +
        `${length * multiplier} values can be returned (maxFetchItems=${instance.maxFetchItems}). ` +
        'Use SORT_RO ... LIMIT, fewer GET patterns, or read_page.',
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

  const memories = await Promise.all(keys.map((key) => memoryUsage(client, key)));
  let totalMemory = 0;
  for (const memory of memories) {
    if (memory === null) {
      continue;
    }
    totalMemory += memory;
    if (totalMemory > instance.maxFetchChars) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: the input keys use about ${totalMemory} bytes in total ` +
          `(maxFetchChars=${instance.maxFetchChars}). Use read_page kind="zset" or smaller inputs.`,
      );
    }
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

  const command = args[0];
  // Options start after key lng lat radius unit / key member radius unit for
  // the GEORADIUS-family commands; GEOSEARCH grammar is variable, so scan from
  // the key with the "next token must be an integer" rule.
  const from = command === 'GEOSEARCH' ? 2 : 5;

  const memory = await memoryUsage(client, key);
  checkMemory(command, memory, instance, 'Add COUNT or use read_page.');

  // Only GEORADIUS/GEORADIUSBYMEMBER support STORE/STOREDIST; those forms reply
  // with a small integer instead of the matched members.
  if (
    (command === 'GEORADIUS' || command === 'GEORADIUSBYMEMBER') &&
    (findOptionIndex(args, 'STORE', from, false) !== -1 ||
      findOptionIndex(args, 'STOREDIST', from, false) !== -1)
  ) {
    return;
  }

  const countIndex = findOptionIndex(args, 'COUNT', from, true);
  const count = countIndex === -1 ? null : parseInteger(args[countIndex + 1]);

  if (count !== null) {
    if (count < 0) {
      throw new CommandRejectedError(
        `${command} is rejected: COUNT ${count} is negative. Use a non-negative COUNT.`,
      );
    }
    if (count > instance.maxFetchItems) {
      throw new CommandRejectedError(
        `${command} is rejected: COUNT ${count} exceeds maxFetchItems=${instance.maxFetchItems}.`,
      );
    }
    return;
  }

  const cardinality = await numberReply(client, 'ZCARD', key);
  if (cardinality !== null && cardinality > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${command} is rejected: without COUNT it can return up to ${cardinality} members ` +
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

  // Options start after key/min/max; a key or score literally named LIMIT must
  // not shadow the real option, so require the next token to be an integer.
  const limitIndex = findOptionIndex(args, 'LIMIT', 4, true);
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

  // Options start after key/start/end; a key literally named COUNT must not
  // shadow the real option, so require the next token to be an integer.
  const countIndex = findOptionIndex(args, 'COUNT', 4, true);
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

async function guardRandom(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  if (key === undefined) {
    return;
  }

  if (args.length >= 3) {
    const count = parseInteger(args[2]);
    if (count !== null) {
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
  }

  // A single hash field or set member can itself be hundreds of megabytes.
  const memory = await memoryUsage(client, key);
  checkMemory(args[0], memory, instance, 'Use read_page or a smaller count.');
}

async function guardPopCount(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  const key = args[1];
  if (key === undefined) {
    return;
  }

  if (args.length >= 3) {
    const count = parseInteger(args[2]);
    if (count !== null) {
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
  }

  // A single popped element can itself be hundreds of megabytes.
  const memory = await memoryUsage(client, key);
  checkMemory(args[0], memory, instance, 'Use read_page or a smaller count.');
}

function guardLPos(args: CommandArgs, instance: InstanceConfig): void {
  // LPOS key element [RANK rank] [COUNT count] [MAXLEN len]; the element sits
  // at args[2], so options start at index 3. COUNT 0 returns all matches.
  const countIndex = findOptionIndex(args, 'COUNT', 3, true);
  if (countIndex === -1) {
    return;
  }

  const count = parseInteger(args[countIndex + 1]);
  if (count === null) {
    return;
  }
  if (count === 0) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: COUNT 0 returns all matches. ` +
        `Use a positive COUNT up to maxFetchItems=${instance.maxFetchItems} or read_page kind="list".`,
    );
  }
  if (count < 0) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: COUNT ${count} is negative. Use a positive COUNT or read_page kind="list".`,
    );
  }
  if (count > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: COUNT ${count} exceeds maxFetchItems=${instance.maxFetchItems}.`,
    );
  }
}

async function guardMPop(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  // LMPOP/ZMPOP nkeys key [key ...] LEFT|RIGHT [COUNT count]; the first key is
  // args[2] and the COUNT option cannot appear before index 4.
  const key = args[2];
  if (key === undefined) {
    return;
  }

  const memory = await memoryUsage(client, key);
  checkMemory(args[0], memory, instance, 'Use read_page kind="list" or kind="zset" to inspect the source.');

  const countIndex = findOptionIndex(args, 'COUNT', 4, true);
  if (countIndex === -1) {
    return;
  }

  const count = parseInteger(args[countIndex + 1]);
  if (count !== null && count > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: COUNT ${count} exceeds maxFetchItems=${instance.maxFetchItems}.`,
    );
  }
}

async function guardXInfo(
  client: RedisClient,
  args: CommandArgs,
  instance: InstanceConfig,
): Promise<void> {
  // XINFO CONSUMERS/GROUPS replies are small; only the STREAM subcommand can
  // serialize the whole stream (via FULL).
  if (args[1]?.toUpperCase() !== 'STREAM' || args[2] === undefined) {
    return;
  }

  const memory = await memoryUsage(client, args[2]);
  checkMemory('XINFO', memory, instance, 'Use XLEN or read_page kind="stream" instead.');

  if (findOptionIndex(args, 'FULL', 3, false) === -1) {
    return;
  }

  const countIndex = findOptionIndex(args, 'COUNT', 3, true);
  if (countIndex === -1) {
    return;
  }

  const count = parseInteger(args[countIndex + 1]);
  if (count === null) {
    return;
  }
  if (count === 0) {
    throw new CommandRejectedError(
      `XINFO is rejected: FULL COUNT 0 returns all stream entries. ` +
        `Use a positive COUNT up to maxFetchItems=${instance.maxFetchItems} or read_page kind="stream".`,
    );
  }
  if (count > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `XINFO is rejected: FULL COUNT ${count} exceeds maxFetchItems=${instance.maxFetchItems}.`,
    );
  }
}

function guardXPending(args: CommandArgs, instance: InstanceConfig): void {
  // Summary form XPENDING key group is a small reply; allow it.
  if (args.length <= 3) {
    return;
  }

  // Extended form: XPENDING key group [IDLE ms] start end count [consumer].
  let index = 3;
  if (args[index]!.toUpperCase() === 'IDLE') {
    index += 2;
  }

  const count = parseInteger(args[index + 2]);
  if (count === null) {
    return;
  }
  if (count > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: ${count} pending entries exceed maxFetchItems=${instance.maxFetchItems}. ` +
        'Use a smaller count or read_page kind="stream".',
    );
  }
}

function guardXAutoClaim(args: CommandArgs, instance: InstanceConfig): void {
  // XAUTOCLAIM key group consumer min-idle [start] [COUNT count] [JUSTID].
  // Scanning from index 4 keeps a consumer literally named COUNT from
  // matching against its own min-idle argument.
  const countIndex = findOptionIndex(args, 'COUNT', 4, true);
  if (countIndex === -1) {
    return;
  }

  const count = parseInteger(args[countIndex + 1]);
  if (count !== null && count > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `${args[0]} is rejected: COUNT ${count} exceeds maxFetchItems=${instance.maxFetchItems}.`,
    );
  }
}

function guardMemory(args: CommandArgs, instance: InstanceConfig): void {
  // Other MEMORY subcommands (STATS, DOCTOR, ...) reply with small summaries.
  if (args[1]?.toUpperCase() !== 'USAGE' || args[2] === undefined) {
    return;
  }

  const samplesIndex = findOptionIndex(args, 'SAMPLES', 3, true);
  if (samplesIndex === -1) {
    return;
  }

  const samples = parseInteger(args[samplesIndex + 1]);
  if (samples !== null && samples <= 0) {
    throw new CommandRejectedError(
      `MEMORY USAGE is rejected: SAMPLES ${samples} estimates every internal sample, which is O(N) server work. ` +
        'Use a small positive SAMPLES count.',
    );
  }
}

function guardCommand(args: CommandArgs): void {
  // The full command table (LIST/DOCS/INFO) is well over 1 MB; only the small
  // subcommands are allowed through.
  const subcommand = args[1]?.toUpperCase();
  if (subcommand === 'COUNT' || subcommand === 'GETKEYS' || subcommand === 'GETKEYSANDFLAGS') {
    return;
  }

  throw new CommandRejectedError(
    'COMMAND is rejected: the full command table (LIST/DOCS/INFO) is large. ' +
      'Use COMMAND COUNT, COMMAND GETKEYS or COMMAND GETKEYSANDFLAGS instead.',
  );
}

function guardSlowLog(args: CommandArgs, instance: InstanceConfig): void {
  // SLOWLOG LEN replies with a small integer.
  if (args[1]?.toUpperCase() !== 'GET') {
    return;
  }

  const count = parseInteger(args[2]);
  if (count !== null && count > instance.maxFetchItems) {
    throw new CommandRejectedError(
      `SLOWLOG GET is rejected: ${count} entries exceed maxFetchItems=${instance.maxFetchItems}. ` +
        'Use a smaller count.',
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

  const memories = await Promise.all(keys.map((key) => memoryUsage(client, key)));
  let totalMemory = 0;
  for (const memory of memories) {
    if (memory === null) {
      continue;
    }
    totalMemory += memory;
    if (totalMemory > instance.maxFetchChars) {
      throw new CommandRejectedError(
        `${args[0]} is rejected: the input sets use about ${totalMemory} bytes in total ` +
          `(maxFetchChars=${instance.maxFetchChars}). Use read_page kind="set" or smaller sets.`,
      );
    }
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
    if (/Command timed out/i.test(message)) {
      throw new CommandRejectedError(
        `Cannot verify the size of "${args[0] ?? ''}" because ${command} timed out: ${message}`,
      );
    }
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
    if (/Command timed out/i.test(message)) {
      throw new CommandRejectedError(
        `Cannot verify the type of "${key}" because TYPE timed out: ${message}`,
      );
    }
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
    if (/Command timed out/i.test(message)) {
      throw new CommandRejectedError(
        `Cannot verify the memory size of "${key}" because MEMORY USAGE timed out: ${message}`,
      );
    }
    if (/NOPERM|no permissions|permission denied/i.test(message)) {
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
