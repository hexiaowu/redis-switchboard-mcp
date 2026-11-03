import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ConfigError, errorMessage } from './errors.js';

export type PermissionMode = 'readonly' | 'readwrite';

export const MAX_DB_INDEX = 255;
export const MAX_INSTANCES = 64;

export const DEFAULT_LIMITS = {
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 15_000,
  maxResultItems: 200,
  maxResultChars: 4_000,
  maxResultDepth: 4,
  maxFetchItems: 1_000,
  maxFetchChars: 1_000_000,
  scanCount: 500,
  maxScanIterations: 200,
  scanTimeBudgetMs: 10_000,
  maxConnections: 32,
  /** Idle connections are closed and evicted after this long without activity. 0 disables. */
  idleTimeoutMs: 300_000,
  /** Connections kept warm per (instance, db) before new requests queue behind busy ones. */
  poolSize: 4,
} as const;

export interface InstanceConfig {
  /** Unique name used by the `instance` tool argument. */
  name: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Default logical database when a tool call omits `db`. */
  db: number;
  tls: boolean;
  tlsRejectUnauthorized: boolean;
  mode: PermissionMode;
  /** Allow EVAL/EVALSHA/FCALL. Disabled by default because Lua is arbitrary server-side code. */
  allowScripting: boolean;
  /** When set, tool calls may only target these logical databases. */
  allowedDbs?: number[];
  connectTimeoutMs: number;
  /** 0 disables the client-side command timeout. */
  commandTimeoutMs: number;
  maxResultItems: number;
  maxResultChars: number;
  maxResultDepth: number;
  /** Maximum items a single execute() may fetch for bulk collection commands. */
  maxFetchItems: number;
  /** Maximum bytes/chars a single execute() may fetch for bulk string commands. */
  maxFetchChars: number;
  scanCount: number;
  maxScanIterations: number;
  scanTimeBudgetMs: number;
  maxConnections: number;
  /**
   * Close a cached (instance, db) connection after this many milliseconds
   * without any command. 0 keeps connections until the process exits.
   */
  idleTimeoutMs: number;
  /** Connections pooled per (instance, db); extra concurrent calls queue on busy ones. */
  poolSize: number;
}

export interface AppConfig {
  instances: InstanceConfig[];
  defaultInstance?: string;
}

export interface CliOptions {
  help: boolean;
  version: boolean;
  configPath?: string;
  name?: string;
  db?: number;
  mode?: PermissionMode;
}

export interface LoadConfigOptions {
  cli: CliOptions;
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

const INSTANCE_KEYS = new Set([
  'name',
  'host',
  'port',
  'username',
  'usernameEnv',
  'password',
  'passwordEnv',
  'db',
  'tls',
  'tlsRejectUnauthorized',
  'mode',
  'allowScripting',
  'allowedDbs',
  'connectTimeoutMs',
  'commandTimeoutMs',
  'maxResultItems',
  'maxResultChars',
  'maxResultDepth',
  'maxFetchItems',
  'maxFetchChars',
  'scanCount',
  'maxScanIterations',
  'scanTimeBudgetMs',
  'maxConnections',
  'idleTimeoutMs',
  'poolSize',
]);

const TOP_LEVEL_KEYS = new Set(['instances', 'defaultInstance', '$schema']);

export function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = { help: false, version: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const equalsIndex = arg.indexOf('=');
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);

    switch (flag) {
      case '--help':
      case '-h':
        if (inlineValue !== undefined) {
          throw new ConfigError(`${flag} does not take a value.`);
        }
        options.help = true;
        break;
      case '--version':
      case '-v':
        if (inlineValue !== undefined) {
          throw new ConfigError(`${flag} does not take a value.`);
        }
        options.version = true;
        break;
      case '--readonly':
        throw new ConfigError('--readonly was removed; use --mode readonly|readwrite.');
      case '--config':
      case '--mode':
      case '--name':
      case '--db': {
        const value = inlineValue ?? argv[index + 1];
        if (value === undefined || value === '') {
          throw new ConfigError(`${flag} requires a value.`);
        }
        if (inlineValue === undefined) {
          index += 1;
        }
        if (flag === '--config') {
          options.configPath = value;
        } else if (flag === '--mode') {
          options.mode = parsePermissionMode(value, '--mode');
        } else if (flag === '--name') {
          options.name = value;
        } else {
          options.db = parseIntegerString(value, '--db', 0, MAX_DB_INDEX);
        }
        break;
      }
      default:
        if (flag.startsWith('-')) {
          throw new ConfigError(`Unknown option: ${flag}`);
        }
        throw new ConfigError(`Unexpected positional argument: ${arg}`);
    }
  }

  return options;
}

export function loadConfig(options: LoadConfigOptions): AppConfig {
  const { cli, env } = options;
  const cwd = options.cwd ?? process.cwd();

  if (env.REDIS_READONLY !== undefined && env.REDIS_READONLY.trim() !== '') {
    throw new ConfigError('REDIS_READONLY was removed; use REDIS_MODE=readonly|readwrite.');
  }

  if (cli.configPath !== undefined) {
    assertSingleInstanceEnvNotCombinedWithJsonConfig(env, cli.configPath);
    const config = parseConfigFile(cli.configPath, env, cwd);
    return applyCliFlags(config, cli);
  }

  const envConfigPath = env.REDIS_MCP_CONFIG?.trim();
  if (envConfigPath !== undefined && envConfigPath !== '') {
    assertSingleInstanceEnvNotCombinedWithJsonConfig(env, envConfigPath);
    const config = parseConfigFile(envConfigPath, env, cwd);
    return applyCliFlags(config, cli);
  }

  return buildSingleInstance(cli, env);
}

export function parseConfigFile(path: string, env: NodeJS.ProcessEnv, cwd: string): AppConfig {
  const absolutePath = resolveConfigPath(path, cwd);
  let text: string;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${absolutePath}: ${errorMessage(error)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`Config file ${absolutePath} is not valid JSON: ${errorMessage(error)}`);
  }

  return parseConfigObject(raw, absolutePath, env);
}

export function parseConfigObject(raw: unknown, source: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const object = asObject(raw, source);
  assertKnownKeys(object, TOP_LEVEL_KEYS, source);

  const rawInstances = object.instances;
  if (!Array.isArray(rawInstances)) {
    throw new ConfigError(`${source}: "instances" must be an array.`);
  }
  if (rawInstances.length === 0) {
    throw new ConfigError(`${source}: "instances" must contain at least one instance.`);
  }
  if (rawInstances.length > MAX_INSTANCES) {
    throw new ConfigError(`${source}: too many instances (${rawInstances.length}); the maximum is ${MAX_INSTANCES}.`);
  }

  const instances = rawInstances.map((rawInstance, index) =>
    parseInstance(rawInstance, `${source}: instances[${index}]`, env),
  );

  const names = new Set<string>();
  for (const instance of instances) {
    if (names.has(instance.name)) {
      throw new ConfigError(`${source}: duplicate instance name "${instance.name}".`);
    }
    names.add(instance.name);
  }

  const defaultInstance = readOptionalString(object, 'defaultInstance', source);
  if (defaultInstance !== undefined && !names.has(defaultInstance)) {
    throw new ConfigError(`${source}: defaultInstance "${defaultInstance}" does not match any configured instance.`);
  }

  return {
    instances,
    ...(defaultInstance === undefined ? {} : { defaultInstance }),
  };
}

function assertSingleInstanceEnvNotCombinedWithJsonConfig(
  env: NodeJS.ProcessEnv,
  source: string,
): void {
  const hasHost = env.REDIS_HOST !== undefined && env.REDIS_HOST.trim() !== '';
  const hasPort = env.REDIS_PORT !== undefined && env.REDIS_PORT.trim() !== '';
  const hasMode = env.REDIS_MODE !== undefined && env.REDIS_MODE.trim() !== '';

  if (hasHost || hasPort || hasMode) {
    throw new ConfigError(
      `REDIS_HOST/REDIS_PORT/REDIS_MODE cannot be combined with a JSON config file (${source}); ` +
        'define host/port/mode per instance in the JSON config instead.',
    );
  }
}

function buildSingleInstance(cli: CliOptions, env: NodeJS.ProcessEnv): AppConfig {
  const name = cli.name ?? envString(env, 'REDIS_NAME') ?? 'default';
  validateInstanceName(name, 'REDIS_NAME');

  const host = envString(env, 'REDIS_HOST');
  if (host === undefined) {
    throw new ConfigError('REDIS_HOST is required when not using a JSON config file.');
  }

  const port = envInt(env, 'REDIS_PORT', 1, 65_535);
  if (port === undefined) {
    throw new ConfigError('REDIS_PORT is required when not using a JSON config file.');
  }

  const envMode = envString(env, 'REDIS_MODE');
  const mode =
    cli.mode ??
    (envMode === undefined ? undefined : parsePermissionMode(envMode, 'REDIS_MODE'));
  if (mode === undefined) {
    throw new ConfigError(
      'REDIS_MODE is required when not using a JSON config file ("readonly" or "readwrite").',
    );
  }

  const username = envRawString(env, 'REDIS_USERNAME');
  const password = envRawString(env, 'REDIS_PASSWORD');
  const db = cli.db ?? envInt(env, 'REDIS_DB', 0, MAX_DB_INDEX) ?? 0;

  const allowedDbs = parseDbList(env.REDIS_ALLOWED_DBS);
  if (allowedDbs !== undefined && !allowedDbs.includes(db)) {
    throw new ConfigError(`REDIS_DB (${db}) is not included in REDIS_ALLOWED_DBS (${allowedDbs.join(',')}).`);
  }

  const tls = envBool(env, 'REDIS_TLS') === true;

  const instance: InstanceConfig = {
    name,
    host,
    port,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    db,
    tls,
    tlsRejectUnauthorized: envBool(env, 'REDIS_TLS_REJECT_UNAUTHORIZED') ?? true,
    mode,
    allowScripting: envBool(env, 'REDIS_ALLOW_SCRIPTING') ?? false,
    ...(allowedDbs === undefined ? {} : { allowedDbs }),
    connectTimeoutMs: envInt(env, 'REDIS_CONNECT_TIMEOUT_MS', 100, 120_000) ?? DEFAULT_LIMITS.connectTimeoutMs,
    commandTimeoutMs: envInt(env, 'REDIS_COMMAND_TIMEOUT_MS', 0, 600_000) ?? DEFAULT_LIMITS.commandTimeoutMs,
    maxResultItems: envInt(env, 'REDIS_MAX_RESULT_ITEMS', 1, 10_000) ?? DEFAULT_LIMITS.maxResultItems,
    maxResultChars: envInt(env, 'REDIS_MAX_RESULT_CHARS', 1, 1_000_000) ?? DEFAULT_LIMITS.maxResultChars,
    maxResultDepth: envInt(env, 'REDIS_MAX_RESULT_DEPTH', 1, 20) ?? DEFAULT_LIMITS.maxResultDepth,
    maxFetchItems: envInt(env, 'REDIS_MAX_FETCH_ITEMS', 1, 100_000) ?? DEFAULT_LIMITS.maxFetchItems,
    maxFetchChars: envInt(env, 'REDIS_MAX_FETCH_CHARS', 1, 100_000_000) ?? DEFAULT_LIMITS.maxFetchChars,
    scanCount: envInt(env, 'REDIS_SCAN_COUNT', 1, 10_000) ?? DEFAULT_LIMITS.scanCount,
    maxScanIterations: envInt(env, 'REDIS_MAX_SCAN_ITERATIONS', 1, 10_000) ?? DEFAULT_LIMITS.maxScanIterations,
    scanTimeBudgetMs:
      envInt(env, 'REDIS_SCAN_TIME_BUDGET_MS', 100, 300_000) ?? DEFAULT_LIMITS.scanTimeBudgetMs,
    maxConnections: envInt(env, 'REDIS_MAX_CONNECTIONS', 1, 256) ?? DEFAULT_LIMITS.maxConnections,
    idleTimeoutMs: envInt(env, 'REDIS_IDLE_TIMEOUT_MS', 0, 86_400_000) ?? DEFAULT_LIMITS.idleTimeoutMs,
    poolSize: envInt(env, 'REDIS_POOL_SIZE', 1, 16) ?? DEFAULT_LIMITS.poolSize,
  };

  return { instances: [instance], defaultInstance: instance.name };
}

function parseInstance(raw: unknown, context: string, env: NodeJS.ProcessEnv): InstanceConfig {
  const object = asObject(raw, context);
  if (Object.hasOwn(object, 'readOnly')) {
    throw new ConfigError(
      `${context}: "readOnly" is no longer supported; use "mode": "readonly" | "readwrite".`,
    );
  }
  assertKnownKeys(object, INSTANCE_KEYS, context);

  const name = readOptionalString(object, 'name', context) ?? 'default';
  validateInstanceName(name, `${context}.name`);

  const host = readOptionalString(object, 'host', context);
  if (host === undefined || host.trim() === '') {
    throw new ConfigError(`${context}.host is required.`);
  }

  const port = readOptionalInt(object, 'port', context, 1, 65_535);
  if (port === undefined) {
    throw new ConfigError(`${context}.port is required.`);
  }

  const mode = readPermissionMode(object, 'mode', context);

  const db = readOptionalInt(object, 'db', context, 0, MAX_DB_INDEX) ?? 0;

  const username = resolveSecret(object, 'username', 'usernameEnv', context, env);
  const password = resolveSecret(object, 'password', 'passwordEnv', context, env);

  const tls = readOptionalBool(object, 'tls', context) ?? false;
  const tlsRejectUnauthorized = readOptionalBool(object, 'tlsRejectUnauthorized', context) ?? true;
  const allowScripting = readOptionalBool(object, 'allowScripting', context) ?? false;

  const allowedDbs = readOptionalIntArray(object, 'allowedDbs', context, 0, MAX_DB_INDEX);
  if (allowedDbs !== undefined) {
    if (allowedDbs.length === 0) {
      throw new ConfigError(`${context}.allowedDbs must contain at least one database index.`);
    }
    if (!allowedDbs.includes(db)) {
      throw new ConfigError(`${context}: db ${db} is not included in allowedDbs (${allowedDbs.join(',')}).`);
    }
  }

  return {
    name,
    host,
    port,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    db,
    tls,
    tlsRejectUnauthorized,
    mode,
    allowScripting,
    ...(allowedDbs === undefined ? {} : { allowedDbs }),
    connectTimeoutMs: readOptionalInt(object, 'connectTimeoutMs', context, 100, 120_000) ?? DEFAULT_LIMITS.connectTimeoutMs,
    commandTimeoutMs: readOptionalInt(object, 'commandTimeoutMs', context, 0, 600_000) ?? DEFAULT_LIMITS.commandTimeoutMs,
    maxResultItems: readOptionalInt(object, 'maxResultItems', context, 1, 10_000) ?? DEFAULT_LIMITS.maxResultItems,
    maxResultChars: readOptionalInt(object, 'maxResultChars', context, 1, 1_000_000) ?? DEFAULT_LIMITS.maxResultChars,
    maxResultDepth: readOptionalInt(object, 'maxResultDepth', context, 1, 20) ?? DEFAULT_LIMITS.maxResultDepth,
    maxFetchItems:
      readOptionalInt(object, 'maxFetchItems', context, 1, 100_000) ?? DEFAULT_LIMITS.maxFetchItems,
    maxFetchChars:
      readOptionalInt(object, 'maxFetchChars', context, 1, 100_000_000) ??
      DEFAULT_LIMITS.maxFetchChars,
    scanCount: readOptionalInt(object, 'scanCount', context, 1, 10_000) ?? DEFAULT_LIMITS.scanCount,
    maxScanIterations:
      readOptionalInt(object, 'maxScanIterations', context, 1, 10_000) ??
      DEFAULT_LIMITS.maxScanIterations,
    scanTimeBudgetMs:
      readOptionalInt(object, 'scanTimeBudgetMs', context, 100, 300_000) ??
      DEFAULT_LIMITS.scanTimeBudgetMs,
    maxConnections:
      readOptionalInt(object, 'maxConnections', context, 1, 256) ?? DEFAULT_LIMITS.maxConnections,
    idleTimeoutMs:
      readOptionalInt(object, 'idleTimeoutMs', context, 0, 86_400_000) ?? DEFAULT_LIMITS.idleTimeoutMs,
    poolSize: readOptionalInt(object, 'poolSize', context, 1, 16) ?? DEFAULT_LIMITS.poolSize,
  };
}

function applyCliFlags(config: AppConfig, cli: CliOptions): AppConfig {
  if (cli.name !== undefined || cli.db !== undefined) {
    throw new ConfigError(
      '--name and --db are only supported for single-instance environment configuration; edit the JSON config instead.',
    );
  }

  const mode = cli.mode;
  if (mode === undefined) {
    return config;
  }

  return {
    ...config,
    instances: config.instances.map((instance) => ({ ...instance, mode })),
  };
}

function resolveSecret(
  object: Record<string, unknown>,
  valueKey: string,
  envKey: string,
  context: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const inlineValue = readOptionalString(object, valueKey, context);
  const envName = readOptionalString(object, envKey, context);

  if (inlineValue !== undefined && envName !== undefined) {
    throw new ConfigError(`${context}: ${valueKey} and ${envKey} cannot be used together.`);
  }
  if (envName === undefined) {
    return inlineValue;
  }
  if (envName.trim() === '') {
    throw new ConfigError(`${context}.${envKey} must not be empty.`);
  }
  if (!Object.hasOwn(env, envName)) {
    throw new ConfigError(`${context}.${envKey} references missing environment variable "${envName}".`);
  }
  const value = env[envName];
  if (typeof value !== 'string') {
    throw new ConfigError(`${context}.${envKey} environment variable "${envName}" must be a string.`);
  }
  return value;
}

function parseDbList(raw: string | undefined): number[] | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (values.length === 0) {
    return undefined;
  }
  const parsed = values.map((value) => parseIntegerString(value, 'REDIS_ALLOWED_DBS entry', 0, MAX_DB_INDEX));
  return [...new Set(parsed)].sort((left, right) => left - right);
}

function parseIntegerString(raw: string, label: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${label} must be a non-negative integer, got "${raw}".`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${label} must be between ${min} and ${max}, got "${raw}".`);
  }
  return value;
}

function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function envRawString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

function envInt(env: NodeJS.ProcessEnv, key: string, min: number, max: number): number | undefined {
  const value = envString(env, key);
  return value === undefined ? undefined : parseIntegerString(value, key, min, max);
}

function envBool(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const value = envString(env, key);
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new ConfigError(`${key} must be a boolean (1/0, true/false), got "${value}".`);
}

function resolveConfigPath(path: string, cwd: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(cwd, path);
}

function readPermissionMode(
  object: Record<string, unknown>,
  key: string,
  context: string,
): PermissionMode {
  const value = readOptionalString(object, key, context);
  if (value === undefined) {
    throw new ConfigError(`${context}.${key} is required ("readonly" or "readwrite").`);
  }
  return parsePermissionMode(value, `${context}.${key}`);
}

function parsePermissionMode(value: string, label: string): PermissionMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'readonly') {
    return 'readonly';
  }
  if (normalized === 'readwrite') {
    return 'readwrite';
  }
  throw new ConfigError(`${label} must be "readonly" or "readwrite", got "${value}".`);
}

function validateInstanceName(name: string, label: string): void {
  if (name.length === 0 || name.length > 64) {
    throw new ConfigError(`${label} must be 1-64 characters long.`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new ConfigError(`${label} may only contain letters, digits, dots, underscores and dashes.`);
  }
}

function asObject(raw: unknown, context: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${context} must be a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

function assertKnownKeys(object: Record<string, unknown>, allowed: Set<string>, context: string): void {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`${context} contains unknown field(s): ${unknown.join(', ')}.`);
  }
}

function readOptionalString(object: Record<string, unknown>, key: string, context: string): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ConfigError(`${context}.${key} must be a string.`);
  }
  return value;
}

function readOptionalInt(
  object: Record<string, unknown>,
  key: string,
  context: string,
  min: number,
  max: number,
): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${context}.${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function readOptionalBool(object: Record<string, unknown>, key: string, context: string): boolean | undefined {
  const value = object[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${context}.${key} must be a boolean.`);
  }
  return value;
}

function readOptionalIntArray(
  object: Record<string, unknown>,
  key: string,
  context: string,
  min: number,
  max: number,
): number[] | undefined {
  const value = object[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(`${context}.${key} must be an array of integers.`);
  }
  const parsed = value.map((entry) => {
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < min || entry > max) {
      throw new ConfigError(`${context}.${key} entries must be integers between ${min} and ${max}.`);
    }
    return entry;
  });
  return [...new Set(parsed)].sort((left, right) => left - right);
}

