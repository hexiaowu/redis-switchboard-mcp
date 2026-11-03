import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommand } from '../src/commands.js';
import type { InstanceConfig } from '../src/config.js';
import { enforceFetchLimit } from '../src/fetch-guard.js';
import { createExecuteHandler } from '../src/tools/execute.js';
import { FakeClient, FakeProvider, makeInstance, resultJson } from './helpers.js';

async function guard(client: FakeClient, instance: InstanceConfig, command: string): Promise<void> {
  await enforceFetchLimit(client, normalizeCommand(command), instance);
}

test('GET is rejected when the string exceeds maxFetchChars', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchChars: 1_000 });

  client.commandReplies.STRLEN = 1_001;
  await assert.rejects(() => guard(client, instance, 'GET big'), /maxFetchChars/);

  client.commandReplies.STRLEN = 100;
  await guard(client, instance, 'GET small');

  client.commandReplies.STRLEN = 0;
  await guard(client, instance, 'GET missing');
});

test('GETRANGE is rejected when the requested range is too large', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchChars: 1_000 });
  client.commandReplies.STRLEN = 5_000;

  await assert.rejects(() => guard(client, instance, 'GETRANGE key 0 4999'), /maxFetchChars/);
  await guard(client, instance, 'GETRANGE key 0 99');
});

test('LRANGE is rejected for unbounded or oversized ranges', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.LLEN = 5_000;

  await assert.rejects(() => guard(client, instance, 'LRANGE big 0 -1'), /maxFetchItems/);
  await assert.rejects(() => guard(client, instance, 'LRANGE big 0 4999'), /maxFetchItems/);
  await guard(client, instance, 'LRANGE big 0 99');

  client.commandReplies.LLEN = 50;
  await guard(client, instance, 'LRANGE small 0 -1');
});

test('LRANGE is rejected when the key memory exceeds maxFetchChars', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.commandReplies.LLEN = 10;
  client.memoryReply = 2_000;

  await assert.rejects(() => guard(client, instance, 'LRANGE key 0 9'), /maxFetchChars/);
});

test('HGETALL and SMEMBERS are rejected when the collection is too large', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });

  client.commandReplies.HLEN = 5_000;
  await assert.rejects(() => guard(client, instance, 'HGETALL big'), /maxFetchItems/);
  client.commandReplies.HLEN = 10;
  await guard(client, instance, 'HGETALL small');

  client.commandReplies.SCARD = 5_000;
  await assert.rejects(() => guard(client, instance, 'SMEMBERS big'), /maxFetchItems/);
  client.commandReplies.SCARD = 10;
  await guard(client, instance, 'SMEMBERS small');
});

test('MEMORY USAGE ACL denial fails closed', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.HLEN = 10;
  client.memoryError = new Error("NOPERM this user has no permissions to run the 'memory' command");

  await assert.rejects(() => guard(client, instance, 'HGETALL small'), /MEMORY USAGE/);
});

test('bulk collection reads are rejected when the key memory is too large', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.commandReplies.HLEN = 10;
  client.memoryReply = 2_000;

  await assert.rejects(() => guard(client, instance, 'HGETALL key'), /maxFetchChars/);
});

test('ZRANGE index ranges and BYSCORE queries are bounded', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.ZCARD = 5_000;

  await assert.rejects(() => guard(client, instance, 'ZRANGE big 0 -1'), /maxFetchItems/);
  await guard(client, instance, 'ZRANGE big 0 99');
  await guard(client, instance, 'ZRANGE big 0 99 WITHSCORES');

  await assert.rejects(() => guard(client, instance, 'ZRANGE big 0 -1 BYSCORE'), /maxFetchItems/);
  await guard(client, instance, 'ZRANGE big 0 -1 BYSCORE LIMIT 0 100');
  await assert.rejects(
    () => guard(client, instance, 'ZRANGE big 0 -1 BYSCORE LIMIT 0 5000'),
    /LIMIT count/,
  );
});

test('ZRANGEBYSCORE/ZRANGEBYLEX require a bounded LIMIT', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.ZCARD = 5_000;

  await assert.rejects(
    () => guard(client, instance, 'ZRANGEBYSCORE big -inf +inf'),
    /maxFetchItems/,
  );
  await guard(client, instance, 'ZRANGEBYSCORE big -inf +inf LIMIT 0 100');
  await assert.rejects(
    () => guard(client, instance, 'ZRANGEBYLEX big - + LIMIT 0 5000'),
    /LIMIT count/,
  );
});

test('XRANGE requires COUNT when the stream is large', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.XLEN = 5_000;

  await assert.rejects(() => guard(client, instance, 'XRANGE stream - +'), /maxFetchItems/);
  await guard(client, instance, 'XRANGE stream - + COUNT 100');
  await assert.rejects(
    () => guard(client, instance, 'XRANGE stream - + COUNT 5000'),
    /COUNT 5000/,
  );
});

test('random-member commands reject negative and oversized counts', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });

  await assert.rejects(() => guard(client, instance, 'SRANDMEMBER key -1'), /negative count/);
  await assert.rejects(() => guard(client, instance, 'HRANDFIELD key -10'), /negative count/);
  await assert.rejects(() => guard(client, instance, 'ZRANDMEMBER key 5000'), /maxFetchItems/);
  await guard(client, instance, 'SRANDMEMBER key 10');
  await guard(client, instance, 'ZRANDMEMBER key 10 WITHSCORES');
});

test('set operations are bounded by their input set sizes', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });

  client.commandReplies.SCARD = 600;
  await assert.rejects(() => guard(client, instance, 'SUNION a b'), /maxFetchItems/);
  await guard(client, instance, 'SINTER a b');

  client.commandReplies.SCARD = 100;
  await guard(client, instance, 'SUNION a b');
  await guard(client, instance, 'SDIFF a b');
});

test('HKEYS and HVALS are guarded like HGETALL', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.HLEN = 5_000;

  await assert.rejects(() => guard(client, instance, 'HKEYS big'), /maxFetchItems/);
  await assert.rejects(() => guard(client, instance, 'HVALS big'), /maxFetchItems/);
});

test('HSCAN/SSCAN/ZSCAN COUNT is bounded', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });

  await assert.rejects(
    () => guard(client, instance, 'HSCAN h 0 COUNT 5000'),
    /maxFetchItems/,
  );
  await assert.rejects(
    () => guard(client, instance, 'HSCAN h 0 MATCH COUNT COUNT 5000'),
    /maxFetchItems/,
  );
  await guard(client, instance, 'HSCAN h 0 COUNT 100');
  await guard(client, instance, 'HSCAN h 0 MATCH COUNT COUNT 100');
  await guard(client, instance, 'SSCAN s 0 COUNT 100');
  await guard(client, instance, 'ZSCAN z 0 COUNT 100');
});

test('MGET is bounded by the total string size', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchChars: 1_000 });
  client.commandReplies.STRLEN = 600;

  await assert.rejects(() => guard(client, instance, 'MGET a b'), /maxFetchChars/);

  client.commandReplies.STRLEN = 100;
  await guard(client, instance, 'MGET a b');
});

test('HMGET is bounded by the requested field count', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  const fields = Array.from({ length: 1_001 }, (_value, index) => `f${index}`);

  await assert.rejects(
    () => enforceFetchLimit(client, normalizeCommand(['HMGET', 'h', ...fields]), instance),
    /maxFetchItems/,
  );
  await enforceFetchLimit(client, normalizeCommand(['HMGET', 'h', 'f1', 'f2']), instance);
});

test('SORT_RO is bounded by LIMIT or source list size', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.TYPE = 'list';
  client.commandReplies.LLEN = 5_000;

  await assert.rejects(() => guard(client, instance, 'SORT_RO list'), /maxFetchItems/);
  await assert.rejects(() => guard(client, instance, 'SORT_RO list GET LIMIT'), /maxFetchItems/);
  await assert.rejects(() => guard(client, instance, 'SORT_RO list BY LIMIT'), /maxFetchItems/);
  await guard(client, instance, 'SORT_RO list LIMIT 0 100');
  await assert.rejects(() => guard(client, instance, 'SORT_RO list LIMIT 0 5000'), /LIMIT count/);
});

test('ZUNION/ZINTER/ZDIFF are bounded by input cardinality', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.ZCARD = 600;

  await assert.rejects(() => guard(client, instance, 'ZUNION 2 a b'), /maxFetchItems/);
  await guard(client, instance, 'ZINTER 2 a b');
  await guard(client, instance, 'ZDIFF 2 a b');

  client.commandReplies.ZCARD = 100;
  await guard(client, instance, 'ZUNION 2 a b');
});

test('HGET, DUMP and GEOSEARCH are guarded', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.commandReplies.HSTRLEN = 2_000;
  client.commandReplies.ZCARD = 5_000;
  client.memoryReply = 2_000;

  await assert.rejects(() => guard(client, instance, 'HGET h f'), /maxFetchChars/);
  await assert.rejects(() => guard(client, instance, 'DUMP big'), /maxFetchChars/);
  await assert.rejects(
    () => guard(client, instance, 'GEOSEARCH geo FROMMEMBER m BYRADIUS 1 km'),
    /maxFetchItems/,
  );
  await guard(client, instance, 'GEOSEARCH geo FROMMEMBER m BYRADIUS 1 km COUNT 10');

  client.commandReplies.HSTRLEN = 100;
  client.commandReplies.ZCARD = 100;
  client.memoryReply = 100;
  await guard(client, instance, 'HGET h f');
  await guard(client, instance, 'DUMP big');
  await guard(client, instance, 'GEOSEARCH geo FROMMEMBER m BYRADIUS 1 km');
});

test('LCS is bounded unless only its length is requested', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchChars: 1_000 });
  client.commandReplies.STRLEN = 2_000;

  await assert.rejects(() => guard(client, instance, 'LCS a b'), /maxFetchChars/);
  await assert.rejects(() => guard(client, instance, 'LCS a b IDX'), /maxFetchChars/);
  await assert.rejects(() => guard(client, instance, 'LCS LEN b'), /maxFetchChars/);
  await guard(client, instance, 'LCS a b LEN');

  client.commandReplies.STRLEN = 100;
  await guard(client, instance, 'LCS a b');
});

test('unsafe integer arguments are treated as huge, not allowed', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.commandReplies.LLEN = 5_000;
  client.commandReplies.ZCARD = 5_000;
  client.commandReplies.XLEN = 5_000;
  client.commandReplies.STRLEN = 5_000;

  await assert.rejects(
    () => guard(client, instance, 'LRANGE big 0 9007199254740992'),
    /maxFetchItems/,
  );
  await assert.rejects(
    () => guard(client, instance, 'LRANGE big -9007199254740992 -1'),
    /maxFetchItems/,
  );
  await assert.rejects(() => guard(client, instance, 'GETRANGE s 0 999999999999999999'), /maxFetchChars/);
  await assert.rejects(() => guard(client, instance, 'ZRANGE big 0 999999999999999999'), /maxFetchItems/);
  await assert.rejects(
    () => guard(client, instance, 'XRANGE s - + COUNT 999999999999999999'),
    /COUNT/,
  );
  await assert.rejects(
    () => guard(client, instance, 'HRANDFIELD h -999999999999999999'),
    /negative count/,
  );
  await assert.rejects(() => guard(client, instance, 'HSCAN h 0 COUNT 999999999999999999'), /COUNT/);
  await assert.rejects(
    () => guard(client, instance, 'SORT_RO big LIMIT 0 999999999999999999'),
    /LIMIT count/,
  );
  await assert.rejects(() => guard(client, instance, 'SPOP s 999999999999999999'), /maxFetchItems/);
});

test('negative LIMIT/COUNT values that mean "all" are rejected', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.ZCARD = 10;
  client.commandReplies.TYPE = 'list';
  client.commandReplies.LLEN = 10;

  await assert.rejects(
    () => guard(client, instance, 'ZRANGEBYSCORE big -inf +inf LIMIT 0 -1'),
    /negative|all remaining/,
  );
  await assert.rejects(
    () => guard(client, instance, 'ZRANGE big 0 -1 BYSCORE LIMIT 0 -1'),
    /negative|all remaining/,
  );
  await assert.rejects(
    () => guard(client, instance, 'SORT_RO list LIMIT 0 -1'),
    /negative|all remaining/,
  );
  await assert.rejects(() => guard(client, instance, 'HSCAN h 0 COUNT -1'), /negative/);
  await assert.rejects(() => guard(client, instance, 'XRANGE s - + COUNT -1'), /negative/);
});

test('SORT, GETDEL and pop counts are guarded', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.commandReplies.TYPE = 'list';
  client.commandReplies.LLEN = 5_000;
  client.commandReplies.STRLEN = 2_000;

  await assert.rejects(() => guard(client, instance, 'SORT big'), /maxFetchItems/);
  await assert.rejects(() => guard(client, instance, 'GETDEL big'), /maxFetchChars/);
  await assert.rejects(() => guard(client, instance, 'LPOP big 5000'), /maxFetchItems/);
  await guard(client, instance, 'LPOP big 10');
});

test('execute enforces the fetch guard before running the real command', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.LLEN = 5_000;
  const execute = createExecuteHandler(new FakeProvider(instance, client));

  const result = await execute({ command: 'LRANGE big 0 -1' });
  const json = resultJson(result);

  assert.equal(result.isError, true);
  assert.equal(json.code, 'COMMAND_REJECTED');
  assert.match(String(json.error), /maxFetchItems/);
  assert.equal(client.calls.some((call) => call.command === 'LRANGE'), false);
});
