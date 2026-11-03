import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppError, errorMessage, type ErrorCode } from '../errors.js';

export function jsonResult(payload: unknown): CallToolResult {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2) ?? 'null';
  } catch (error) {
    text = JSON.stringify({
      error: `Result could not be serialized: ${errorMessage(error)}`,
      code: 'INTERNAL_ERROR',
    });
  }
  return {
    content: [{ type: 'text', text }],
  };
}

function inferErrorCode(error: unknown): ErrorCode {
  if (error instanceof AppError) {
    return error.code;
  }

  const message = errorMessage(error);
  if (/Command timed out/i.test(message)) {
    return 'COMMAND_ERROR';
  }
  if (/Stream isn't writeable|Connection is closed|MaxRetriesPerRequest|ECONN|EPIPE|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return 'CONNECTION_ERROR';
  }
  if (/^(WRONGTYPE|ERR|NOAUTH|NOPERM|OOM|READONLY|EXECABORT)/i.test(message)) {
    return 'COMMAND_ERROR';
  }
  return 'INTERNAL_ERROR';
}

function describeError(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof AppError) && /Command timed out/i.test(message)) {
    // ioredis rejects the promise but does not cancel the command in Redis.
    return `${message}. The command may still have been executed by Redis; verify state before retrying.`;
  }
  return message;
}

export function errorResult(error: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: describeError(error), code: inferErrorCode(error) }, null, 2),
      },
    ],
    isError: true,
  };
}

export async function runTool(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return errorResult(error);
  }
}
