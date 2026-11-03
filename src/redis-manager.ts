import { Redis, type RedisOptions } from 'ioredis';
import { AppError, errorMessage } from './errors.js';
import { MAX_DB_INDEX, type AppConfig, type InstanceConfig } from './config.js';

/**
 * The subset of the ioredis client used by the tools. Keeping this narrow makes
 * the tool handlers testable without a live Redis server.
 */
export interface RedisClient {
  call(command: string, ...args: (string | number | Buffer)[]): Promise<unknown>;
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>;
  type(key: string): Promise<string>;
  pttl(key: string): Promise<number>;
  strlen(key: string): Promise<number>;
  llen(key: string): Promise<number>;
  hlen(key: string): Promise<number>;
  scard(key: string): Promise<number>;
  zcard(key: string): Promise<number>;
  xlen(key: string): Promise<number>;
}

interface ManagedRedisClient extends RedisClient {
  shutdown(): Promise<void>;
}

export interface RedisProvider {
  resolveInstance(name?: string): InstanceConfig;
  resolveDb(instance: InstanceConfig, db?: number): number;
  getClient(instance: InstanceConfig, db: number): Promise<RedisClient>;
}

/**
 * A connection wrapper that guarantees the logical database before any command
 * runs.
 *
 * ioredis selects `db` during connection setup and deliberately swallows a
 * failed SELECT (it emits an error event but still resolves connect()). That
 * means a connection can be "connected" while still pointing at db 0. This
 * wrapper therefore always connects ioredis to db 0 and explicitly issues
 * SELECT for db > 0. A failed SELECT rejects, disconnects the socket, evicts the
 * client from the cache, and every command waits for a successful verification.
 */
class VerifiedClient implements ManagedRedisClient {
  private readonly raw: Redis;
  private readonly instance: InstanceConfig;
  private readonly db: number;
  private readonly onInvalid: () => void;

  private verified = false;
  private verification: Promise<void> | undefined;
  private generation = 0;

  constructor(raw: Redis, instance: InstanceConfig, db: number, onInvalid: () => void) {
    this.raw = raw;
    this.instance = instance;
    this.db = db;
    this.onInvalid = onInvalid;

    this.startVerification();
    raw.on('ready', () => {
      this.startVerification();
    });
    raw.on('close', () => {
      this.invalidate();
    });
    raw.on('end', () => {
      this.invalidate();
    });
    raw.on('reconnecting', () => {
      this.invalidate();
    });
  }

  async waitUntilVerified(): Promise<void> {
    await this.ensureVerified();
  }

  async call(command: string, ...args: (string | number | Buffer)[]): Promise<unknown> {
    const client = await this.ensureVerified();
    return client.call(command, ...args);
  }

  async scan(
    cursor: string | number,
    ...args: (string | number)[]
  ): Promise<[string, string[]]> {
    const client = await this.ensureVerified();
    const reply = await client.call('SCAN', cursor, ...args);
    return reply as [string, string[]];
  }

  async type(key: string): Promise<string> {
    const client = await this.ensureVerified();
    return client.type(key);
  }

  async pttl(key: string): Promise<number> {
    const client = await this.ensureVerified();
    return client.pttl(key);
  }

  async strlen(key: string): Promise<number> {
    const client = await this.ensureVerified();
    return client.strlen(key);
  }

  async llen(key: string): Promise<number> {
    const client = await this.ensureVerified();
    return client.llen(key);
  }

  async hlen(key: string): Promise<number> {
    const client = await this.ensureVerified();
    return client.hlen(key);
  }

  async scard(key: string): Promise<number> {
    const client = await this.ensureVerified();
    return client.scard(key);
  }

  async zcard(key: string): Promise<number> {
    const client = await this.ensureVerified();
    return client.zcard(key);
  }

  async xlen(key: string): Promise<number> {
    const client = await this.ensureVerified();
    return client.xlen(key);
  }

  async shutdown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2_000);
    });

    try {
      await Promise.race([this.raw.quit().catch(() => undefined), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.raw.disconnect();
    }
  }

  private invalidate(): void {
    this.verified = false;
    this.verification = undefined;
    this.generation += 1;
  }

  private startVerification(): void {
    this.verified = false;
    this.generation += 1;
    const generation = this.generation;
    this.verification = this.verify(generation);
    // The verification may fail before any caller awaits it (for example on a
    // background reconnect). Attach a no-op catch so Node does not report an
    // unhandled rejection; callers still receive the rejection.
    this.verification.catch(() => undefined);
  }

  private async verify(generation: number): Promise<void> {
    if (this.db === 0) {
      // Redis connections start on db 0, so no SELECT is needed. Avoiding the
      // round trip also keeps restricted ACL users that lack +select working
      // for the default database.
      if (generation === this.generation) {
        this.verified = true;
      }
      return;
    }

    try {
      await this.raw.select(this.db);
      if (generation === this.generation) {
        this.verified = true;
      }
    } catch (error) {
      // A verification from a previous connection generation must not tear down
      // the new connection.
      if (generation === this.generation) {
        if (this.isTransportError(error)) {
          // ioredis is reconnecting. Keep the client and let ensureVerified()
          // wait for the next ready event and retry instead of destroying the
          // reconnect attempt.
          this.verification = undefined;
        } else {
          this.raw.disconnect();
          this.onInvalid();
        }
      }
      throw this.verificationError(error);
    }
  }

  private async ensureVerified(): Promise<Redis> {
    let transportRetries = 0;

    while (!this.verified) {
      if (this.verification === undefined) {
        this.startVerification();
      }
      const verification = this.verification;
      if (verification === undefined) {
        continue;
      }

      try {
        await verification;
      } catch (error) {
        // A newer verification may have replaced this promise while it was in
        // flight (for example after a reconnect). Retry with the current one.
        if (this.verification !== undefined && this.verification !== verification) {
          continue;
        }

        if (this.isTransportVerificationError(error) && transportRetries < 2) {
          transportRetries += 1;
          if (this.verification === verification) {
            this.verification = undefined;
          }
          await this.waitForReady();
          continue;
        }

        throw error;
      }
    }

    return this.raw;
  }

  private isTransportError(error: unknown): boolean {
    const message = errorMessage(error);
    return /Stream isn't writeable|Connection is closed|Command timed out|MaxRetriesPerRequest|ECONN|EPIPE|ENOTFOUND|EAI_AGAIN/i.test(
      message,
    );
  }

  private isTransportVerificationError(error: unknown): boolean {
    return error instanceof AppError && error.code === 'CONNECTION_ERROR';
  }

  private async waitForReady(): Promise<void> {
    if (this.raw.status === 'ready') {
      return;
    }
    if (this.raw.status === 'end') {
      throw new AppError(
        'CONNECTION_ERROR',
        `[${this.instance.name}] Redis connection has ended; a new request will create a fresh connection.`,
      );
    }

    const timeoutMs = Math.max(5_000, this.instance.connectTimeoutMs);
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        this.raw.off('ready', onReady);
        this.raw.off('end', onEnd);
      };

      const onReady = (): void => {
        cleanup();
        resolve();
      };

      const onEnd = (): void => {
        cleanup();
        reject(
          new AppError(
            'CONNECTION_ERROR',
            `[${this.instance.name}] Redis connection ended while waiting to reconnect.`,
          ),
        );
      };

      timer = setTimeout(() => {
        cleanup();
        reject(
          new AppError(
            'CONNECTION_ERROR',
            `[${this.instance.name}] Timed out after ${timeoutMs} ms waiting for Redis to reconnect.`,
          ),
        );
      }, timeoutMs);

      this.raw.once('ready', onReady);
      this.raw.once('end', onEnd);
    });
  }

  private verificationError(error: unknown): AppError {
    const message = errorMessage(error);
    const prefix = `[${this.instance.name}] Redis ${formatEndpoint(this.instance)} db ${this.db}: `;

    if (/SELECT is not allowed in cluster mode/i.test(message)) {
      return new AppError(
        'DB_ERROR',
        `${prefix}this is a Redis Cluster, which only supports logical database 0.`,
        { cause: error },
      );
    }

    if (/DB index is out of range/i.test(message)) {
      return new AppError(
        'DB_ERROR',
        `${prefix}database ${this.db} does not exist on this server (check the server's "databases" setting).`,
        { cause: error },
      );
    }

    if (/NOPERM|no permissions|permission denied/i.test(message)) {
      return new AppError(
        'DB_ERROR',
        `${prefix}the Redis user is not allowed to SELECT this database. Grant +select for the user or use db 0.`,
        { cause: error },
      );
    }

    if (/Command timed out|Stream isn't writeable|Connection is closed|ECONN|EPIPE|ENOTFOUND/i.test(message)) {
      return new AppError('CONNECTION_ERROR', `${prefix}cannot verify the logical database: ${message}`, {
        cause: error,
      });
    }

    return new AppError('CONNECTION_ERROR', `${prefix}could not select database ${this.db}: ${message}`, {
      cause: error,
    });
  }
}

/**
 * One client per (instance, logical database). The cache stores the connection
 * promise so concurrent first-use calls share one client.
 */
export class RedisManager implements RedisProvider {
  private readonly clients = new Map<string, Promise<ManagedRedisClient>>();
  private readonly clusterFlags = new Map<string, Promise<boolean>>();

  constructor(private readonly config: AppConfig) {}

  resolveInstance(name?: string): InstanceConfig {
    return resolveInstanceByName(this.config, name);
  }

  resolveDb(instance: InstanceConfig, db?: number): number {
    return resolveDbIndex(instance, db);
  }

  async getClient(instance: InstanceConfig, db: number): Promise<RedisClient> {
    const resolvedDb = resolveDbIndex(instance, db);
    const key = `${instance.name}\u0000${resolvedDb}`;

    const existing = this.clients.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const connectionCount = this.countClients(instance.name);
    if (connectionCount >= instance.maxConnections) {
      throw new AppError(
        'DB_ERROR',
        `Instance "${instance.name}" already has ${connectionCount} open database connections ` +
          `(maxConnections=${instance.maxConnections}). Reuse an existing database or raise the limit.`,
      );
    }

    let promise: Promise<ManagedRedisClient> | undefined;
    const evictIfCurrent = (): void => {
      if (promise !== undefined && this.clients.get(key) === promise) {
        this.clients.delete(key);
      }
    };

    promise = this.createAndConnect(instance, resolvedDb, evictIfCurrent).catch((error: unknown) => {
      evictIfCurrent();
      throw error;
    });
    this.clients.set(key, promise);
    return promise;
  }

  async close(): Promise<void> {
    const pending = [...this.clients.values()];
    this.clients.clear();
    this.clusterFlags.clear();

    await Promise.allSettled(
      pending.map(async (clientPromise) => {
        const client = await clientPromise.catch(() => null);
        if (client !== null) {
          await client.shutdown();
        }
      }),
    );
  }

  private countClients(instanceName: string): number {
    const prefix = `${instanceName}\u0000`;
    let count = 0;
    for (const key of this.clients.keys()) {
      if (key.startsWith(prefix)) {
        count += 1;
      }
    }
    return count;
  }

  private async createAndConnect(
    instance: InstanceConfig,
    db: number,
    onInvalid: () => void,
  ): Promise<ManagedRedisClient> {
    const knownCluster = this.clusterFlags.get(instance.name);
    if (knownCluster !== undefined && (await knownCluster) && db !== 0) {
      throw clusterDbError(instance, db);
    }

    const client = new Redis(buildRedisOptions(instance));
    // ioredis emits 'error' for background reconnects. Without a listener, an
    // EventEmitter 'error' would crash the process. Command failures are
    // reported through the command promises instead.
    let lastConnectionError: unknown;
    client.on('error', (error: unknown) => {
      lastConnectionError = error;
    });

    try {
      await client.connect();
    } catch (error) {
      client.disconnect();
      // connect() sometimes rejects with a generic "Connection is closed."
      // after the real socket error has already been emitted.
      throw this.toConnectionError(instance, db, lastConnectionError ?? error);
    }

    const managed = new VerifiedClient(client, instance, db, onInvalid);
    try {
      await managed.waitUntilVerified();
    } catch (error) {
      client.disconnect();
      const message = error instanceof Error ? error.message : '';
      const causeMessage =
        error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
      if (/SELECT is not allowed in cluster mode/i.test(`${message} ${causeMessage}`)) {
        this.clusterFlags.set(instance.name, Promise.resolve(true));
      }
      throw error;
    }

    const cluster = await this.getClusterFlag(instance, client);
    if (cluster && db !== 0) {
      client.disconnect();
      onInvalid();
      throw clusterDbError(instance, db);
    }

    return managed;
  }

  private getClusterFlag(instance: InstanceConfig, client: Redis): Promise<boolean> {
    const cached = this.clusterFlags.get(instance.name);
    if (cached !== undefined) {
      return cached;
    }

    const flag = client
      .info('cluster')
      .then(clusterEnabledFromInfo)
      .catch(() => false);
    this.clusterFlags.set(instance.name, flag);
    return flag;
  }

  private toConnectionError(instance: InstanceConfig, db: number, error: unknown): AppError {
    const rawMessage = errorMessage(error);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const prefix = `[${instance.name}] Redis ${formatEndpoint(instance)} db ${db}: `;

    if (code === 'ECONNREFUSED') {
      return new AppError('CONNECTION_ERROR', `${prefix}connection refused. Is Redis running and reachable?`, {
        cause: error,
      });
    }

    if (code === 'ETIMEDOUT') {
      return new AppError(
        'CONNECTION_ERROR',
        `${prefix}connection timed out after ${instance.connectTimeoutMs} ms.`,
        { cause: error },
      );
    }

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new AppError('CONNECTION_ERROR', `${prefix}host could not be resolved (${code}).`, { cause: error });
    }

    if (/NOAUTH|WRONGPASS|invalid password|invalid username-password/i.test(rawMessage)) {
      return new AppError(
        'CONNECTION_ERROR',
        `${prefix}authentication failed. Check the username, password and ACL settings.`,
        { cause: error },
      );
    }

    return new AppError('CONNECTION_ERROR', `${prefix}${rawMessage}`, { cause: error });
  }
}

export function resolveInstanceByName(config: AppConfig, name?: string): InstanceConfig {
  const available = config.instances.map((instance) => instance.name).join(', ');

  if (name !== undefined) {
    const match = config.instances.find((instance) => instance.name === name);
    if (match === undefined) {
      throw new AppError('INSTANCE_ERROR', `Unknown Redis instance "${name}". Available instances: ${available}.`);
    }
    return match;
  }

  if (config.defaultInstance !== undefined) {
    const match = config.instances.find((instance) => instance.name === config.defaultInstance);
    if (match === undefined) {
      throw new AppError('INSTANCE_ERROR', `Default Redis instance "${config.defaultInstance}" is not configured.`);
    }
    return match;
  }

  if (config.instances.length === 1) {
    return config.instances[0]!;
  }

  throw new AppError(
    'INSTANCE_ERROR',
    `Multiple Redis instances are configured; pass the "instance" argument. Available instances: ${available}.`,
  );
}

export function resolveDbIndex(instance: InstanceConfig, db?: number): number {
  const value = db ?? instance.db;

  if (!Number.isInteger(value) || value < 0 || value > MAX_DB_INDEX) {
    throw new AppError('DB_ERROR', `Database index must be an integer between 0 and ${MAX_DB_INDEX}, got ${value}.`);
  }

  if (instance.allowedDbs !== undefined && !instance.allowedDbs.includes(value)) {
    throw new AppError(
      'DB_ERROR',
      `Database ${value} is not allowed for instance "${instance.name}". Allowed databases: ${instance.allowedDbs.join(', ')}.`,
    );
  }

  return value;
}

export function clusterEnabledFromInfo(info: string): boolean {
  return /(?:^|\r?\n)cluster_enabled:1(?:\r?\n|$)/.test(info);
}

function buildRedisOptions(instance: InstanceConfig): RedisOptions {
  return {
    host: instance.host,
    port: instance.port,
    // Always connect to db 0. VerifiedClient issues and verifies SELECT for the
    // target logical database; letting ioredis do it would silently swallow a
    // failed SELECT.
    db: 0,
    ...(instance.username === undefined ? {} : { username: instance.username }),
    ...(instance.password === undefined ? {} : { password: instance.password }),
    ...(instance.tls ? { tls: { rejectUnauthorized: instance.tlsRejectUnauthorized } } : {}),
    connectTimeout: instance.connectTimeoutMs,
    ...(instance.commandTimeoutMs > 0
      ? {
          commandTimeout: instance.commandTimeoutMs,
          blockingTimeout: instance.commandTimeoutMs,
          socketTimeout: instance.commandTimeoutMs + 5_000,
        }
      : {}),
    enableOfflineQueue: false,
    // Do not resend commands that were in flight when the socket dropped; a
    // non-idempotent command must not be applied twice after a reconnect.
    autoResendUnfulfilledCommands: false,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    disableClientInfo: true,
    connectionName: `redis-switchboard-mcp:${instance.name}`,
    retryStrategy: (times) => Math.min(times * 200, 3_000),
  };
}

function clusterDbError(instance: InstanceConfig, db: number): AppError {
  return new AppError(
    'DB_ERROR',
    `[${instance.name}] Redis ${formatEndpoint(instance)} is a cluster; only logical database 0 is supported (requested db ${db}).`,
  );
}

function formatEndpoint(instance: InstanceConfig): string {
  const host = instance.host.includes(':') ? `[${instance.host}]` : instance.host;
  return `${host}:${instance.port}`;
}
