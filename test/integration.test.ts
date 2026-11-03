import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfigObject,
  type InstanceConfig,
} from '../src/config.js';
import { RedisManager } from '../src/redis-manager.js';
import { createExecuteHandler } from '../src/tools/execute.js';
import { createKeyInfoHandler } from '../src/tools/key-info.js';
import { createReadPageHandler, readPageInputSchema } from '../src/tools/read-page.js';
import { createScanKeysHandler } from '../src/tools/scan-keys.js';
import { FakeRedisServer, type FakeRedisServerOptions } from './fake-redis-server.js';
import { resultJson } from './helpers.js';

async function waitFor(assertion: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  throw lastError;
}

async function withRedis(
  options: FakeRedisServerOptions,
  run: (server: FakeRedisServer, manager: RedisManager, instance: InstanceConfig) => Promise<void>,
  instanceOverrides: Partial<InstanceConfig> = {},
): Promise<void> {
  const server = new FakeRedisServer(options);
  await server.start();

  const config = parseConfigObject(
    {
      instances: [
        {
          name: 'fake',
          host: '127.0.0.1',
          port: server.port,
          mode: 'readwrite',
          db: 0,
          connectTimeoutMs: 1_000,
          commandTimeoutMs: 2_000,
          ...instanceOverrides,
        },
      ],
    },
    'integration-test',
  );

  const manager = new RedisManager(config);
  try {
    await run(server, manager, manager.resolveInstance());
  } finally {
    await manager.close();
    await server.stop();
  }
}

test('per-database clients are isolated and cached', async () => {
  await withRedis({}, async (server, manager, instance) => {
    const db2 = await manager.getClient(instance, 2);
    const db4 = await manager.getClient(instance, 4);
    const db2Again = await manager.getClient(instance, 2);

    assert.notStrictEqual(db2, db4);
    assert.strictEqual(db2, db2Again);

    assert.equal(await db2.call('SET', 'key', 'two'), 'OK');
    assert.equal(await db4.call('SET', 'key', 'four'), 'OK');
    assert.equal(await db2.call('GET', 'key'), 'two');
    assert.equal(await db4.call('GET', 'key'), 'four');
    assert.equal(await db2.call('GET', 'key'), 'two');

    assert.deepEqual([...server.selectedDbs].sort((left, right) => left - right), [2, 4]);
    assert.deepEqual(server.keysFor(2), ['key']);
    assert.deepEqual(server.keysFor(4), ['key']);
  });
});

test('concurrent first-use calls share one connection promise', async () => {
  await withRedis({}, async (_server, manager, instance) => {
    const clients = await Promise.all([
      manager.getClient(instance, 5),
      manager.getClient(instance, 5),
      manager.getClient(instance, 5),
    ]);

    assert.strictEqual(clients[0], clients[1]);
    assert.strictEqual(clients[1], clients[2]);
    assert.equal(await clients[0]!.call('PING'), 'PONG');
  });
});

test('execute selects the database per call through the real client', async () => {
  await withRedis({}, async (server, manager) => {
    const execute = createExecuteHandler(manager);

    assert.equal(resultJson(await execute({ command: 'SET key two', db: 2 })).reply, 'OK');
    assert.equal(resultJson(await execute({ command: 'SET key four', db: 4 })).reply, 'OK');

    assert.equal(resultJson(await execute({ command: 'GET key', db: 2 })).reply, 'two');
    assert.equal(resultJson(await execute({ command: 'GET key', db: 4 })).reply, 'four');
    assert.equal(resultJson(await execute({ command: 'GET key', db: 2 })).reply, 'two');

    assert.deepEqual(server.keysFor(2), ['key']);
    assert.deepEqual(server.keysFor(4), ['key']);
  });
});

test('scan_keys follows real SCAN cursors', async () => {
  await withRedis({ scanPageSize: 2 }, async (_server, manager) => {
    const execute = createExecuteHandler(manager);
    for (const key of ['user:1', 'user:2', 'user:3', 'other:1']) {
      await execute({ command: ['SET', key, 'value'], db: 3 });
    }

    const scan = createScanKeysHandler(manager);
    const first = resultJson(await scan({ pattern: 'user:*', db: 3, limit: 2, count: 10 }));

    assert.equal(first.returned, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.complete, false);
    assert.equal(first.cursor, '2');

    const second = resultJson(
      await scan({
        pattern: 'user:*',
        db: 3,
        limit: 10,
        count: 10,
        cursor: String(first.cursor),
      }),
    );

    assert.equal(second.returned, 1);
    assert.equal(second.complete, true);
    assert.deepEqual([...(first.keys as string[]), ...(second.keys as string[])].sort(), [
      'user:1',
      'user:2',
      'user:3',
    ]);
  });
});

test('key_info reads metadata through the real client', async () => {
  await withRedis({}, async (_server, manager) => {
    const execute = createExecuteHandler(manager);
    await execute({ command: ['SET', 'user:1', 'hello'], db: 3 });

    const info = createKeyInfoHandler(manager);
    const json = resultJson(await info({ key: 'user:1', db: 3 }));

    assert.equal(json.exists, true);
    assert.equal(json.type, 'string');
    assert.equal(json.ttlMs, null);
    assert.equal(json.persistent, true);
    assert.equal(json.memoryUsageBytes, 42);
    assert.equal(json.encoding, 'embstr');
    assert.equal(json.length, 5);
    assert.equal(json.lengthUnit, 'bytes');

    const missing = resultJson(await info({ key: 'missing', db: 3 }));
    assert.equal(missing.exists, false);
  });
});

test('execute fetch guard runs against the real client before GET', async () => {
  await withRedis(
    {},
    async (server, manager) => {
      server.data.set(0, new Map([['big', 'x'.repeat(2_000)]]));
      const execute = createExecuteHandler(manager);

      const result = await execute({ command: 'GET big', db: 0 });
      assert.equal(result.isError, true);
      assert.equal(resultJson(result).code, 'COMMAND_REJECTED');
      assert.equal(server.commands.some((command) => command.command === 'GET'), false);
    },
    { maxFetchChars: 1_000 },
  );
});

test('read_page reads a bounded string page through the real client', async () => {
  await withRedis({}, async (_server, manager) => {
    const execute = createExecuteHandler(manager);
    await execute({ command: ['SET', 'blob', 'hello world'], db: 3 });

    const read = createReadPageHandler(manager);
    const first = resultJson(
      await read(readPageInputSchema.parse({ kind: 'string', key: 'blob', db: 3, limit: 5 })),
    );

    assert.equal(first.chunk, 'hello');
    assert.equal(first.total, 11);
    assert.equal(first.nextOffset, 5);
    assert.equal(first.complete, false);

    const second = resultJson(
      await read(
        readPageInputSchema.parse({ kind: 'string', key: 'blob', db: 3, limit: 100, offset: 5 }),
      ),
    );
    assert.equal(second.chunk, ' world');
    assert.equal(second.complete, true);
  });
});

test('read_page string paging is UTF-8 byte-based and boundary safe', async () => {
  await withRedis({}, async (_server, manager) => {
    const execute = createExecuteHandler(manager);
    await execute({ command: ['SET', 'unicode', 'a😀b'], db: 3 });

    const read = createReadPageHandler(manager);
    let offset = 0;
    let complete = false;
    const chunks: string[] = [];

    for (let page = 0; page < 10 && !complete; page += 1) {
      const json = resultJson(
        await read(
          readPageInputSchema.parse({ kind: 'string', key: 'unicode', db: 3, limit: 2, offset }),
        ),
      );

      assert.equal(json.total, 6);
      assert.ok(Number(json.returned) <= 4);
      chunks.push(String(json.chunk));
      offset = Number(json.nextOffset);
      complete = Boolean(json.complete);
    }

    assert.equal(chunks.join(''), 'a😀b');
    assert.equal(complete, true);
  });
});

test('cluster mode rejects databases other than 0', async () => {
  await withRedis({ clusterEnabled: true }, async (_server, manager, instance) => {
    await assert.rejects(() => manager.getClient(instance, 2), /Redis Cluster|cluster/i);

    const db0 = await manager.getClient(instance, 0);
    assert.equal(await db0.call('PING'), 'PONG');

    // The cluster flag is cached after the first failed db > 0 verification
    // (and confirmed by the db 0 INFO cluster probe above).
    await assert.rejects(() => manager.getClient(instance, 2), /only logical database 0/i);
  });
});

test('a repeated db > 0 call on a cluster does not open another connection', async () => {
  await withRedis({ clusterEnabled: true }, async (server, manager, instance) => {
    await assert.rejects(() => manager.getClient(instance, 2), /Redis Cluster|cluster/i);
    const selectsAfterFirst = server.commands.filter((command) => command.command === 'SELECT').length;

    await assert.rejects(() => manager.getClient(instance, 2), /only logical database 0/i);
    const selectsAfterSecond = server.commands.filter((command) => command.command === 'SELECT').length;

    assert.equal(selectsAfterSecond, selectsAfterFirst);
  });
});

test('a database beyond the server databases is rejected, not silently run on db 0', async () => {
  await withRedis({ maxDatabases: 16 }, async (server, manager, instance) => {
    await assert.rejects(() => manager.getClient(instance, 20), /does not exist/);

    // Nothing may have been written to db 0 through the failed db-20 connection.
    assert.deepEqual(server.keysFor(0), []);
    assert.equal(server.selectedDbs.includes(20), false);

    const db0 = await manager.getClient(instance, 0);
    assert.equal(await db0.call('PING'), 'PONG');
  });
});

test('SELECT denial fails closed instead of falling back to db 0', async () => {
  await withRedis({ denySelect: true }, async (server, manager, instance) => {
    await assert.rejects(() => manager.getClient(instance, 2), /not allowed to SELECT/);
    assert.deepEqual(server.keysFor(0), []);

    // db 0 is the connection default and does not require SELECT.
    const db0 = await manager.getClient(instance, 0);
    assert.equal(await db0.call('PING'), 'PONG');
  });
});

test('execute on an out-of-range db never writes to db 0', async () => {
  await withRedis({ maxDatabases: 16 }, async (server, manager) => {
    const execute = createExecuteHandler(manager);
    const result = await execute({ command: 'SET leak value', db: 20 });
    const json = resultJson(result);

    assert.equal(result.isError, true);
    assert.equal(json.code, 'DB_ERROR');
    assert.deepEqual(server.keysFor(0), []);
    assert.deepEqual(server.keysFor(20), []);
  });
});

test('a call during the reconnect window waits and reuses the client', async () => {
  await withRedis({}, async (server, manager, instance) => {
    const client = await manager.getClient(instance, 3);
    assert.equal(await client.call('SET', 'key', 'three'), 'OK');

    server.dropConnections();
    // Let ioredis observe the close and enter its reconnect loop.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.equal(await client.call('GET', 'key'), 'three');
    const same = await manager.getClient(instance, 3);
    assert.strictEqual(same, client);
  });
});

test('a reconnect re-selects the target database before commands run', async () => {
  await withRedis({}, async (server, manager, instance) => {
    const client = await manager.getClient(instance, 3);
    assert.equal(await client.call('SET', 'key', 'three'), 'OK');

    server.dropConnections();

    await waitFor(async () => {
      assert.equal(await client.call('GET', 'key'), 'three');
    });

    const selectsForDb3 = server.selectedDbs.filter((db) => db === 3);
    assert.ok(selectsForDb3.length >= 2, `expected at least two SELECT 3 calls, got ${selectsForDb3.length}`);
  });
});

test('the per-instance connection cache is bounded', async () => {
  const server = new FakeRedisServer();
  await server.start();

  const config = parseConfigObject(
    {
      instances: [
        {
          name: 'bounded',
          host: '127.0.0.1',
          port: server.port,
          mode: 'readwrite',
          maxConnections: 2,
          connectTimeoutMs: 1_000,
        },
      ],
    },
    'integration-test',
  );
  const manager = new RedisManager(config);

  try {
    const instance = manager.resolveInstance();
    await manager.getClient(instance, 0);
    await manager.getClient(instance, 1);
    await assert.rejects(() => manager.getClient(instance, 2), /maxConnections=2/);

    // Reusing an existing database does not count against the limit.
    const reused = await manager.getClient(instance, 1);
    assert.equal(await reused.call('PING'), 'PONG');
  } finally {
    await manager.close();
    await server.stop();
  }
});

test('connection errors are mapped and do not expose credentials', async () => {
  const server = new FakeRedisServer();
  await server.start();
  const port = server.port;
  await server.stop();

  const config = parseConfigObject(
    {
      instances: [
        {
          name: 'down',
          host: '127.0.0.1',
          port,
          mode: 'readwrite',
          password: 'super-secret',
          connectTimeoutMs: 500,
        },
      ],
    },
    'integration-test',
  );
  const manager = new RedisManager(config);

  try {
    await assert.rejects(
      () => manager.getClient(manager.resolveInstance(), 0),
      (error: unknown) => {
        assert.match((error as Error).message, /connection refused/i);
        assert.doesNotMatch((error as Error).message, /super-secret/);
        return true;
      },
    );
  } finally {
    await manager.close();
  }
});
