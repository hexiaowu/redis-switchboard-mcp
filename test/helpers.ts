import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { InstanceConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { resolveDbIndex, type RedisClient, type RedisProvider } from '../src/redis-manager.js';

export function makeInstance(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    name: 'test',
    host: '127.0.0.1',
    port: 6379,
    db: 0,
    tls: false,
    tlsRejectUnauthorized: true,
    mode: 'readwrite',
    allowScripting: false,
    connectTimeoutMs: 500,
    commandTimeoutMs: 1_000,
    maxResultItems: 3,
    maxResultChars: 20,
    maxResultDepth: 3,
    maxFetchItems: 1_000,
    maxFetchChars: 1_000_000,
    scanCount: 10,
    maxScanIterations: 5,
    scanTimeBudgetMs: 10_000,
    maxConnections: 32,
    ...overrides,
  };
}

export function resultJson(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected a text content block.');
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

export interface RecordedCall {
  command: string;
  args: (string | number | Buffer)[];
}

export class FakeClient implements RedisClient {
  readonly calls: RecordedCall[] = [];
  readonly scans: { cursor: string; args: (string | number)[] }[] = [];

  callReply: unknown = 'OK';
  callError?: Error;
  commandReplies: Record<string, unknown> = {};
  typeReply = 'string';
  pttlReply = -1;
  pttlError?: Error;
  memoryReply: unknown = 42;
  memoryError?: Error;
  encodingReply: unknown = 'embstr';
  encodingError?: Error;
  lengthReply = 1;
  lengthError?: Error;
  scanResults: [string, string[]][] = [['0', []]];
  scanError?: Error;
  scanDelayMs = 0;

  async call(command: string, ...args: (string | number | Buffer)[]): Promise<unknown> {
    this.calls.push({ command, args });
    const upper = command.toUpperCase();
    if (upper === 'MEMORY' && this.memoryError !== undefined) {
      throw this.memoryError;
    }
    if (upper === 'OBJECT' && this.encodingError !== undefined) {
      throw this.encodingError;
    }
    if (this.callError !== undefined) {
      throw this.callError;
    }
    if (upper === 'MEMORY') {
      return this.memoryReply;
    }
    if (upper === 'OBJECT') {
      return this.encodingReply;
    }
    if (Object.hasOwn(this.commandReplies, upper)) {
      return this.commandReplies[upper];
    }
    return this.callReply;
  }

  async scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]> {
    if (this.scanDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.scanDelayMs));
    }
    this.scans.push({ cursor: String(cursor), args });
    if (this.scanError !== undefined) {
      throw this.scanError;
    }
    const next = this.scanResults.shift();
    if (next === undefined) {
      throw new Error('FakeClient has no more scan results.');
    }
    return next;
  }

  async type(): Promise<string> {
    return this.typeReply;
  }

  async pttl(): Promise<number> {
    if (this.pttlError !== undefined) {
      throw this.pttlError;
    }
    return this.pttlReply;
  }

  async strlen(): Promise<number> {
    return this.length();
  }

  async llen(): Promise<number> {
    return this.length();
  }

  async hlen(): Promise<number> {
    return this.length();
  }

  async scard(): Promise<number> {
    return this.length();
  }

  async zcard(): Promise<number> {
    return this.length();
  }

  async xlen(): Promise<number> {
    return this.length();
  }

  private async length(): Promise<number> {
    if (this.lengthError !== undefined) {
      throw this.lengthError;
    }
    return this.lengthReply;
  }
}

export class FakeProvider implements RedisProvider {
  lastDb: number | undefined;

  constructor(
    readonly instance: InstanceConfig,
    readonly client: FakeClient,
  ) {}

  resolveInstance(name?: string): InstanceConfig {
    if (name !== undefined && name !== this.instance.name) {
      throw new AppError(
        'INSTANCE_ERROR',
        `Unknown Redis instance "${name}". Available instances: ${this.instance.name}.`,
      );
    }
    return this.instance;
  }

  resolveDb(_instance: InstanceConfig, db?: number): number {
    return resolveDbIndex(this.instance, db);
  }

  async getClient(_instance: InstanceConfig, db: number): Promise<RedisClient> {
    this.lastDb = db;
    return this.client;
  }
}
