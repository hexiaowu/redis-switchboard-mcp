import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadPageHandler, readPageInputSchema } from '../src/tools/read-page.js';
import { FakeClient, FakeProvider, makeInstance, resultJson } from './helpers.js';

test('read_page pages a list with LRANGE and a next offset', async () => {
  const client = new FakeClient();
  client.commandReplies.LRANGE = ['a', 'b', 'c'];
  client.commandReplies.LLEN = 10;
  const read = createReadPageHandler(new FakeProvider(makeInstance(), client));

  const args = readPageInputSchema.parse({ kind: 'list', key: 'queue', limit: 3 });
  const json = resultJson(await read(args));

  assert.equal(json.kind, 'list');
  assert.deepEqual(json.items, ['a', 'b', 'c']);
  assert.equal(json.returned, 3);
  assert.equal(json.total, 10);
  assert.equal(json.nextOffset, 3);
  assert.equal(json.complete, false);
  assert.deepEqual(client.calls[0], { command: 'LRANGE', args: ['queue', 0, 2] });
});

test('read_page marks the last list page complete', async () => {
  const client = new FakeClient();
  client.commandReplies.LRANGE = ['d'];
  client.commandReplies.LLEN = 4;
  const read = createReadPageHandler(new FakeProvider(makeInstance(), client));

  const args = readPageInputSchema.parse({ kind: 'list', key: 'queue', limit: 3, offset: 3 });
  const json = resultJson(await read(args));

  assert.deepEqual(json.items, ['d']);
  assert.equal(json.nextOffset, 4);
  assert.equal(json.complete, true);
});

test('read_page pages a string with GETRANGE', async () => {
  const client = new FakeClient();
  client.commandReplies.GETRANGE = 'abc';
  client.commandReplies.STRLEN = 10;
  const read = createReadPageHandler(new FakeProvider(makeInstance(), client));

  const args = readPageInputSchema.parse({ kind: 'string', key: 'blob', limit: 3 });
  const json = resultJson(await read(args));

  assert.equal(json.chunk, 'abc');
  assert.equal(json.nextOffset, 3);
  assert.equal(json.complete, false);
  assert.deepEqual(client.calls[0], { command: 'GETRANGE', args: ['blob', 0, 3] });
});

test('read_page pages a hash with HSCAN and a cursor', async () => {
  const client = new FakeClient();
  client.commandReplies.HSCAN = ['7', ['f1', 'v1', 'f2', 'v2']];
  client.commandReplies.HLEN = 10;
  const read = createReadPageHandler(new FakeProvider(makeInstance(), client));

  const args = readPageInputSchema.parse({
    kind: 'hash',
    key: 'h',
    limit: 2,
    cursor: 5,
    match: 'f*',
  });
  const json = resultJson(await read(args));

  assert.deepEqual(json.items, [
    { field: 'f1', value: 'v1' },
    { field: 'f2', value: 'v2' },
  ]);
  assert.equal(json.nextCursor, '7');
  assert.equal(json.complete, false);
  assert.deepEqual(client.calls[0], {
    command: 'HSCAN',
    args: ['h', '5', 'COUNT', 2, 'MATCH', 'f*'],
  });
});

test('read_page pages a set with SSCAN and a cursor', async () => {
  const client = new FakeClient();
  client.commandReplies.SSCAN = ['5', ['a', 'b']];
  client.commandReplies.SCARD = 10;
  const read = createReadPageHandler(new FakeProvider(makeInstance(), client));

  const args = readPageInputSchema.parse({ kind: 'set', key: 's', limit: 2 });
  const json = resultJson(await read(args));

  assert.deepEqual(json.items, ['a', 'b']);
  assert.equal(json.nextCursor, '5');
  assert.equal(json.total, 10);
  assert.equal(json.complete, false);
});

test('read_page pages a sorted set with ZRANGE and scores', async () => {
  const client = new FakeClient();
  client.commandReplies.ZRANGE = ['a', '1', 'b', '2'];
  client.commandReplies.ZCARD = 10;
  const read = createReadPageHandler(new FakeProvider(makeInstance(), client));

  const args = readPageInputSchema.parse({
    kind: 'zset',
    key: 'z',
    limit: 2,
    withScores: true,
  });
  const json = resultJson(await read(args));

  assert.deepEqual(json.items, [
    { member: 'a', score: 1 },
    { member: 'b', score: 2 },
  ]);
  assert.equal(json.nextOffset, 2);
  assert.equal(json.complete, false);
  assert.deepEqual(client.calls[0], { command: 'ZRANGE', args: ['z', 0, 1, 'WITHSCORES'] });
});

test('read_page pages a stream with XRANGE and nextStart', async () => {
  const client = new FakeClient();
  client.commandReplies.XRANGE = [
    ['1-0', ['f', 'v']],
    ['2-0', ['g', 'w']],
  ];
  client.commandReplies.XLEN = 10;
  const read = createReadPageHandler(new FakeProvider(makeInstance(), client));

  const args = readPageInputSchema.parse({ kind: 'stream', key: 'events', limit: 2 });
  const json = resultJson(await read(args));

  assert.deepEqual(json.items, [
    { id: '1-0', fields: [['f', 'v']] },
    { id: '2-0', fields: [['g', 'w']] },
  ]);
  assert.equal(json.nextStart, '(2-0');
  assert.equal(json.complete, false);
  assert.deepEqual(client.calls[0], {
    command: 'XRANGE',
    args: ['events', '-', '+', 'COUNT', 2],
  });
});

test('read_page truncates long items and reports it', async () => {
  const client = new FakeClient();
  client.commandReplies.LRANGE = ['abcdef'];
  client.commandReplies.LLEN = 1;
  const read = createReadPageHandler(
    new FakeProvider(makeInstance({ maxResultChars: 3 }), client),
  );

  const args = readPageInputSchema.parse({ kind: 'list', key: 'l', limit: 10 });
  const json = resultJson(await read(args));

  assert.deepEqual(json.items, ['abc']);
  assert.equal(json.truncatedItems, 1);
  assert.equal(json.complete, true);
  assert.match(String(json.notes), /truncated at maxResultChars=3/);
});

test('read_page returns the whole HSCAN batch and reports the overflow', async () => {
  const client = new FakeClient();
  client.commandReplies.HSCAN = ['5', ['f1', 'v1', 'f2', 'v2', 'f3', 'v3', 'f4', 'v4']];
  client.commandReplies.HLEN = 4;
  const read = createReadPageHandler(new FakeProvider(makeInstance(), client));

  const json = resultJson(
    await read(readPageInputSchema.parse({ kind: 'hash', key: 'h', limit: 2 })),
  );

  assert.equal((json.items as unknown[]).length, 4);
  assert.equal(json.returned, 4);
  assert.equal(json.complete, false);
  assert.match(String(json.notes), /HSCAN returned 4 entries/);
});

test('read_page preserves infinity scores and removes duplicate hash fields', async () => {
  const client = new FakeClient();
  client.commandReplies.ZRANGE = ['a', 'inf', 'b', '-inf'];
  client.commandReplies.ZCARD = 2;
  const readZsetPage = createReadPageHandler(new FakeProvider(makeInstance(), client));

  const zset = resultJson(
    await readZsetPage(
      readPageInputSchema.parse({ kind: 'zset', key: 'z', limit: 2, withScores: true }),
    ),
  );
  assert.deepEqual(zset.items, [
    { member: 'a', score: 'inf' },
    { member: 'b', score: '-inf' },
  ]);

  const hashClient = new FakeClient();
  hashClient.commandReplies.HSCAN = ['0', ['f1', 'v1', 'f1', 'v2']];
  hashClient.commandReplies.HLEN = 1;
  const readHashPage = createReadPageHandler(new FakeProvider(makeInstance(), hashClient));

  const hash = resultJson(
    await readHashPage(readPageInputSchema.parse({ kind: 'hash', key: 'h', limit: 10 })),
  );
  assert.deepEqual(hash.items, [{ field: 'f1', value: 'v1' }]);
  assert.equal(hash.duplicateItems, 1);
});

test('read_page caps the page size by maxFetchChars', async () => {
  const client = new FakeClient();
  client.commandReplies.LRANGE = ['x'.repeat(100), 'y'.repeat(100)];
  client.commandReplies.LLEN = 1_000;
  const read = createReadPageHandler(
    new FakeProvider(
      makeInstance({ maxFetchItems: 1_000, maxFetchChars: 250, maxResultChars: 100 }),
      client,
    ),
  );

  const args = readPageInputSchema.parse({ kind: 'list', key: 'l', limit: 1_000 });
  const json = resultJson(await read(args));

  assert.equal(json.limit, 2);
  assert.equal(json.outputBytes, 200);
  assert.match(String(json.notes), /Page limit reduced from 1000 to 2/);
});

test('read_page caps the page size by maxFetchItems', async () => {
  const client = new FakeClient();
  client.commandReplies.LRANGE = [];
  client.commandReplies.LLEN = 10_000;
  const read = createReadPageHandler(
    new FakeProvider(makeInstance({ maxFetchItems: 50 }), client),
  );

  const args = readPageInputSchema.parse({ kind: 'list', key: 'l', limit: 1_000 });
  const json = resultJson(await read(args));

  assert.equal(json.limit, 50);
  assert.deepEqual(client.calls[0], { command: 'LRANGE', args: ['l', 0, 49] });
  assert.match(String(json.notes), /Page limit reduced from 1000 to 50/);
});
