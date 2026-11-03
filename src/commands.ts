import type { PermissionMode } from './config.js';
import { CommandRejectedError, CommandSyntaxError } from './errors.js';

export type CommandArgs = [string, ...string[]];

export interface CommandPolicy {
  mode: PermissionMode;
  allowScripting: boolean;
}

const MAX_COMMAND_ARGS = 1_024;
const MAX_COMMAND_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_NAME_LENGTH = 64;

/**
 * Commands that are rejected regardless of read-write mode.
 *
 * The main themes are: connection-level state (SELECT, MULTI, SUBSCRIBE), server
 * administration (CONFIG, ACL, MODULE), destructive/topology operations, and
 * commands that can block a shared connection indefinitely.
 */
const ALWAYS_BLOCKED = new Map<string, string>([
  ['SELECT', 'logical database selection is handled by the `db` argument; SELECT is connection-level state that would leak between requests'],
  ['MOVE', 'cross-database key moves are not exposed; call the tool again with a different `db`'],
  ['SWAPDB', 'swapping entire logical databases is not exposed'],
  ['FLUSHDB', 'destructive commands are not exposed by this server'],
  ['FLUSHALL', 'destructive commands are not exposed by this server'],
  ['KEYS', 'KEYS blocks the server; use the scan_keys tool instead'],
  ['SCAN', 'raw SCAN can bypass the scan limit, iteration and time budgets; use the scan_keys tool instead'],
  ['SHUTDOWN', 'SHUTDOWN is not exposed by this server'],
  ['CONFIG', 'server configuration access is not exposed'],
  ['DEBUG', 'DEBUG can crash or stall the server'],
  ['ACL', 'ACL administration is not exposed'],
  ['MODULE', 'MODULE loads native code into the server'],
  ['CLIENT', 'CLIENT commands can kill or rename connections'],
  ['MIGRATE', 'key migration is not exposed'],
  ['REPLICAOF', 'replication topology changes are not exposed'],
  ['SLAVEOF', 'replication topology changes are not exposed'],
  ['FAILOVER', 'replication topology changes are not exposed'],
  ['CLUSTER', 'cluster administration is not exposed; this server connects to a single node'],
  ['READONLY', 'cluster connection mode changes are not exposed'],
  ['READWRITE', 'cluster connection mode changes are not exposed'],
  ['ASKING', 'cluster connection mode changes are not exposed'],
  ['REPLCONF', 'replication protocol commands are not exposed'],
  ['SYNC', 'replication protocol commands are not exposed'],
  ['PSYNC', 'replication protocol commands are not exposed'],
  ['MONITOR', 'MONITOR changes the connection into streaming mode'],
  ['SUBSCRIBE', 'pub/sub mode changes the connection state'],
  ['PSUBSCRIBE', 'pub/sub mode changes the connection state'],
  ['SSUBSCRIBE', 'pub/sub mode changes the connection state'],
  ['UNSUBSCRIBE', 'pub/sub mode changes the connection state'],
  ['PUNSUBSCRIBE', 'pub/sub mode changes the connection state'],
  ['SUNSUBSCRIBE', 'pub/sub mode changes the connection state'],
  ['MULTI', 'transaction state is connection-level and would leak between requests'],
  ['EXEC', 'transaction state is connection-level and would leak between requests'],
  ['DISCARD', 'transaction state is connection-level and would leak between requests'],
  ['WATCH', 'transaction state is connection-level and would leak between requests'],
  ['UNWATCH', 'transaction state is connection-level and would leak between requests'],
  ['RESET', 'connection lifecycle commands are managed by this server'],
  ['HELLO', 'connection protocol changes are managed by this server'],
  ['AUTH', 'authentication is configured by the server, not per tool call'],
  ['QUIT', 'connection lifecycle commands are managed by this server'],
  ['SCRIPT', 'script administration is not exposed'],
  ['FUNCTION', 'function administration is not exposed'],
  ['SAVE', 'server-wide persistence operations are not exposed'],
  ['BGSAVE', 'server-wide persistence operations are not exposed'],
  ['BGREWRITEAOF', 'server-wide persistence operations are not exposed'],
  ['BLPOP', 'blocking commands can hold the shared connection and stall later requests; use a non-blocking variant'],
  ['BRPOP', 'blocking commands can hold the shared connection and stall later requests; use a non-blocking variant'],
  ['BRPOPLPUSH', 'blocking commands can hold the shared connection and stall later requests; use a non-blocking variant'],
  ['BLMOVE', 'blocking commands can hold the shared connection and stall later requests; use a non-blocking variant'],
  ['BLMPOP', 'blocking commands can hold the shared connection and stall later requests; use a non-blocking variant'],
  ['BZPOPMIN', 'blocking commands can hold the shared connection and stall later requests; use a non-blocking variant'],
  ['BZPOPMAX', 'blocking commands can hold the shared connection and stall later requests; use a non-blocking variant'],
  ['BZMPOP', 'blocking commands can hold the shared connection and stall later requests; use a non-blocking variant'],
  ['WAIT', 'blocking commands can hold the shared connection and stall later requests'],
  ['WAITAOF', 'blocking commands can hold the shared connection and stall later requests'],
  ['XREAD', 'blocking commands can hold the shared connection and stall later requests; use XRANGE'],
  ['XREADGROUP', 'blocking commands can hold the shared connection and mutate consumer-group state; use XRANGE/XPENDING'],
]);

const SCRIPTING_COMMANDS = new Set([
  'EVAL',
  'EVALSHA',
  'EVAL_RO',
  'EVALSHA_RO',
  'FCALL',
  'FCALL_RO',
]);

/**
 * Read-only command whitelist. Unknown commands are rejected in read-only mode,
 * so this list is intentionally explicit.
 */
const READ_ONLY_COMMANDS = new Set([
  // Connection / server metadata
  'PING',
  'ECHO',
  'TIME',
  'INFO',
  'DBSIZE',
  'LASTSAVE',
  'RANDOMKEY',
  'COMMAND',
  'LOLWUT',
  'MEMORY',
  'OBJECT',
  // Generic key metadata
  'EXISTS',
  'TYPE',
  'TTL',
  'PTTL',
  'EXPIRETIME',
  'PEXPIRETIME',
  'DUMP',
  // Strings
  'GET',
  'MGET',
  'STRLEN',
  'GETRANGE',
  'SUBSTR',
  'GETBIT',
  'BITCOUNT',
  'BITPOS',
  'BITFIELD_RO',
  // Lists
  'LLEN',
  'LRANGE',
  'LINDEX',
  'LPOS',
  // Hashes
  'HGET',
  'HMGET',
  'HGETALL',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HEXISTS',
  'HSTRLEN',
  'HRANDFIELD',
  'HSCAN',
  // Sets
  'SCARD',
  'SMEMBERS',
  'SISMEMBER',
  'SMISMEMBER',
  'SRANDMEMBER',
  'SINTER',
  'SUNION',
  'SDIFF',
  'SINTERCARD',
  'SSCAN',
  // Sorted sets
  'ZCARD',
  'ZCOUNT',
  'ZLEXCOUNT',
  'ZSCORE',
  'ZMSCORE',
  'ZRANGE',
  'ZRANGEBYLEX',
  'ZRANGEBYSCORE',
  'ZREVRANGE',
  'ZREVRANGEBYLEX',
  'ZREVRANGEBYSCORE',
  'ZRANK',
  'ZREVRANK',
  'ZRANDMEMBER',
  'ZINTER',
  'ZUNION',
  'ZDIFF',
  'ZINTERCARD',
  'ZSCAN',
  // Streams
  'XLEN',
  'XRANGE',
  'XREVRANGE',
  'XINFO',
  'XPENDING',
  // HyperLogLog
  'PFCOUNT',
  // Geospatial
  'GEOPOS',
  'GEODIST',
  'GEOHASH',
  'GEOSEARCH',
  'GEORADIUS_RO',
  'GEORADIUSBYMEMBER_RO',
  // Misc read-only
  'LCS',
  'SORT_RO',
]);

/**
 * Parse a Redis command line into argv. Supports single quotes, double quotes
 * and backslash escapes, mirroring redis-cli's common cases.
 */
export function tokenizeCommand(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: 'single' | 'double' | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (quote === 'single') {
      if (char === '\\' && input[index + 1] === "'") {
        current += "'";
        index += 1;
      } else if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      started = true;
      continue;
    }

    if (quote === 'double') {
      if (char === '\\') {
        const next = input[index + 1];
        if (next === undefined) {
          throw new CommandSyntaxError('Command ends with a trailing backslash.');
        }
        if (next === 'x' && isHexDigit(input[index + 2]) && isHexDigit(input[index + 3])) {
          current += String.fromCharCode(Number.parseInt(input.slice(index + 2, index + 4), 16));
          index += 3;
        } else {
          current += unescapeDoubleQuoted(next);
          index += 1;
        }
      } else if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      started = true;
      continue;
    }

    if (char === "'") {
      quote = 'single';
      started = true;
      continue;
    }
    if (char === '"') {
      quote = 'double';
      started = true;
      continue;
    }
    if (char === '\\') {
      const next = input[index + 1];
      if (next === undefined) {
        throw new CommandSyntaxError('Command ends with a trailing backslash.');
      }
      current += next;
      index += 1;
      started = true;
      continue;
    }
    if (isWhitespace(char)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (quote !== null) {
    throw new CommandSyntaxError(`Unterminated ${quote}-quoted argument.`);
  }
  if (started) {
    args.push(current);
  }
  return args;
}

export function normalizeCommand(command: string | readonly string[]): CommandArgs {
  const rawArgs = typeof command === 'string' ? tokenizeCommand(command) : [...command];

  if (rawArgs.length === 0) {
    throw new CommandSyntaxError('Command must not be empty.');
  }
  if (rawArgs.length > MAX_COMMAND_ARGS) {
    throw new CommandSyntaxError(`Command has too many arguments (${rawArgs.length}); the maximum is ${MAX_COMMAND_ARGS}.`);
  }

  const first = rawArgs[0];
  if (typeof first !== 'string') {
    throw new CommandSyntaxError('Every command argument must be a string.');
  }

  const name = first.trim().toUpperCase();
  if (name === '') {
    throw new CommandSyntaxError('Command name must not be empty.');
  }
  if (name.length > MAX_COMMAND_NAME_LENGTH) {
    throw new CommandSyntaxError(`Command name is too long (${name.length} characters).`);
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new CommandSyntaxError(`Invalid command name "${name}".`);
  }

  const args: string[] = [name];
  let totalBytes = Buffer.byteLength(name, 'utf8');

  for (let index = 1; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (typeof arg !== 'string') {
      throw new CommandSyntaxError('Every command argument must be a string.');
    }
    totalBytes += Buffer.byteLength(arg, 'utf8');
    args.push(arg);
  }

  if (totalBytes > MAX_COMMAND_BYTES) {
    throw new CommandSyntaxError(`Command payload is too large (${totalBytes} bytes); the maximum is ${MAX_COMMAND_BYTES} bytes.`);
  }

  return args as CommandArgs;
}

export function assertCommandAllowed(args: CommandArgs, policy: CommandPolicy): void {
  const name = args[0];

  const blockedReason = ALWAYS_BLOCKED.get(name);
  if (blockedReason !== undefined) {
    throw new CommandRejectedError(`${name} is rejected: ${blockedReason}.`);
  }

  if (SCRIPTING_COMMANDS.has(name) && !policy.allowScripting) {
    throw new CommandRejectedError(
      `${name} is rejected: server-side scripting is disabled by default. Set "allowScripting": true (or REDIS_ALLOW_SCRIPTING=1) to enable EVAL/EVALSHA/FCALL.`,
    );
  }

  if (name === 'COPY') {
    // COPY source destination [DB destination-db] [REPLACE]. Options start at
    // index 3; a key literally named "DB" can only appear at index 1 or 2.
    for (let index = 3; index < args.length; index += 1) {
      if (args[index]?.toUpperCase() === 'DB') {
        throw new CommandRejectedError(
          'COPY ... DB is rejected: it writes to another logical database and bypasses the per-call `db` argument and allowedDbs.',
        );
      }
    }
  }

  if (policy.mode === 'readonly' && name === 'MEMORY' && (args[1] ?? '').toUpperCase() === 'PURGE') {
    throw new CommandRejectedError('MEMORY PURGE is not allowed in read-only mode.');
  }

  if (policy.mode === 'readonly' && !READ_ONLY_COMMANDS.has(name)) {
    throw new CommandRejectedError(
      `${name} is not allowed in read-only mode. Only read-only commands (GET, MGET, HGETALL, ZRANGE, HSCAN, INFO, ...) are accepted.`,
    );
  }
}

export function isReadOnlyCommand(name: string): boolean {
  return READ_ONLY_COMMANDS.has(name.toUpperCase());
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isHexDigit(char: string | undefined): boolean {
  return char !== undefined && /^[0-9a-fA-F]$/.test(char);
}

function unescapeDoubleQuoted(char: string): string {
  switch (char) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'b':
      return '\b';
    case 'a':
      return '\x07';
    default:
      return char;
  }
}
