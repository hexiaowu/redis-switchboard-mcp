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

/**
 * FakeClient variant that can return different HSTRLEN values per field, so
 * multi-field guards (HMGET) can be tested against a byte total.
 */
class PerFieldClient extends FakeClient {
  hstrlenByField: Record<string, number> = {};

  override async call(command: string, ...args: (string | number | Buffer)[]): Promise<unknown> {
    this.calls.push({ command, args });
    const upper = command.toUpperCase();
    if (upper === 'HSTRLEN') {
      const field = String(args[1] ?? '');
      if (field in this.hstrlenByField) {
        return this.hstrlenByField[field]!;
      }
    }
    if (upper === 'MEMORY') {
      if (this.memoryError !== undefined) {
        throw this.memoryError;
      }
      return this.memoryReply;
    }
    if (this.callError !== undefined) {
      throw this.callError;
    }
    if (Object.hasOwn(this.commandReplies, upper)) {
      return this.commandReplies[upper];
    }
    return this.callReply;
  }
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
  const tooManyFields = Array.from({ length: 101 }, (_value, index) => `f${index}`);
  const okFields = Array.from({ length: 100 }, (_value, index) => `f${index}`);

  await assert.rejects(
    () => enforceFetchLimit(client, normalizeCommand(['HMGET', 'h', ...tooManyFields]), instance),
    /guard limit of 100/,
  );
  await enforceFetchLimit(client, normalizeCommand(['HMGET', 'h', ...okFields]), instance);
  await enforceFetchLimit(client, normalizeCommand(['HMGET', 'h', 'f1', 'f2']), instance);
});

test('HMGET is bounded by the summed field sizes', async () => {
  const client = new PerFieldClient();
  const instance = makeInstance({ maxFetchChars: 1_000 });
  client.hstrlenByField = { a: 600, b: 400 };

  // 600 + 400 == maxFetchChars is allowed.
  await guard(client, instance, 'HMGET h a b');

  client.hstrlenByField = { a: 600, b: 401 };
  await assert.rejects(() => guard(client, instance, 'HMGET h a b'), /total at least 1001 bytes/);
});

test('HMGET is rejected when the key memory exceeds maxFetchChars', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchChars: 1_000 });
  client.memoryReply = 2_000;

  await assert.rejects(() => guard(client, instance, 'HMGET h a b'), /maxFetchChars/);
});

test('keys named LIMIT or COUNT do not bypass the guards', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.ZCARD = 5_000;
  client.commandReplies.XLEN = 5_000;
  client.memoryReply = 100;

  await assert.rejects(
    () => guard(client, instance, 'ZRANGEBYSCORE LIMIT -inf +inf'),
    /maxFetchItems/,
  );
  await assert.rejects(() => guard(client, instance, 'XRANGE COUNT - +'), /maxFetchItems/);
  // The real COUNT option after a key named COUNT is still honored.
  await guard(client, instance, 'XRANGE COUNT - + COUNT 10');
  await guard(client, instance, 'ZRANGEBYSCORE LIMIT -inf +inf LIMIT 0 100');

  await assert.rejects(() => guard(client, instance, 'GEORADIUS_RO COUNT 1 2 3 km'), /maxFetchItems/);
  client.commandReplies.ZCARD = 10;
  // A member named COUNT must not shadow (or be mistaken for) the COUNT option.
  await guard(client, instance, 'GEORADIUSBYMEMBER_RO geo COUNT 10 km');
  await guard(client, instance, 'GEOSEARCH geo FROMMEMBER COUNT BYRADIUS 1 km COUNT 10');
});

test('LPOS COUNT 0 and oversized counts are rejected', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });

  await assert.rejects(() => guard(client, instance, 'LPOS list el COUNT 0'), /all matches/);
  await assert.rejects(() => guard(client, instance, 'LPOS list el COUNT 5000'), /maxFetchItems/);
  await assert.rejects(() => guard(client, instance, 'LPOS list el RANK 1 COUNT 5000'), /maxFetchItems/);
  await guard(client, instance, 'LPOS list el COUNT 100');
  await guard(client, instance, 'LPOS list el');
  // The element sits at args[2], so an element named COUNT is not an option.
  await guard(client, instance, 'LPOS list COUNT COUNT 100');
});

test('XINFO STREAM FULL COUNT is bounded', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.memoryReply = 100;

  await assert.rejects(() => guard(client, instance, 'XINFO STREAM big FULL COUNT 0'), /all stream entries/);
  await assert.rejects(() => guard(client, instance, 'XINFO STREAM big FULL COUNT 5000'), /maxFetchItems/);
  await guard(client, instance, 'XINFO STREAM big FULL COUNT 100');
  await guard(client, instance, 'XINFO STREAM big FULL');
  await guard(client, instance, 'XINFO STREAM big');
  await guard(client, instance, 'XINFO GROUPS big');

  client.memoryReply = 2_000;
  await assert.rejects(() => guard(client, instance, 'XINFO STREAM big'), /maxFetchChars/);
});

test('XPENDING extended form count is capped', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });

  await assert.rejects(
    () => guard(client, instance, 'XPENDING stream group - + 10000000'),
    /maxFetchItems/,
  );
  await guard(client, instance, 'XPENDING stream group');
  await guard(client, instance, 'XPENDING stream group - + 100');
  await guard(client, instance, 'XPENDING stream group - + 100 consumer');
  await guard(client, instance, 'XPENDING stream group 0 5000 10');
});

test('MEMORY USAGE SAMPLES 0 is rejected', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });

  await assert.rejects(() => guard(client, instance, 'MEMORY USAGE big SAMPLES 0'), /SAMPLES 0/);
  await guard(client, instance, 'MEMORY USAGE big SAMPLES 5');
  await guard(client, instance, 'MEMORY USAGE big');
  await guard(client, instance, 'MEMORY STATS');
});

test('COMMAND allows only small subcommands', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });

  await assert.rejects(() => guard(client, instance, 'COMMAND'), /COMMAND is rejected/);
  await assert.rejects(() => guard(client, instance, 'COMMAND LIST'), /COMMAND is rejected/);
  await assert.rejects(() => guard(client, instance, 'COMMAND DOCS'), /COMMAND is rejected/);
  await assert.rejects(() => guard(client, instance, 'COMMAND INFO'), /COMMAND is rejected/);
  await guard(client, instance, 'COMMAND COUNT');
  await guard(client, instance, 'COMMAND GETKEYS SET a b');
  await guard(client, instance, 'COMMAND GETKEYSANDFLAGS SET a b');
});

test('SET with GET is bounded by the old value size', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchChars: 1_000 });
  client.commandReplies.STRLEN = 2_000;

  await assert.rejects(() => guard(client, instance, 'SET key value GET'), /old value/);
  await assert.rejects(() => guard(client, instance, 'SET key value EX 10 GET'), /old value/);
  await assert.rejects(() => guard(client, instance, 'SET key GET GET'), /old value/);
  await guard(client, instance, 'SET key value');
  // A value literally named GET without the GET option is not checked.
  await guard(client, instance, 'SET key GET');

  client.commandReplies.STRLEN = 100;
  await guard(client, instance, 'SET key value GET');
});

test('LMPOP/ZMPOP COUNT is capped and the key memory is checked', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.memoryReply = 100;

  await assert.rejects(() => guard(client, instance, 'LMPOP 1 list LEFT COUNT 5000'), /maxFetchItems/);
  await assert.rejects(() => guard(client, instance, 'ZMPOP 1 zset MIN COUNT 5000'), /maxFetchItems/);
  await guard(client, instance, 'LMPOP 1 list LEFT COUNT 100');
  await guard(client, instance, 'LMPOP 1 list LEFT');
  await guard(client, instance, 'ZMPOP 1 zset MAX COUNT 100');

  client.memoryReply = 2_000;
  await assert.rejects(() => guard(client, instance, 'LMPOP 1 list LEFT'), /maxFetchChars/);
});

test('GEORADIUS/GEORADIUSBYMEMBER without COUNT are rejected and STORE is allowed', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000_000 });
  client.commandReplies.ZCARD = 5_000;
  client.memoryReply = 100;

  await assert.rejects(() => guard(client, instance, 'GEORADIUS geo 1 2 100 km'), /maxFetchItems/);
  await assert.rejects(
    () => guard(client, instance, 'GEORADIUSBYMEMBER geo member 100 km'),
    /maxFetchItems/,
  );
  await guard(client, instance, 'GEORADIUS geo 1 2 100 km COUNT 10');
  await guard(client, instance, 'GEORADIUS geo 1 2 100 km STORE dest');
  await guard(client, instance, 'GEORADIUS geo 1 2 100 km COUNT 10 STORE dest');
  await guard(client, instance, 'GEORADIUSBYMEMBER geo member 100 km STOREDIST dest');

  client.commandReplies.ZCARD = 10;
  await guard(client, instance, 'GEORADIUS geo 1 2 100 km');
});

test('XAUTOCLAIM COUNT is capped', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });

  await assert.rejects(
    () => guard(client, instance, 'XAUTOCLAIM stream group consumer 0 COUNT 5000'),
    /maxFetchItems/,
  );
  await guard(client, instance, 'XAUTOCLAIM stream group consumer 0 COUNT 100');
  await guard(client, instance, 'XAUTOCLAIM stream group consumer 0 0-0 COUNT 100');
  await guard(client, instance, 'XAUTOCLAIM stream group consumer 0');
});

test('SLOWLOG GET count is capped', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });

  await assert.rejects(() => guard(client, instance, 'SLOWLOG GET 5000'), /maxFetchItems/);
  await guard(client, instance, 'SLOWLOG GET 100');
  await guard(client, instance, 'SLOWLOG GET');
  await guard(client, instance, 'SLOWLOG LEN');
});

test('SORT_RO GET patterns multiply the reply size', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000 });
  client.commandReplies.TYPE = 'list';
  client.commandReplies.LLEN = 10;

  const manyGets = Array.from({ length: 50 }, (_value, index) => `GET obj:${index}`).join(' ');
  await assert.rejects(
    () => guard(client, instance, `SORT_RO src LIMIT 0 100 ${manyGets}`),
    /GET patterns/,
  );
  // 10 items × 51 = 510 is still within maxFetchItems.
  await guard(client, instance, `SORT_RO src LIMIT 0 10 ${manyGets}`);

  const hugeGets = Array.from({ length: 100 }, (_value, index) => `GET obj:${index}`).join(' ');
  await assert.rejects(
    () => guard(client, instance, `SORT_RO src ${hugeGets}`),
    /GET patterns/,
  );
  const okGets = Array.from({ length: 98 }, (_value, index) => `GET obj:${index}`).join(' ');
  // 10 items × 99 = 990 is still within maxFetchItems.
  await guard(client, instance, `SORT_RO src LIMIT 0 10 ${okGets}`);
  await guard(client, instance, 'SORT_RO src LIMIT 0 10');
  await guard(client, instance, 'SORT src LIMIT 0 10 STORE dst');
});

test('SORT/STORE replies are not bounded by the source size', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.commandReplies.TYPE = 'list';
  client.commandReplies.LLEN = 5_000;
  client.memoryReply = 100;

  await guard(client, instance, 'SORT big STORE dst');
  await guard(client, instance, 'SORT big LIMIT 0 10 STORE dst');

  client.memoryReply = 2_000;
  await assert.rejects(() => guard(client, instance, 'SORT big STORE dst'), /maxFetchChars/);
});

test('multi-key operations sum MEMORY USAGE across keys', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.commandReplies.SCARD = 10;
  client.commandReplies.ZCARD = 10;

  client.memoryReply = 600;
  await assert.rejects(() => guard(client, instance, 'SUNION a b'), /in total/);
  await assert.rejects(() => guard(client, instance, 'ZUNION 2 a b'), /in total/);

  client.memoryReply = 400;
  await guard(client, instance, 'SUNION a b');
  await guard(client, instance, 'ZUNION 2 a b');
  await guard(client, instance, 'ZINTER 2 a b');
  await guard(client, instance, 'ZDIFF 2 a b');
  await guard(client, instance, 'SINTER a b');
  await guard(client, instance, 'SDIFF a b');
});

test('single-key pops and random reads check the key memory', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.memoryReply = 2_000;

  await assert.rejects(() => guard(client, instance, 'LPOP key'), /maxFetchChars/);
  await assert.rejects(() => guard(client, instance, 'SPOP key'), /maxFetchChars/);
  await assert.rejects(() => guard(client, instance, 'ZPOPMIN key 10'), /maxFetchChars/);
  await assert.rejects(() => guard(client, instance, 'SRANDMEMBER key 10'), /maxFetchChars/);
  await assert.rejects(() => guard(client, instance, 'HRANDFIELD key'), /maxFetchChars/);
  await assert.rejects(() => guard(client, instance, 'ZRANDMEMBER key 10 WITHSCORES'), /maxFetchChars/);

  client.memoryReply = 100;
  await guard(client, instance, 'LPOP key');
  await guard(client, instance, 'SPOP key 10');
  await guard(client, instance, 'SRANDMEMBER key 10');
});

test('size probes fail closed when they time out', async () => {
  const client = new FakeClient();
  const instance = makeInstance({ maxFetchItems: 1_000, maxFetchChars: 1_000 });
  client.callError = new Error('Command timed out after 1000 ms.');

  await assert.rejects(() => guard(client, instance, 'GET big'), /timed out/);
  await assert.rejects(() => guard(client, instance, 'DUMP big'), /timed out/);
  await assert.rejects(() => guard(client, instance, 'HMGET h a'), /timed out/);
  await assert.rejects(() => guard(client, instance, 'SORT_RO list'), /timed out/);
  await assert.rejects(() => guard(client, instance, 'LRANGE big 0 9'), /timed out/);
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

  client.memoryReply = 100;
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
