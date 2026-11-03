import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigObject, type InstanceConfig } from '../src/config.js';
import { RedisManager } from '../src/redis-manager.js';
import { FakeRedisServer } from './fake-redis-server.js';

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function withServer(
  options: ConstructorParameters<typeof FakeRedisServer>[0],
  instanceOverrides: Partial<InstanceConfig>,
  run: (server: FakeRedisServer, manager: RedisManager, instance: InstanceConfig) => Promise<void>,
): Promise<void> {
  const server = new FakeRedisServer(options);
  await server.start();

  const config = parseConfigObject(
    {
      instances: [
        {
          name: 'lifecycle',
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
    'connection-lifecycle-test',
  );

  const manager = new RedisManager(config);
  try {
    await run(server, manager, manager.resolveInstance());
  } finally {
    await manager.close();
    await server.stop();
  }
}

test('idle (instance, db) connections are closed and evicted after idleTimeoutMs', async () => {
  await withServer(
    {},
    { idleTimeoutMs: 50, poolSize: 1 },
    async (server, manager, instance) => {
      const client = await manager.getClient(instance, 0);
      assert.equal(await client.call('SET', 'k', 'v'), 'OK');
      assert.equal(server.connectionCount, 1);

      // The sweep runs at least once per second; 50 ms of idle time is enough.
      await waitFor(() => {
        assert.equal(server.connectionCount, 0, 'idle connection was not closed');
      });

      // The next request for the same database creates a fresh connection.
      const fresh = await manager.getClient(instance, 0);
      assert.equal(await fresh.call('GET', 'k'), 'v');
      assert.equal(server.totalConnections, 2);
    },
  );
});

test('idleTimeoutMs 0 keeps connections open', async () => {
  await withServer(
    {},
    { idleTimeoutMs: 0, poolSize: 1 },
    async (server, manager, instance) => {
      const client = await manager.getClient(instance, 0);
      await client.call('SET', 'k', 'v');

      await sleep(150);
      assert.equal(server.connectionCount, 1, 'connection was closed although idle recycling is disabled');
    },
  );
});

test('concurrent requests grow the pool up to poolSize; sequential requests reuse it', async () => {
  await withServer(
    { commandDelaysMs: { GET: 250 } },
    { poolSize: 2 },
    async (server, manager, instance) => {
      const first = await manager.getClient(instance, 0);

      // Keep the first connection busy so the next getClient grows the pool.
      const slow = first.call('GET', 'k');
      await sleep(50);

      const second = await manager.getClient(instance, 0);
      assert.notEqual(second, first, 'expected a second pooled connection while the first is busy');
      assert.equal(server.totalConnections, 2);

      await slow;
      await second.call('PING');
      await first.call('PING');

      // Both connections are idle now: a sequential request must reuse one.
      const third = await manager.getClient(instance, 0);
      await third.call('PING');
      assert.equal(server.totalConnections, 2, 'sequential request should not open another connection');
    },
  );
});

test('a command timeout poisons the connection: it is dropped, evicted and replaced', async () => {
  await withServer(
    { hangCommands: ['GET'] },
    { commandTimeoutMs: 150, poolSize: 1 },
    async (server, manager, instance) => {
      const client = await manager.getClient(instance, 0);
      await client.call('PING');

      await assert.rejects(() => client.call('GET', 'k'), /Command timed out/);

      // The poisoned connection must be dropped, not left to desync the reply queue.
      await waitFor(() => {
        assert.equal(server.connectionCount, 0, 'timed-out connection was not closed');
      });

      // Holders of the stale reference fail fast instead of getting wrong data.
      await assert.rejects(() => client.call('PING'), /recycled/);

      // New requests get a fresh, working connection.
      const fresh = await manager.getClient(instance, 0);
      assert.equal(await fresh.call('PING'), 'PONG');
      assert.equal(server.totalConnections, 2);
    },
  );
});

test('a failed SELECT on reconnect is reported without crashing the process', async () => {
  await withServer(
    {},
    { commandTimeoutMs: 1_000 },
    async (server, manager, instance) => {
      const client = await manager.getClient(instance, 2);
      assert.equal(await client.call('SET', 'k', 'v'), 'OK');

      // Simulate +select being revoked, then force a reconnect. ioredis
      // re-issues its own fire-and-forget SELECT; before the select() shadow
      // this rejection was unhandled and killed the whole process.
      server.failSelect = true;
      server.dropConnections();
      await sleep(500);

      // The test process is still alive; the stale client reports a clean error.
      await assert.rejects(() => client.call('GET', 'k'), /DB_ERROR|select|connection/i);

      // db 0 needs no SELECT and keeps working; db 2 fails closed with DB_ERROR.
      const db0 = await manager.getClient(instance, 0);
      assert.equal(await db0.call('PING'), 'PONG');
      await assert.rejects(
        () => manager.getClient(instance, 2),
        (error: Error) => {
          assert.match(error.message, /select|SELECT/i);
          return true;
        },
      );
    },
  );
});
