/**
 * Library entry point. Importing this module has no side effects; the CLI
 * entry point is dist/index.js and is exposed through the `rsm` bin.
 */
export { createServer, SERVER_NAME } from './server.js';
export { RedisManager, resolveDbIndex, resolveInstanceByName } from './redis-manager.js';
export type { RedisClient, RedisProvider } from './redis-manager.js';
export { loadConfig, parseCli, parseConfigObject } from './config.js';
export type { AppConfig, CliOptions, InstanceConfig, PermissionMode } from './config.js';
export { tokenizeCommand, normalizeCommand, assertCommandAllowed } from './commands.js';
export { truncateReply } from './truncate.js';
export { getVersion } from './version.js';
