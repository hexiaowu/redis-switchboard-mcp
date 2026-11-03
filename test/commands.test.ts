import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCommandAllowed,
  isReadOnlyCommand,
  normalizeCommand,
  tokenizeCommand,
} from '../src/commands.js';

test('tokenizeCommand handles plain arguments and whitespace', () => {
  assert.deepEqual(tokenizeCommand('  GET   user:1  '), ['GET', 'user:1']);
  assert.deepEqual(tokenizeCommand('SET a b'), ['SET', 'a', 'b']);
});

test('tokenizeCommand handles single and double quotes', () => {
  assert.deepEqual(tokenizeCommand('SET greeting "hello world"'), ['SET', 'greeting', 'hello world']);
  assert.deepEqual(tokenizeCommand("SET greeting 'hello world'"), ['SET', 'greeting', 'hello world']);
  assert.deepEqual(tokenizeCommand('SET key ""'), ['SET', 'key', '']);
  assert.deepEqual(tokenizeCommand("SET key ''"), ['SET', 'key', '']);
  assert.deepEqual(tokenizeCommand('SET key "a \\"quoted\\" value"'), ['SET', 'key', 'a "quoted" value']);
  assert.deepEqual(tokenizeCommand("SET key 'it\\'s'"), ['SET', 'key', "it's"]);
});

test('tokenizeCommand handles backslash escapes', () => {
  assert.deepEqual(tokenizeCommand('SET key a\\ b'), ['SET', 'key', 'a b']);
  assert.deepEqual(tokenizeCommand('SET key "line\\nnext"'), ['SET', 'key', 'line\nnext']);
  assert.deepEqual(tokenizeCommand('SET key "\\x41\\x42"'), ['SET', 'key', 'AB']);
});

test('tokenizeCommand rejects malformed input', () => {
  assert.throws(() => tokenizeCommand('GET "unterminated'), /Unterminated double-quoted/);
  assert.throws(() => tokenizeCommand("GET 'unterminated"), /Unterminated single-quoted/);
  assert.throws(() => tokenizeCommand('GET trailing\\'), /trailing backslash/);
});

test('normalizeCommand uppercases the command and preserves arguments', () => {
  assert.deepEqual(normalizeCommand('get user:1'), ['GET', 'user:1']);
  assert.deepEqual(normalizeCommand(['set', 'key', '']), ['SET', 'key', '']);
  assert.deepEqual(normalizeCommand('  seT  key  value  '), ['SET', 'key', 'value']);
});

test('normalizeCommand recovers JSON-serialized command arrays', () => {
  // Some MCP clients stringify anyOf array parameters before sending them.
  assert.deepEqual(normalizeCommand('["GET", "user:1"]'), ['GET', 'user:1']);
  assert.deepEqual(normalizeCommand(' ["SMEMBERS","app_token_code:123"] '), ['SMEMBERS', 'app_token_code:123']);
  assert.deepEqual(normalizeCommand('["SET", "key", "a b c"]'), ['SET', 'key', 'a b c']);
  assert.deepEqual(normalizeCommand('["GET", "key with \\"quotes\\""]'), ['GET', 'key with "quotes"']);
});

test('normalizeCommand rejects non-string JSON arrays and malformed JSON', () => {
  assert.throws(() => normalizeCommand('[1, 2]'), /Invalid command name/);
  assert.throws(() => normalizeCommand('["GET", 1]'), /Invalid command name/);
  assert.throws(() => normalizeCommand('[GET, key]'), /Invalid command name/);
  assert.throws(() => normalizeCommand('"just a string"'), /Invalid command name/);
  assert.throws(() => normalizeCommand('{ "cmd": "GET" }'), /Invalid command name/);
  assert.throws(() => normalizeCommand('["GET"'), /Invalid command name/);
  assert.throws(() => normalizeCommand('[]'), /must not be empty/);
});

test('normalizeCommand never hijacks legitimate command lines', () => {
  // A command name can never start with '[', so JSON-array parsing only
  // applies to input that previously failed with "Invalid command name".
  assert.deepEqual(normalizeCommand('SET key "[not json]"'), ['SET', 'key', '[not json]']);
  assert.deepEqual(normalizeCommand('GET [some:key]'), ['GET', '[some:key]']);
});

test('normalizeCommand validates command names and sizes', () => {
  assert.throws(() => normalizeCommand(''), /must not be empty/);
  assert.throws(() => normalizeCommand([]), /must not be empty/);
  assert.throws(() => normalizeCommand(['', 'x']), /name must not be empty/);
  assert.throws(() => normalizeCommand(['BAD NAME', 'x']), /Invalid command name/);
  assert.throws(
    () =>
      normalizeCommand(
        Array.from({ length: 1_025 }, (_value, index) => (index === 0 ? 'GET' : 'x')),
      ),
    /too many arguments/,
  );
  assert.throws(() => normalizeCommand(['GET', 123 as unknown as string]), /must be a string/);
});

test('connection-level and destructive commands are always rejected', () => {
  const policy = { mode: 'readwrite', allowScripting: false } as const;
  const blocked = [
    'SELECT 2',
    'select 2',
    'MOVE a 2',
    'SWAPDB 0 1',
    'FLUSHDB',
    'FLUSHALL',
    'KEYS *',
    'SCAN 0 COUNT 100000000',
    'COPY source destination DB 5',
    'COPY source destination DB 5 REPLACE',
    'CONFIG GET maxmemory',
    'DEBUG SLEEP 1',
    'ACL LIST',
    'MODULE LIST',
    'CLIENT LIST',
    'CLUSTER INFO',
    'SHUTDOWN',
    'MULTI',
    'EXEC',
    'SUBSCRIBE channel',
    'MONITOR',
    'SAVE',
    'BGSAVE',
    'AUTH secret',
    'QUIT',
    'SCRIPT LOAD "return 1"',
    'FUNCTION LIST',
  ];

  for (const command of blocked) {
    assert.throws(
      () => assertCommandAllowed(normalizeCommand(command), policy),
      /rejected/,
      `expected ${command} to be rejected`,
    );
  }
});

test('blocking commands are rejected to protect the shared connection', () => {
  const policy = { mode: 'readwrite', allowScripting: false } as const;
  for (const command of [
    'BLPOP queue 0',
    'BRPOP queue 0',
    'BLMOVE a b LEFT RIGHT 0',
    'BZPOPMIN zset 0',
    'WAIT 0 0',
    'XREAD BLOCK 0 STREAMS s $',
  ]) {
    assert.throws(
      () => assertCommandAllowed(normalizeCommand(command), policy),
      /blocking commands/,
      `expected ${command} to be rejected`,
    );
  }
});

test('read-only mode only allows whitelisted commands', () => {
  const policy = { mode: 'readonly', allowScripting: false } as const;

  for (const command of [
    'GET key',
    'MGET a b',
    'HGETALL hash',
    'ZRANGE zset 0 -1',
    'SINTER a b',
    'XINFO STREAM stream',
    'INFO',
    'MEMORY USAGE key',
    'OBJECT ENCODING key',
    'SORT_RO list',
    'BITFIELD_RO key GET u8 0',
  ]) {
    assert.doesNotThrow(
      () => assertCommandAllowed(normalizeCommand(command), policy),
      `expected ${command} to be allowed in read-only mode`,
    );
  }

  for (const command of ['SET key value', 'HSET hash field value', 'DEL key', 'SORT list', 'GEORADIUS geo 0 0 1 km', 'MEMORY PURGE', 'FOOBAR']) {
    assert.throws(
      () => assertCommandAllowed(normalizeCommand(command), policy),
      /read-only mode/,
      `expected ${command} to be rejected in read-only mode`,
    );
  }
});

test('read-write mode allows unknown commands so Redis can report them', () => {
  assert.doesNotThrow(() =>
    assertCommandAllowed(normalizeCommand('FOOBAR'), { mode: 'readwrite', allowScripting: false }),
  );
});

test('COPY within the same database is allowed, COPY ... DB is rejected', () => {
  const policy = { mode: 'readwrite', allowScripting: false } as const;
  assert.doesNotThrow(() => assertCommandAllowed(normalizeCommand('COPY source destination'), policy));
  assert.doesNotThrow(() =>
    assertCommandAllowed(normalizeCommand('COPY source destination REPLACE'), policy),
  );
  assert.throws(
    () => assertCommandAllowed(normalizeCommand('COPY source destination DB 5'), policy),
    /COPY \.\.\. DB is rejected/,
  );
  assert.throws(
    () => assertCommandAllowed(normalizeCommand('COPY source destination REPLACE DB 5'), policy),
    /COPY \.\.\. DB is rejected/,
  );
});

test('scripting is opt-in and still blocked by read-only mode', () => {
  assert.throws(
    () =>
      assertCommandAllowed(normalizeCommand('EVAL "return 1" 0'), {
        mode: 'readwrite',
        allowScripting: false,
      }),
    /scripting is disabled/,
  );

  assert.doesNotThrow(() =>
    assertCommandAllowed(normalizeCommand('EVAL "return 1" 0'), {
      mode: 'readwrite',
      allowScripting: true,
    }),
  );

  assert.throws(
    () =>
      assertCommandAllowed(normalizeCommand('EVAL "return 1" 0'), {
        mode: 'readonly',
        allowScripting: true,
      }),
    /read-only mode/,
  );
});

test('isReadOnlyCommand recognizes the whitelist', () => {
  assert.equal(isReadOnlyCommand('get'), true);
  assert.equal(isReadOnlyCommand('GET'), true);
  assert.equal(isReadOnlyCommand('set'), false);
  assert.equal(isReadOnlyCommand('KEYS'), false);
});
