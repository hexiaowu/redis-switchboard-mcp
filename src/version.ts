import { readFileSync } from 'node:fs';

let cachedVersion: string | undefined;

/**
 * Read the package version lazily so importing the library has no filesystem
 * side effects. The CLI calls this once during startup.
 */
export function getVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }

  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof (parsed as { version: unknown }).version === 'string'
    ) {
      cachedVersion = (parsed as { version: string }).version;
      return cachedVersion;
    }
  } catch {
    // Fall through to the development fallback.
  }

  cachedVersion = '0.0.0';
  return cachedVersion;
}
