export type ErrorCode =
  | 'CONFIG_ERROR'
  | 'COMMAND_REJECTED'
  | 'COMMAND_SYNTAX'
  | 'COMMAND_ERROR'
  | 'INSTANCE_ERROR'
  | 'DB_ERROR'
  | 'CONNECTION_ERROR'
  | 'INTERNAL_ERROR';

export interface AppErrorOptions {
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('CONFIG_ERROR', message, options);
    this.name = 'ConfigError';
  }
}

export class CommandRejectedError extends AppError {
  constructor(message: string) {
    super('COMMAND_REJECTED', message);
    this.name = 'CommandRejectedError';
  }
}

export class CommandSyntaxError extends AppError {
  constructor(message: string) {
    super('COMMAND_SYNTAX', message);
    this.name = 'CommandSyntaxError';
  }
}

/**
 * Remove credentials from text that may end up in a tool response or a log.
 * Redis client errors normally do not contain the password, but this is a cheap
 * safety net for messages that embed a connection URL or an option dump.
 */
export function redactSecrets(message: string): string {
  return message
    .replace(/(redis(?:s)?:\/\/[^/\s:@]*:)[^@\s]+@/gi, '$1***@')
    // Quoted/JSON style: "password": "secret", password='secret'. The two
    // alternatives allow a value to contain the other quote character.
    .replace(
      /(["']?(?:password|passwd|pwd)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi,
      (_match, prefix: string, value: string) =>
        `${prefix}${value.charAt(0)}***${value.charAt(0)}`,
    )
    // Unquoted style: password=secret, password: secret
    .replace(/(["']?(?:password|passwd|pwd)["']?\s*[:=]\s*)(?!["'])[^\s,;)}]+/gi, '$1***')
    // AUTH commands echoed in an error or a command log
    .replace(/(\bAUTH\s+)[^\r\n]+/gi, '$1***');
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }
  return redactSecrets(String(error));
}
