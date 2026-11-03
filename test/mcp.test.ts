import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
  params?: unknown;
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const packageVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

async function getClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return address.port;
}

test('MCP server completes the handshake and exposes four tools', { timeout: 30_000 }, async (t) => {
  const closedPort = await getClosedPort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      REDIS_MCP_CONFIG: '',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(closedPort),
      // No REDIS_MODE: the server must start with the 'readonly' default.
      REDIS_CONNECT_TIMEOUT_MS: '300',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const waiters = new Map<number, (message: JsonRpcMessage) => void>();

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    let index = stdout.indexOf('\n');
    while (index >= 0) {
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      index = stdout.indexOf('\n');
      if (line === '') {
        continue;
      }
      const message = JSON.parse(line) as JsonRpcMessage;
      if (typeof message.id === 'number' && waiters.has(message.id)) {
        waiters.get(message.id)!(message);
        waiters.delete(message.id);
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  t.after(() => {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  });

  let nextId = 1;
  const request = (method: string, params: unknown): Promise<JsonRpcMessage> => {
    const id = nextId;
    nextId += 1;

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 10_000);

      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  try {
    const initialized = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });

    const serverInfo = (initialized.result as { serverInfo?: { name?: string; version?: string } })
      ?.serverInfo;
    assert.equal(serverInfo?.name, 'redis-switchboard-mcp');
    assert.equal(serverInfo?.version, packageVersion);

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );

    const listed = await request('tools/list', {});
    const tools = (listed.result as { tools?: { name: string; inputSchema?: unknown }[] }).tools ?? [];
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['execute', 'key_info', 'read_page', 'scan_keys'],
    );
    for (const tool of tools) {
      assert.equal(typeof tool.inputSchema, 'object');
    }

    const blocked = await request('tools/call', {
      name: 'execute',
      arguments: { command: 'SELECT 3', db: 2 },
    });
    const blockedResult = blocked.result as {
      isError?: boolean;
      content?: { type: string; text: string }[];
    };
    assert.equal(blockedResult.isError, true);
    assert.match(blockedResult.content?.[0]?.text ?? '', /COMMAND_REJECTED/);

    const failed = await request('tools/call', {
      name: 'execute',
      arguments: { command: 'PING', db: 2 },
    });
    const failedResult = failed.result as {
      isError?: boolean;
      content?: { type: string; text: string }[];
    };
    assert.equal(failedResult.isError, true);
    assert.match(failedResult.content?.[0]?.text ?? '', /CONNECTION_ERROR/);

    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });
    assert.equal(exitCode, 0);
    assert.match(stderr, /redis-switchboard-mcp/);
  } finally {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  }
});

test('rsm --help exits successfully without starting the server', { timeout: 15_000 }, async () => {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--help'], {
    cwd: projectRoot,
    env: { ...process.env, REDIS_MCP_CONFIG: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  assert.equal(exitCode, 0);
  assert.match(output, /Usage: rsm/);
  assert.match(output, /Tools: execute, read_page, scan_keys, key_info/);
});
