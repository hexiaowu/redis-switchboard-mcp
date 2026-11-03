import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, InstanceConfig } from '../src/config.js';
import {
  RedisManager,
  clusterEnabledFromInfo,
  resolveDbIndex,
  resolveInstanceByName,
} from '../src/redis-manager.js';
import { makeInstance } from './helpers.js';

function createConfig(instances: InstanceConfig[], defaultInstance?: string): AppConfig {
  return {
    instances,
    ...(defaultInstance === undefined ? {} : { defaultInstance }),
  };
}

test('resolveInstanceByName handles a single instance', () => {
  const only = makeInstance({ name: 'only' });
  assert.equal(resolveInstanceByName(createConfig([only])).name, 'only');
  assert.equal(resolveInstanceByName(createConfig([only]), 'only').name, 'only');
});

test('resolveInstanceByName requires a name when several instances exist', () => {
  const a = makeInstance({ name: 'a' });
  const b = makeInstance({ name: 'b' });
  assert.throws(
    () => resolveInstanceByName(createConfig([a, b])),
    /Multiple Redis instances are configured/,
  );
  assert.equal(resolveInstanceByName(createConfig([a, b]), 'b').name, 'b');
});

test('resolveInstanceByName honors defaultInstance', () => {
  const a = makeInstance({ name: 'a' });
  const b = makeInstance({ name: 'b' });
  const config = createConfig([a, b], 'b');
  assert.equal(resolveInstanceByName(config).name, 'b');
  assert.equal(resolveInstanceByName(config, 'a').name, 'a');
});

test('resolveInstanceByName rejects unknown names', () => {
  const config = createConfig([makeInstance({ name: 'a' })]);
  assert.throws(() => resolveInstanceByName(config, 'missing'), /Unknown Redis instance "missing"/);
  assert.throws(
    () => resolveInstanceByName(createConfig([makeInstance({ name: 'a' })], 'missing')),
    /is not configured/,
  );
});

test('resolveDbIndex validates the index and allowlist', () => {
  const open = makeInstance({ db: 2 });
  assert.equal(resolveDbIndex(open), 2);
  assert.equal(resolveDbIndex(open, 4), 4);

  const restricted = makeInstance({ db: 2, allowedDbs: [0, 2, 4] });
  assert.equal(resolveDbIndex(restricted, 4), 4);
  assert.throws(() => resolveDbIndex(restricted, 3), /not allowed for instance/);

  assert.throws(() => resolveDbIndex(open, -1), /between 0 and 255/);
  assert.throws(() => resolveDbIndex(open, 256), /between 0 and 255/);
  assert.throws(() => resolveDbIndex(open, 1.5), /between 0 and 255/);
});

test('clusterEnabledFromInfo parses the INFO cluster section', () => {
  assert.equal(clusterEnabledFromInfo('# Cluster\r\ncluster_enabled:1\r\n'), true);
  assert.equal(clusterEnabledFromInfo('# Cluster\r\ncluster_enabled:0\r\n'), false);
  assert.equal(clusterEnabledFromInfo('cluster_enabled:1\r\n'), true);
  assert.equal(clusterEnabledFromInfo('note: cluster_enabled:1'), false);
  assert.equal(clusterEnabledFromInfo(''), false);
});

test('RedisManager delegates instance and database resolution', async () => {
  const manager = new RedisManager(createConfig([makeInstance({ name: 'm', db: 1, allowedDbs: [1, 3] })]));
  const instance = manager.resolveInstance();
  assert.equal(instance.name, 'm');
  assert.equal(manager.resolveDb(instance), 1);
  assert.equal(manager.resolveDb(instance, 3), 3);
  assert.throws(() => manager.resolveDb(instance, 2), /not allowed/);
  await manager.close();
});
