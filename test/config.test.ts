import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODE, loadConfig, parseCli, parseConfigObject } from '../src/config.js';

const baseInstance = { name: 'a', host: 'localhost', port: 6_379, mode: 'readwrite' };

test('parseCli parses flags and values', () => {
  const cli = parseCli(['--config', 'config.json', '--mode', 'readonly', '--db', '3', '--name', 'local']);
  assert.equal(cli.help, false);
  assert.equal(cli.version, false);
  assert.equal(cli.configPath, 'config.json');
  assert.equal(cli.mode, 'readonly');
  assert.equal(cli.db, 3);
  assert.equal(cli.name, 'local');

  assert.equal(parseCli(['--db=4']).db, 4);
  assert.equal(parseCli(['-h']).help, true);
  assert.equal(parseCli(['-v']).version, true);
});

test('parseCli rejects invalid input and the removed --url flag', () => {
  assert.throws(() => parseCli(['--db']), /requires a value/);
  assert.throws(() => parseCli(['--db', '300']), /between 0 and 255/);
  assert.throws(() => parseCli(['--readonly']), /removed/);
  assert.throws(() => parseCli(['--mode', 'invalid']), /readonly.*readwrite/);
  assert.throws(() => parseCli(['--unknown']), /Unknown option/);
  assert.throws(() => parseCli(['--url', 'redis://localhost']), /Unknown option/);
  assert.throws(() => parseCli(['positional']), /Unexpected positional argument/);
});

test('parseConfigObject supports multiple instances and passwordEnv', () => {
  const config = parseConfigObject(
    {
      defaultInstance: 'local',
      instances: [
        {
          name: 'local',
          host: '127.0.0.1',
          port: 6380,
          password: 'secret',
          db: 2,
          mode: 'readonly',
          allowedDbs: [0, 2, 4],
          maxResultItems: 10,
        },
        {
          name: 'prod',
          host: 'redis.prod',
          port: 6381,
          mode: 'readwrite',
          username: 'app',
          passwordEnv: 'PROD_REDIS_PASSWORD',
          db: 1,
        },
      ],
    },
    'test-config',
    { PROD_REDIS_PASSWORD: 'prod-secret' },
  );

  assert.equal(config.defaultInstance, 'local');
  assert.equal(config.instances.length, 2);

  const local = config.instances[0]!;
  assert.equal(local.name, 'local');
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.port, 6380);
  assert.equal(local.password, 'secret');
  assert.equal(local.db, 2);
  assert.equal(local.mode, 'readonly');
  assert.deepEqual(local.allowedDbs, [0, 2, 4]);
  assert.equal(local.maxResultItems, 10);

  const prod = config.instances[1]!;
  assert.equal(prod.host, 'redis.prod');
  assert.equal(prod.port, 6381);
  assert.equal(prod.username, 'app');
  assert.equal(prod.password, 'prod-secret');
  assert.equal(prod.db, 1);
});

test('parseConfigObject requires host and port', () => {
  assert.throws(
    () => parseConfigObject({ instances: [{ name: 'a', port: 6_379 }] }, 'test'),
    /host is required/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [{ name: 'a', host: 'localhost' }] }, 'test'),
    /port is required/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [{ name: 'a', host: '   ', port: 6_379 }] }, 'test'),
    /host is required/,
  );
  assert.throws(
    () =>
      parseConfigObject(
        { instances: [{ name: 'a', host: 'localhost', port: 6_379, mode: 'admin' }] },
        'test',
      ),
    /readonly.*readwrite/,
  );
});

test('parseConfigObject defaults mode to readonly when omitted', () => {
  const config = parseConfigObject(
    { instances: [{ name: 'a', host: 'localhost', port: 6_379 }] },
    'test',
  );
  assert.equal(config.instances[0]!.mode, DEFAULT_MODE);
  assert.equal(config.instances[0]!.mode, 'readonly');
});

test('parseConfigObject keeps an explicit readwrite mode', () => {
  const config = parseConfigObject(
    { instances: [{ name: 'a', host: 'localhost', port: 6_379, mode: 'readwrite' }] },
    'test',
  );
  assert.equal(config.instances[0]!.mode, 'readwrite');
});

test('parseConfigObject rejects invalid mode values', () => {
  assert.throws(
    () =>
      parseConfigObject(
        { instances: [{ name: 'a', host: 'localhost', port: 6_379, mode: 'admin' }] },
        'test',
      ),
    /readonly.*readwrite/,
  );
});

test('parseConfigObject rejects the removed url field', () => {
  assert.throws(
    () => parseConfigObject({ instances: [{ name: 'a', url: 'redis://localhost' }] }, 'test'),
    /unknown field/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [{ ...baseInstance, readOnly: true }] }, 'test'),
    /readOnly.*no longer supported/,
  );
});

test('parseConfigObject rejects invalid configurations', () => {
  assert.throws(
    () => parseConfigObject({ instances: [baseInstance], nope: 1 }, 'test'),
    /unknown field/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [{ ...baseInstance, nope: 1 }] }, 'test'),
    /unknown field/,
  );
  assert.throws(() => parseConfigObject({ instances: [] }, 'test'), /at least one instance/);
  assert.throws(
    () => parseConfigObject({ instances: [baseInstance, baseInstance] }, 'test'),
    /duplicate instance name/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [{ ...baseInstance, db: 300 }] }, 'test'),
    /between 0 and 255/,
  );
  assert.throws(
    () =>
      parseConfigObject(
        { instances: [{ ...baseInstance, db: 3, allowedDbs: [0, 1] }] },
        'test',
      ),
    /not included in allowedDbs/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [baseInstance], defaultInstance: 'missing' }, 'test'),
    /does not match any configured instance/,
  );
  assert.throws(
    () =>
      parseConfigObject(
        { instances: [{ ...baseInstance, password: 'x', passwordEnv: 'Y' }] },
        'test',
        { Y: 'y' },
      ),
    /cannot be used together/,
  );
  assert.throws(
    () =>
      parseConfigObject(
        { instances: [{ ...baseInstance, passwordEnv: 'MISSING' }] },
        'test',
        {},
      ),
    /missing environment variable/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [{ ...baseInstance, allowedDbs: [] }] }, 'test'),
    /at least one database index/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [{ ...baseInstance, maxConnections: 0 }] }, 'test'),
    /between 1 and 256/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [{ ...baseInstance, scanTimeBudgetMs: 50 }] }, 'test'),
    /between 100 and 300000/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [{ ...baseInstance, maxFetchItems: 0 }] }, 'test'),
    /between 1 and 100000/,
  );
  assert.throws(
    () => parseConfigObject({ instances: [{ ...baseInstance, maxFetchChars: 0 }] }, 'test'),
    /between 1 and 100000000/,
  );
  assert.throws(
    () =>
      parseConfigObject(
        { instances: [{ ...baseInstance, passwordEnv: '__proto__' }] },
        'test',
        {},
      ),
    /missing environment variable/,
  );
  assert.throws(
    () =>
      parseConfigObject(
        { instances: [{ ...baseInstance, passwordEnv: 'NOT_A_STRING' }] },
        'test',
        { NOT_A_STRING: 123 as unknown as string },
      ),
    /must be a string/,
  );
});

test('parseConfigObject accepts $schema and defaults', () => {
  const config = parseConfigObject(
    {
      $schema: 'https://example.com/schema.json',
      instances: [{ name: 'only', host: 'redis.example', port: 6_390, mode: 'readwrite' }],
    },
    'test',
  );
  const instance = config.instances[0]!;
  assert.equal(instance.host, 'redis.example');
  assert.equal(instance.port, 6_390);
  assert.equal(instance.db, 0);
  assert.equal(instance.mode, 'readwrite');
  assert.equal(instance.allowScripting, false);
  assert.equal(instance.tls, false);
  assert.equal(instance.connectTimeoutMs, 5_000);
  assert.equal(instance.commandTimeoutMs, 15_000);
  assert.equal(instance.scanTimeBudgetMs, 10_000);
  assert.equal(instance.maxConnections, 32);
  assert.equal(instance.maxFetchItems, 1_000);
  assert.equal(instance.maxFetchChars, 1_000_000);
});

test('loadConfig builds a single instance from environment variables', () => {
  const config = loadConfig({
    cli: parseCli([]),
    env: {
      REDIS_HOST: 'redis.example',
      REDIS_PORT: '6380',
      REDIS_DB: '2',
      REDIS_PASSWORD: 'pass',
      REDIS_MODE: 'readonly',
      REDIS_ALLOWED_DBS: '0,2,4',
      REDIS_NAME: 'env',
    },
  });

  const instance = config.instances[0]!;
  assert.equal(config.instances.length, 1);
  assert.equal(config.defaultInstance, 'env');
  assert.equal(instance.name, 'env');
  assert.equal(instance.host, 'redis.example');
  assert.equal(instance.port, 6380);
  assert.equal(instance.db, 2);
  assert.equal(instance.password, 'pass');
  assert.equal(instance.mode, 'readonly');
  assert.deepEqual(instance.allowedDbs, [0, 2, 4]);
});

test('loadConfig requires REDIS_HOST and REDIS_PORT for environment configuration', () => {
  assert.throws(
    () => loadConfig({ cli: parseCli([]), env: { REDIS_PORT: '6379' } }),
    /REDIS_HOST is required/,
  );
  assert.throws(
    () => loadConfig({ cli: parseCli([]), env: { REDIS_HOST: 'localhost' } }),
    /REDIS_PORT is required/,
  );
  assert.throws(
    () => loadConfig({ cli: parseCli([]), env: { REDIS_HOST: '   ', REDIS_PORT: '6379' } }),
    /REDIS_HOST is required/,
  );
});

test('loadConfig defaults REDIS_MODE to readonly for environment configuration', () => {
  const config = loadConfig({
    cli: parseCli([]),
    env: { REDIS_HOST: 'localhost', REDIS_PORT: '6379' },
  });
  assert.equal(config.instances[0]!.mode, DEFAULT_MODE);
  assert.equal(config.instances[0]!.mode, 'readonly');
});

test('REDIS_MODE is case-insensitive and overrides the readonly default', () => {
  const config = loadConfig({
    cli: parseCli([]),
    env: { REDIS_HOST: 'localhost', REDIS_PORT: '6379', REDIS_MODE: 'ReadWrite' },
  });
  assert.equal(config.instances[0]!.mode, 'readwrite');
});

test('environment passwords keep leading and trailing whitespace', () => {
  const config = loadConfig({
    cli: parseCli([]),
    env: {
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      REDIS_MODE: 'readwrite',
      REDIS_PASSWORD: '  secret with spaces  ',
    },
  });
  assert.equal(config.instances[0]!.password, '  secret with spaces  ');
});

test('CLI overrides environment values', () => {
  const config = loadConfig({
    cli: parseCli(['--db', '3', '--name', 'cli', '--mode', 'readonly']),
    env: {
      REDIS_HOST: 'envhost',
      REDIS_PORT: '7000',
      REDIS_USERNAME: 'u',
      REDIS_PASSWORD: 'p',
      REDIS_DB: '6',
      REDIS_ALLOWED_DBS: '3,6',
    },
  });

  const instance = config.instances[0]!;
  assert.equal(instance.name, 'cli');
  assert.equal(instance.host, 'envhost');
  assert.equal(instance.port, 7000);
  assert.equal(instance.username, 'u');
  assert.equal(instance.password, 'p');
  assert.equal(instance.db, 3);
  assert.equal(instance.mode, 'readonly');
});

test('loadConfig rejects invalid environment values', () => {
  const base = { REDIS_HOST: 'localhost', REDIS_PORT: '6379', REDIS_MODE: 'readwrite' };
  const build = (env: NodeJS.ProcessEnv) => loadConfig({ cli: parseCli([]), env });

  assert.throws(() => build({ ...base, REDIS_PORT: 'abc' }), /REDIS_PORT must be a non-negative integer/);
  assert.throws(() => build({ ...base, REDIS_PORT: '70000' }), /REDIS_PORT must be between/);
  assert.throws(() => build({ ...base, REDIS_MODE: 'maybe' }), /readonly.*readwrite/);
  assert.throws(() => build({ ...base, REDIS_READONLY: '1' }), /REDIS_READONLY was removed/);
  assert.throws(() => build({ ...base, REDIS_DB: '300' }), /REDIS_DB must be between/);
  assert.throws(
    () => build({ ...base, REDIS_DB: '3', REDIS_ALLOWED_DBS: '0,1' }),
    /not included in REDIS_ALLOWED_DBS/,
  );
});

const directory = mkdtempSync(join(tmpdir(), 'redis-switchboard-mcp-'));

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('loadConfig reads a JSON config file from REDIS_MCP_CONFIG', () => {
  writeFileSync(
    join(directory, 'config.json'),
    JSON.stringify({
      instances: [{ name: 'file-instance', host: 'filehost', port: 6390, mode: 'readwrite' }],
    }),
  );

  const config = loadConfig({
    cli: parseCli([]),
    env: { REDIS_MCP_CONFIG: 'config.json' },
    cwd: directory,
  });

  assert.equal(config.instances[0]!.name, 'file-instance');
  assert.equal(config.instances[0]!.host, 'filehost');
  assert.equal(config.instances[0]!.port, 6390);
});

test('loadConfig accepts --config and applies --mode to every instance', () => {
  writeFileSync(
    join(directory, 'multi.json'),
    JSON.stringify({
      instances: [
        { name: 'a', host: 'a.example', port: 6_379, mode: 'readwrite' },
        { name: 'b', host: 'b.example', port: 6_379, mode: 'readonly' },
      ],
    }),
  );

  const config = loadConfig({
    cli: parseCli(['--config', 'multi.json', '--mode', 'readonly']),
    env: {},
    cwd: directory,
  });

  assert.equal(config.instances.length, 2);
  assert.equal(config.instances.every((instance) => instance.mode === 'readonly'), true);
});

test('--mode overrides JSON instances that omit mode', () => {
  writeFileSync(
    join(directory, 'modeless.json'),
    JSON.stringify({
      instances: [
        { name: 'a', host: 'a.example', port: 6_379 },
        { name: 'b', host: 'b.example', port: 6_379, mode: 'readonly' },
      ],
    }),
  );

  const config = loadConfig({
    cli: parseCli(['--config', 'modeless.json', '--mode', 'readwrite']),
    env: {},
    cwd: directory,
  });

  assert.equal(config.instances.every((instance) => instance.mode === 'readwrite'), true);
});

test('JSON config without mode defaults every instance to readonly', () => {
  writeFileSync(
    join(directory, 'default-mode.json'),
    JSON.stringify({
      instances: [{ name: 'a', host: 'a.example', port: 6_379 }],
    }),
  );

  const config = loadConfig({
    cli: parseCli(['--config', 'default-mode.json']),
    env: {},
    cwd: directory,
  });

  assert.equal(config.instances[0]!.mode, DEFAULT_MODE);
  assert.equal(config.instances[0]!.mode, 'readonly');
});

test('--config conflicts with --db', () => {
  assert.throws(
    () =>
      loadConfig({
        cli: parseCli(['--config', 'multi.json', '--db', '2']),
        env: {},
        cwd: directory,
      }),
    /only supported for single-instance/,
  );
});

test('JSON config and REDIS_HOST/REDIS_PORT cannot be combined', () => {
  writeFileSync(
    join(directory, 'mixed.json'),
    JSON.stringify({
      instances: [{ name: 'mixed', host: 'mixedhost', port: 6_379, mode: 'readwrite' }],
    }),
  );

  assert.throws(
    () =>
      loadConfig({
        cli: parseCli(['--config', 'mixed.json']),
        env: { REDIS_HOST: 'envhost' },
        cwd: directory,
      }),
    /cannot be combined/,
  );

  assert.throws(
    () =>
      loadConfig({
        cli: parseCli([]),
        env: { REDIS_MCP_CONFIG: 'mixed.json', REDIS_PORT: '6379' },
        cwd: directory,
      }),
    /cannot be combined/,
  );

  assert.throws(
    () =>
      loadConfig({
        cli: parseCli([]),
        env: { REDIS_MCP_CONFIG: 'mixed.json', REDIS_MODE: 'readonly' },
        cwd: directory,
      }),
    /cannot be combined/,
  );

  // Empty values are not a connection method and do not conflict.
  const config = loadConfig({
    cli: parseCli([]),
    env: { REDIS_MCP_CONFIG: 'mixed.json', REDIS_HOST: '', REDIS_PORT: '' },
    cwd: directory,
  });
  assert.equal(config.instances[0]!.host, 'mixedhost');
});

test('config files with a UTF-8 BOM are accepted', () => {
  writeFileSync(
    join(directory, 'bom.json'),
    `\uFEFF${JSON.stringify({
      instances: [{ name: 'bom', host: 'bomhost', port: 6_379, mode: 'readwrite' }],
    })}`,
  );

  const config = loadConfig({
    cli: parseCli([]),
    env: { REDIS_MCP_CONFIG: 'bom.json' },
    cwd: directory,
  });
  assert.equal(config.instances[0]!.name, 'bom');
  assert.equal(config.instances[0]!.host, 'bomhost');
  assert.equal(config.instances[0]!.port, 6_379);
});

test('config file errors are reported clearly', () => {
  writeFileSync(join(directory, 'bad.json'), '{ not json');

  assert.throws(
    () => loadConfig({ cli: parseCli([]), env: { REDIS_MCP_CONFIG: 'bad.json' }, cwd: directory }),
    /not valid JSON/,
  );
  assert.throws(
    () => loadConfig({ cli: parseCli([]), env: { REDIS_MCP_CONFIG: 'missing.json' }, cwd: directory }),
    /Cannot read config file/,
  );
});
