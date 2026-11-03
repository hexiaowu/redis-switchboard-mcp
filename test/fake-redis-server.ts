import { createServer, type Server, type Socket } from 'node:net';

export interface FakeRedisServerOptions {
  clusterEnabled?: boolean;
  /** Number of logical databases the fake server accepts (default 16). */
  maxDatabases?: number;
  /** Reject every SELECT with NOPERM, simulating a restricted ACL user. */
  denySelect?: boolean;
  /** When set, SCAN returns at most this many keys per call and uses cursors. */
  scanPageSize?: number;
  /** Commands that are accepted but never answered (simulates a lost reply). */
  hangCommands?: string[];
  /** Reply delay in ms per command name. */
  commandDelaysMs?: Record<string, number>;
}

interface ParsedCommand {
  args: string[];
  consumed: number;
}

const CR = 0x0d;
const LF = 0x0a;
const ASTERISK = 0x2a;
const DOLLAR = 0x24;

/**
 * Minimal RESP2 server used by the integration tests. It implements just
 * enough of Redis (AUTH/SELECT/INFO/PING/CLIENT/SET/GET/SCAN/...) to exercise
 * ioredis connection setup, per-database clients and tool calls.
 */
export class FakeRedisServer {
  readonly data = new Map<number, Map<string, string>>();
  readonly selectedDbs: number[] = [];
  readonly commands: { command: string; args: string[]; db: number }[] = [];

  port = 0;

  /** Currently open client sockets. */
  connectionCount = 0;
  /** Cumulative number of sockets ever accepted. */
  totalConnections = 0;
  /** When true, SELECT replies NOPERM (used to simulate a revoked +select after failover). */
  failSelect = false;

  private readonly clusterEnabled: boolean;
  private readonly maxDatabases: number;
  private readonly denySelect: boolean;
  private readonly scanPageSize: number | undefined;
  private readonly hangCommands: Set<string>;
  private readonly commandDelaysMs: Record<string, number>;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly socketDbs = new Map<Socket, number>();

  constructor(options: FakeRedisServerOptions = {}) {
    this.clusterEnabled = options.clusterEnabled ?? false;
    this.maxDatabases = options.maxDatabases ?? 16;
    this.denySelect = options.denySelect ?? false;
    this.scanPageSize = options.scanPageSize;
    this.hangCommands = new Set(options.hangCommands ?? []);
    this.commandDelaysMs = options.commandDelaysMs ?? {};
    this.server = createServer((socket) => this.handle(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('FakeRedisServer did not get a TCP address.'));
          return;
        }
        this.port = address.port;
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, '127.0.0.1');
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.socketDbs.clear();

    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  keysFor(db: number): string[] {
    return [...(this.data.get(db)?.keys() ?? [])];
  }

  /** Simulate a network drop so clients must reconnect. */
  dropConnections(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.socketDbs.clear();
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    this.socketDbs.set(socket, 0);
    this.connectionCount += 1;
    this.totalConnections += 1;

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        let parsed: ParsedCommand | null;
        try {
          parsed = parseCommand(buffer);
        } catch {
          socket.write('-ERR protocol error\r\n');
          socket.destroy();
          return;
        }
        if (parsed === null) {
          break;
        }
        buffer = buffer.subarray(parsed.consumed);
        if (parsed.args.length > 0) {
          this.dispatch(socket, parsed.args);
        }
      }
    });

    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.socketDbs.delete(socket);
      this.connectionCount -= 1;
    });
  }

  private dispatch(socket: Socket, args: string[]): void {
    const command = args[0]!.toUpperCase();

    if (this.hangCommands.has(command)) {
      return;
    }
    const delay = this.commandDelaysMs[command];
    if (delay !== undefined) {
      setTimeout(() => this.dispatchNow(socket, args), delay);
      return;
    }
    this.dispatchNow(socket, args);
  }

  private dispatchNow(socket: Socket, args: string[]): void {
    const command = args[0]!.toUpperCase();
    const db = this.socketDbs.get(socket) ?? 0;
    const data = this.dbMap(db);
    this.commands.push({ command, args: args.slice(1), db });

    switch (command) {
      case 'PING':
        socket.write('+PONG\r\n');
        return;
      case 'AUTH':
        socket.write('+OK\r\n');
        return;
      case 'SELECT': {
        if (this.failSelect) {
          socket.write("-NOPERM this user has no permissions to run the 'select' command\r\n");
          return;
        }
        if (this.clusterEnabled) {
          socket.write('-ERR SELECT is not allowed in cluster mode\r\n');
          return;
        }
        if (this.denySelect) {
          socket.write("-NOPERM this user has no permissions to run the 'select' command\r\n");
          return;
        }
        const nextDb = Number(args[1]);
        if (!Number.isInteger(nextDb) || nextDb < 0 || nextDb >= this.maxDatabases) {
          socket.write('-ERR DB index is out of range\r\n');
          return;
        }
        this.socketDbs.set(socket, nextDb);
        this.selectedDbs.push(nextDb);
        socket.write('+OK\r\n');
        return;
      }
      case 'CLIENT':
        socket.write('+OK\r\n');
        return;
      case 'INFO':
        socket.write(
          bulkReply(
            [
              '# Server',
              'redis_version:7.2.0',
              '# Cluster',
              `cluster_enabled:${this.clusterEnabled ? 1 : 0}`,
              '',
            ].join('\r\n'),
          ),
        );
        return;
      case 'COMMAND':
        socket.write('*0\r\n');
        return;
      case 'QUIT':
        socket.write('+OK\r\n');
        socket.end();
        return;
      case 'SET': {
        if (args.length < 3) {
          socket.write('-ERR wrong number of arguments for SET\r\n');
          return;
        }
        data.set(args[1]!, args[2]!);
        socket.write('+OK\r\n');
        return;
      }
      case 'GET': {
        const value = data.get(args[1]!);
        socket.write(value === undefined ? '$-1\r\n' : bulkReply(value));
        return;
      }
      case 'DEL': {
        let deleted = 0;
        for (const key of args.slice(1)) {
          if (data.delete(key)) {
            deleted += 1;
          }
        }
        socket.write(`:${deleted}\r\n`);
        return;
      }
      case 'EXISTS':
        socket.write(`:${data.has(args[1]!) ? 1 : 0}\r\n`);
        return;
      case 'TYPE':
        socket.write(data.has(args[1]!) ? '+string\r\n' : '+none\r\n');
        return;
      case 'PTTL':
        socket.write(data.has(args[1]!) ? ':-1\r\n' : ':-2\r\n');
        return;
      case 'STRLEN': {
        const value = data.get(args[1]!);
        socket.write(`:${value === undefined ? 0 : Buffer.byteLength(value, 'utf8')}\r\n`);
        return;
      }
      case 'GETRANGE': {
        const value = data.get(args[1]!);
        if (value === undefined) {
          socket.write(bulkReply(''));
          return;
        }
        const bytes = Buffer.from(value, 'utf8');
        const start = Number(args[2]);
        const end = Number(args[3]);
        let from = start < 0 ? bytes.length + start : start;
        let to = end < 0 ? bytes.length + end : end;
        from = Math.max(0, from);
        to = Math.min(bytes.length - 1, to);
        socket.write(bulkReplyBuffer(to >= from ? bytes.subarray(from, to + 1) : Buffer.alloc(0)));
        return;
      }
      case 'MEMORY':
        socket.write(data.has(args[2]!) ? ':42\r\n' : '$-1\r\n');
        return;
      case 'OBJECT':
        socket.write(bulkReply('embstr'));
        return;
      case 'SCAN':
        socket.write(this.scanReply(args, db));
        return;
      default:
        socket.write(`-ERR unknown command '${args[0]}'\r\n`);
    }
  }

  private scanReply(args: string[], db: number): string {
    const matchIndex = args.findIndex((arg) => arg.toUpperCase() === 'MATCH');
    const pattern = matchIndex >= 0 ? (args[matchIndex + 1] ?? '*') : '*';
    const matcher = globToRegExp(pattern);

    const keys = this.keysFor(db).filter((key) => matcher.test(key));

    if (this.scanPageSize === undefined) {
      return `*2\r\n${bulkReply('0')}${arrayReply(keys)}`;
    }

    const requestedCursor = Number(args[1] ?? '0');
    const offset = Number.isSafeInteger(requestedCursor) && requestedCursor > 0 ? requestedCursor : 0;
    const page = keys.slice(offset, offset + this.scanPageSize);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < keys.length ? String(nextOffset) : '0';

    return `*2\r\n${bulkReply(nextCursor)}${arrayReply(page)}`;
  }

  private dbMap(db: number): Map<string, string> {
    let map = this.data.get(db);
    if (map === undefined) {
      map = new Map<string, string>();
      this.data.set(db, map);
    }
    return map;
  }
}

function parseCommand(buffer: Buffer): ParsedCommand | null {
  if (buffer.length === 0) {
    return null;
  }

  // Inline command (useful for manual testing with nc/telnet).
  if (buffer[0] !== ASTERISK) {
    const lineEnd = buffer.indexOf(LF);
    if (lineEnd === -1) {
      return null;
    }
    const line = buffer.subarray(0, lineEnd).toString('utf8').replace(/\r$/, '').trim();
    return {
      args: line === '' ? [] : line.split(/\s+/),
      consumed: lineEnd + 1,
    };
  }

  const headerEnd = findCrlf(buffer, 1);
  if (headerEnd === -1) {
    return null;
  }
  const count = Number(buffer.subarray(1, headerEnd).toString('ascii'));
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Invalid RESP array length.');
  }

  let offset = headerEnd + 2;
  const args: string[] = [];

  for (let index = 0; index < count; index += 1) {
    if (offset >= buffer.length) {
      return null;
    }
    if (buffer[offset] !== DOLLAR) {
      throw new Error('Expected a RESP bulk string.');
    }
    const lengthEnd = findCrlf(buffer, offset + 1);
    if (lengthEnd === -1) {
      return null;
    }
    const length = Number(buffer.subarray(offset + 1, lengthEnd).toString('ascii'));
    if (!Number.isInteger(length) || length < 0) {
      throw new Error('Invalid RESP bulk string length.');
    }

    const dataStart = lengthEnd + 2;
    const dataEnd = dataStart + length;
    if (buffer.length < dataEnd + 2) {
      return null;
    }
    if (buffer[dataEnd] !== CR || buffer[dataEnd + 1] !== LF) {
      throw new Error('Invalid RESP bulk string terminator.');
    }

    args.push(buffer.subarray(dataStart, dataEnd).toString('utf8'));
    offset = dataEnd + 2;
  }

  return { args, consumed: offset };
}

function findCrlf(buffer: Buffer, from: number): number {
  for (let index = from; index < buffer.length - 1; index += 1) {
    if (buffer[index] === CR && buffer[index + 1] === LF) {
      return index;
    }
  }
  return -1;
}

function bulkReply(value: string): string {
  return `$${Buffer.byteLength(value, 'utf8')}\r\n${value}\r\n`;
}

function bulkReplyBuffer(value: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`$${value.length}\r\n`, 'ascii'),
    value,
    Buffer.from('\r\n', 'ascii'),
  ]);
}

function arrayReply(values: string[]): string {
  return `*${values.length}\r\n${values.map(bulkReply).join('')}`;
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (const char of pattern) {
    if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}
