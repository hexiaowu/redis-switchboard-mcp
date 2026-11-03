import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertCommandAllowed, normalizeCommand } from '../commands.js';
import { enforceFetchLimit } from '../fetch-guard.js';
import type { RedisProvider } from '../redis-manager.js';
import { truncateReply } from '../truncate.js';
import { jsonResult, runTool } from './common.js';

export const executeInputSchema = z.object({
  command: z
    .union([
      z.string().min(1).max(1_000_000),
      z.array(z.string().max(100_000)).min(1).max(1_024),
    ])
    .describe(
      'Redis command to execute, either as a command line (for example "GET user:1") or as an argument array (["GET", "user:1"]). The command name is case-insensitive.',
    ),
  db: z
    .number()
    .int()
    .min(0)
    .max(255)
    .optional()
    .describe(
      'Logical Redis database index (0-255). The tool selects it per request; SELECT is not sent and not accepted as a command. Defaults to the instance configuration.',
    ),
  instance: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Configured Redis instance name. Required when several instances are configured without a default.'),
});

export type ExecuteArgs = z.infer<typeof executeInputSchema>;

export function createExecuteHandler(
  provider: RedisProvider,
): (args: ExecuteArgs) => Promise<CallToolResult> {
  return (args) =>
    runTool(async () => {
      const instance = provider.resolveInstance(args.instance);
      const db = provider.resolveDb(instance, args.db);
      const argv = normalizeCommand(args.command);

      assertCommandAllowed(argv, {
        mode: instance.mode,
        allowScripting: instance.allowScripting,
      });

      const client = await provider.getClient(instance, db);
      await enforceFetchLimit(client, argv, instance);

      const startedAt = performance.now();
      const reply = await client.call(argv[0], ...argv.slice(1));
      const elapsedMs = Math.round(performance.now() - startedAt);

      const limited = truncateReply(reply, {
        maxItems: instance.maxResultItems,
        maxChars: instance.maxResultChars,
        maxDepth: instance.maxResultDepth,
      });

      return jsonResult({
        instance: instance.name,
        db,
        command: argv[0],
        argCount: argv.length - 1,
        elapsedMs,
        reply: limited.value,
        truncated: limited.truncated,
        ...(limited.notes.length === 0 ? {} : { notes: limited.notes }),
      });
    });
}
