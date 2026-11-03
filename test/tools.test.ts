import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecuteHandler } from '../src/tools/execute.js';
import { createScanKeysHandler } from '../src/tools/scan-keys.js';
import { createKeyInfoHandler } from '../src/tools/key-info.js';
import { FakeClient, FakeProvider, makeInstance, resultJson } from './helpers.js';

test('execute passes the parsed command and selected database to the client', async () => {
  const client = new FakeClient();
  const provider = new FakeProvider(makeInstance({ name: 'test', allowedDbs: [0, 2, 4] }), client);
  const execute = createExecuteHandler(provider);

  const result = await execute({ command: 'SET greeting "hello world"', db: 2 });
  const json = resultJson(result);

  assert.equal(result.isError, undefined);
  assert.equal(json.instance, 'test');
  assert.equal(json.db, 2);
  assert.equal(json.command, 'SET');
  assert.equal(json.argCount, 2);
  assert.equal(json.reply, 'OK');
  assert.equal(json.truncated, false);
  assert.equal(provider.lastDb, 2);
  assert.deepEqual(client.calls, [{ command: 'SET', args: ['greeting', 'hello world'] }]);
});

test('execute accepts an argument array', async () => {
  const client = new FakeClient();
  const execute = createExecuteHandler(new FakeProvider(makeInstance(), client));

  await execute({ command: ['GET', 'key'], db: 4 });
  assert.deepEqual(client.calls, [
    { command: 'STRLEN', args: ['key'] },
    { command: 'GET', args: ['key'] },
  ]);
});

test('execute rejects writes in read-only mode without touching Redis', async () => {
  const client = new FakeClient();
  const execute = createExecuteHandler(new FakeProvider(makeInstance({ mode: 'readonly' }), client));

  const result = await execute({ command: 'SET key value' });
  const json = resultJson(result);

  assert.equal(result.isError, true);
  assert.equal(json.code, 'COMMAND_REJECTED');
  assert.match(String(json.error), /read-only mode/);
  assert.equal(client.calls.length, 0);
});

test('execute allows reads in read-only mode', async () => {
  const client = new FakeClient();
  client.callReply = 'value';
  const execute = createExecuteHandler(new FakeProvider(makeInstance({ mode: 'readonly' }), client));

  const result = await execute({ command: 'GET key' });
  assert.equal(result.isError, undefined);
  assert.equal(resultJson(result).reply, 'value');
});

test('execute rejects SELECT and other blocked commands', async () => {
  const client = new FakeClient();
  const execute = createExecuteHandler(new FakeProvider(makeInstance(), client));

  for (const command of ['SELECT 1', 'KEYS *', 'FLUSHALL', 'CONFIG GET maxmemory']) {
    const result = await execute({ command });
    assert.equal(result.isError, true, `${command} should be rejected`);
    assert.equal(resultJson(result).code, 'COMMAND_REJECTED');
  }
  assert.equal(client.calls.length, 0);
});

test('execute enforces the database allowlist', async () => {
  const client = new FakeClient();
  const provider = new FakeProvider(makeInstance({ allowedDbs: [0, 2] }), client);
  const execute = createExecuteHandler(provider);

  const result = await execute({ command: 'GET key', db: 4 });
  assert.equal(result.isError, true);
  assert.equal(resultJson(result).code, 'DB_ERROR');
  assert.equal(provider.lastDb, undefined);
  assert.equal(client.calls.length, 0);
});

test('execute reports command syntax errors', async () => {
  const client = new FakeClient();
  const execute = createExecuteHandler(new FakeProvider(makeInstance(), client));

  const result = await execute({ command: 'GET "unterminated' });
  assert.equal(result.isError, true);
  assert.equal(resultJson(result).code, 'COMMAND_SYNTAX');
  assert.equal(client.calls.length, 0);
});

test('execute truncates oversized replies', async () => {
  const client = new FakeClient();
  client.callReply = 'abcdefghijklmnop';
  const execute = createExecuteHandler(
    new FakeProvider(makeInstance({ maxResultChars: 5 }), client),
  );

  const json = resultJson(await execute({ command: 'GET key' }));
  assert.equal(json.reply, 'abcde');
  assert.equal(json.truncated, true);
  assert.match(String((json.notes as string[])[0]), /string truncated/);
});

test('execute reports unknown instances', async () => {
  const client = new FakeClient();
  const execute = createExecuteHandler(new FakeProvider(makeInstance({ name: 'known' }), client));

  const result = await execute({ command: 'PING', instance: 'other' });
  assert.equal(result.isError, true);
  assert.equal(resultJson(result).code, 'INSTANCE_ERROR');
});

test('execute leaves unknown commands to Redis in read-write mode', async () => {
  const client = new FakeClient();
  const execute = createExecuteHandler(new FakeProvider(makeInstance(), client));

  const result = await execute({ command: 'FOOBAR' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(client.calls, [{ command: 'FOOBAR', args: [] }]);
});

test('scan_keys iterates SCAN, deduplicates and returns the cursor', async () => {
  const client = new FakeClient();
  client.scanResults = [
    ['7', ['a', 'b', 'a']],
    ['0', ['c']],
  ];
  const instance = makeInstance({ maxResultItems: 10, maxResultChars: 20, scanCount: 50 });
  const provider = new FakeProvider(instance, client);
  const scan = createScanKeysHandler(provider);

  const result = await scan({ pattern: 'u:*', db: 2, limit: 10, count: 2, type: 'hash' });
  const json = resultJson(result);

  assert.equal(result.isError, undefined);
  assert.equal(client.scans.length, 2);
  assert.equal(client.scans[0]!.cursor, '0');
  assert.deepEqual(client.scans[0]!.args, ['MATCH', 'u:*', 'COUNT', 2, 'TYPE', 'hash']);
  assert.equal(client.scans[1]!.cursor, '7');
  assert.deepEqual(json.keys, ['a', 'b', 'c']);
  assert.equal(json.returned, 3);
  assert.equal(json.limit, 10);
  assert.equal(json.complete, true);
  assert.equal(json.hasMore, false);
  assert.equal(json.scannedEntries, 4);
  assert.equal(json.iterations, 2);
  assert.equal(json.duplicateKeys, 1);
  assert.equal(provider.lastDb, 2);
});

test('scan_keys returns the whole SCAN batch and loses no keys at the limit', async () => {
  const client = new FakeClient();
  client.scanResults = [['7', ['a', 'b', 'c']]];
  const scan = createScanKeysHandler(new FakeProvider(makeInstance(), client));

  const json = resultJson(await scan({ pattern: '*', limit: 2, count: 10 }));

  assert.deepEqual(client.scans[0]!.args, ['MATCH', '*', 'COUNT', 2]);
  assert.deepEqual(json.keys, ['a', 'b', 'c']);
  assert.equal(json.returned, 3);
  assert.equal(json.cursor, '7');
  assert.equal(json.hasMore, true);
  assert.equal(json.complete, false);
  assert.match(String((json.notes as string[])[0]), /rounded up to the SCAN batch boundary/);
});

test('scan_keys does not report completion while keys are still unreturned', async () => {
  const client = new FakeClient();
  client.scanResults = [['0', ['a', 'b', 'c', 'd', 'e']]];
  const scan = createScanKeysHandler(new FakeProvider(makeInstance(), client));

  const json = resultJson(await scan({ pattern: '*', limit: 2, count: 5 }));

  assert.deepEqual(json.keys, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(json.returned, 5);
  assert.equal(json.cursor, '0');
  assert.equal(json.complete, true);
  assert.equal(json.hasMore, false);
});

test('scan_keys stops at the configured iteration cap', async () => {
  const client = new FakeClient();
  client.scanResults = [
    ['1', ['a']],
    ['2', ['b']],
    ['0', ['c']],
  ];
  const scan = createScanKeysHandler(
    new FakeProvider(makeInstance({ maxScanIterations: 2 }), client),
  );

  const json = resultJson(await scan({ pattern: '*', limit: 10, count: 10 }));

  assert.equal(client.scans.length, 2);
  assert.deepEqual(json.keys, ['a', 'b']);
  assert.equal(json.cursor, '2');
  assert.equal(json.hasMore, true);
  assert.match(String(json.notes), /Stopped after 2 SCAN iterations/);
});

test('scan_keys accepts a numeric cursor and truncates very long key names', async () => {
  const client = new FakeClient();
  const longKey = 'k'.repeat(4_100);
  client.scanResults = [['0', [longKey, 'ab']]];
  const scan = createScanKeysHandler(new FakeProvider(makeInstance(), client));

  const json = resultJson(await scan({ pattern: '*', cursor: 7 }));
  const keys = json.keys as string[];
  assert.equal(client.scans[0]!.cursor, '7');
  assert.equal(keys[0]!.length, 4_096);
  assert.equal(keys[1], 'ab');
  assert.equal(json.truncatedKeyNames, 1);
  assert.match(String(json.notes), /exceeded 4096 characters/);
});

test('scan_keys reports truncation collisions separately from duplicate keys', async () => {
  const client = new FakeClient();
  const prefix = 'k'.repeat(4_096);
  client.scanResults = [['0', [`${prefix}a`, `${prefix}b`]]];
  const scan = createScanKeysHandler(new FakeProvider(makeInstance(), client));

  const json = resultJson(await scan({ pattern: '*' }));

  assert.equal((json.keys as string[]).length, 1);
  assert.equal(json.truncatedKeyNames, 2);
  assert.equal(json.truncatedKeyCollisions, 1);
  assert.match(String(json.notes), /collided after the 4096-character cap/);
});

test('scan_keys stops when the time budget is exhausted', async () => {
  const client = new FakeClient();
  client.scanDelayMs = 10;
  client.scanResults = [
    ['1', ['a']],
    ['2', ['b']],
    ['0', ['c']],
  ];
  const scan = createScanKeysHandler(
    new FakeProvider(makeInstance({ scanTimeBudgetMs: 5, maxScanIterations: 100 }), client),
  );

  const json = resultJson(await scan({ pattern: '*', limit: 10, count: 10 }));

  assert.equal(client.scans.length, 1);
  assert.deepEqual(json.keys, ['a']);
  assert.equal(json.cursor, '1');
  assert.equal(json.hasMore, true);
  assert.match(String(json.notes), /scanTimeBudgetMs=5/);
});

test('execute maps client timeouts to COMMAND_ERROR with a retry warning', async () => {
  const client = new FakeClient();
  client.callError = new Error('Command timed out');
  const execute = createExecuteHandler(new FakeProvider(makeInstance(), client));

  const result = await execute({ command: 'GET key' });
  const json = resultJson(result);

  assert.equal(result.isError, true);
  assert.equal(json.code, 'COMMAND_ERROR');
  assert.match(String(json.error), /may still have been executed/);
});

test('execute maps Redis reply errors to COMMAND_ERROR', async () => {
  const client = new FakeClient();
  client.callError = new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
  const execute = createExecuteHandler(new FakeProvider(makeInstance(), client));

  const result = await execute({ command: 'GET key' });
  const json = resultJson(result);

  assert.equal(result.isError, true);
  assert.equal(json.code, 'COMMAND_ERROR');
  assert.match(String(json.error), /WRONGTYPE/);
});

test('scan_keys surfaces Redis errors as tool errors', async () => {
  const client = new FakeClient();
  client.scanError = new Error('ERR scan failed');
  const scan = createScanKeysHandler(new FakeProvider(makeInstance(), client));

  const result = await scan({ pattern: '*' });
  assert.equal(result.isError, true);
  assert.match(String(resultJson(result).error), /scan failed/);
});

test('key_info returns metadata for an existing string key', async () => {
  const client = new FakeClient();
  client.typeReply = 'string';
  client.pttlReply = 1_500;
  client.memoryReply = 42;
  client.encodingReply = 'embstr';
  client.lengthReply = 5;
  const provider = new FakeProvider(makeInstance(), client);
  const info = createKeyInfoHandler(provider);

  const json = resultJson(await info({ key: 'user:1', db: 2 }));

  assert.equal(json.instance, 'test');
  assert.equal(json.db, 2);
  assert.equal(json.exists, true);
  assert.equal(json.type, 'string');
  assert.equal(json.ttlMs, 1_500);
  assert.equal(json.persistent, false);
  assert.equal(json.memoryUsageBytes, 42);
  assert.equal(json.encoding, 'embstr');
  assert.equal(json.length, 5);
  assert.equal(json.lengthUnit, 'bytes');
  assert.equal(provider.lastDb, 2);
});

test('key_info short-circuits for missing keys', async () => {
  const client = new FakeClient();
  client.typeReply = 'none';
  const info = createKeyInfoHandler(new FakeProvider(makeInstance(), client));

  const json = resultJson(await info({ key: 'missing' }));

  assert.equal(json.exists, false);
  assert.equal(json.type, 'none');
  assert.equal(client.calls.length, 0);
});

test('key_info reports persistent and expired keys', async () => {
  const client = new FakeClient();
  client.typeReply = 'string';
  client.pttlReply = -1;
  const info = createKeyInfoHandler(new FakeProvider(makeInstance(), client));
  const persistent = resultJson(await info({ key: 'a' }));
  assert.equal(persistent.ttlMs, null);
  assert.equal(persistent.persistent, true);

  client.pttlReply = -2;
  const expired = resultJson(await info({ key: 'b' }));
  assert.match(String(expired.note), /expired or was deleted/);
});

test('key_info uses the right length command and unit per type', async () => {
  const client = new FakeClient();
  client.typeReply = 'list';
  client.lengthReply = 7;
  const info = createKeyInfoHandler(new FakeProvider(makeInstance(), client));

  const json = resultJson(await info({ key: 'queue' }));
  assert.equal(json.type, 'list');
  assert.equal(json.length, 7);
  assert.equal(json.lengthUnit, 'items');
});

test('key_info degrades gracefully when optional commands fail', async () => {
  const client = new FakeClient();
  client.typeReply = 'string';
  client.memoryError = new Error('ERR unknown command MEMORY');
  client.lengthError = new Error('WRONGTYPE');
  const info = createKeyInfoHandler(new FakeProvider(makeInstance(), client));

  const result = await info({ key: 'key' });
  const json = resultJson(result);

  assert.equal(result.isError, undefined);
  assert.equal(json.memoryUsageBytes, null);
  assert.equal(json.length, null);
  assert.equal((json.warnings as string[]).length, 2);
});
