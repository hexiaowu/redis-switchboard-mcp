export interface TruncationLimits {
  maxItems: number;
  maxChars: number;
  maxDepth: number;
  /** Global element budget for the whole reply. Defaults to maxItems * 20 (min 1000). */
  maxTotalItems?: number;
  /** Global character budget for the whole reply. Defaults to 100k-1M characters. */
  maxTotalChars?: number;
}

export interface TruncatedResult {
  value: unknown;
  truncated: boolean;
  notes: string[];
}

const MAX_NOTES = 20;
const BUDGET_MARKER = '[Truncated: result size budget reached]';

/**
 * Convert a Redis reply into a JSON-safe value while bounding its size.
 *
 * Redis replies are normally strings, numbers, nulls and nested arrays. We also
 * handle buffers and plain objects defensively so an unexpected reply can never
 * produce an unbounded tool response. Both per-container limits and a global
 * node/character budget are enforced, which prevents deeply nested replies from
 * multiplying maxItems into millions of output nodes.
 */
export function truncateReply(reply: unknown, limits: TruncationLimits): TruncatedResult {
  const notes: string[] = [];
  let truncated = false;
  let notesCapped = false;
  let budgetReached = false;

  const totalItemBudget = limits.maxTotalItems ?? Math.max(1_000, limits.maxItems * 20);
  const totalCharBudget =
    limits.maxTotalChars ?? Math.max(100_000, Math.min(limits.maxChars * 100, 1_000_000));

  let usedItems = 0;
  let usedChars = 0;

  const pushNote = (note: string): void => {
    if (notes.length < MAX_NOTES) {
      notes.push(note);
    } else if (!notesCapped) {
      notes.push('Additional truncation notes omitted.');
      notesCapped = true;
    }
  };

  const remainingChars = (): number => Math.max(0, totalCharBudget - usedChars);
  const isBudgetExhausted = (): boolean =>
    usedItems >= totalItemBudget || remainingChars() <= 0;

  const markBudget = (path: string): void => {
    truncated = true;
    budgetReached = true;
    pushNote(
      `${path}: result size budget reached (items=${usedItems}/${totalItemBudget}, chars=${usedChars}/${totalCharBudget})`,
    );
  };

  const consumeItem = (path: string): boolean => {
    if (isBudgetExhausted()) {
      markBudget(path);
      return false;
    }
    usedItems += 1;
    return true;
  };

  function walkString(value: string, path: string): string {
    const cap = Math.min(limits.maxChars, remainingChars());
    if (cap <= 0) {
      truncated = true;
      pushNote(`${path}: character budget reached (${totalCharBudget} characters)`);
      return '[Truncated: character budget reached]';
    }

    const output = value.slice(0, cap);
    usedChars += output.length;
    if (value.length > cap) {
      truncated = true;
      pushNote(`${path}: string truncated from ${value.length} to ${cap} characters`);
    }
    return output;
  }

  function walk(
    value: unknown,
    depth: number,
    path: string,
    seen: WeakSet<object>,
  ): unknown {
    if (!consumeItem(path)) {
      return BUDGET_MARKER;
    }

    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      return walkString(value, path);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (Buffer.isBuffer(value)) {
      const base64 = value.toString('base64');
      const cap = Math.min(limits.maxChars, remainingChars());
      const shown = base64.slice(0, cap);
      usedChars += shown.length;
      if (base64.length > cap) {
        truncated = true;
        pushNote(`${path}: buffer truncated from ${value.length} bytes to ${cap} base64 characters`);
      }
      return { type: 'Buffer', bytes: value.length, base64: shown };
    }

    if (typeof value === 'object') {
      if (seen.has(value)) {
        truncated = true;
        pushNote(`${path}: circular reference replaced with "[Circular]"`);
        return '[Circular]';
      }

      if (depth >= limits.maxDepth) {
        truncated = true;
        const size = Array.isArray(value) ? value.length : Object.keys(value).length;
        pushNote(`${path}: container omitted at depth ${depth + 1} (${size} entries)`);
        return `[Container(${size}) omitted: max depth reached]`;
      }

      seen.add(value);

      if (Array.isArray(value)) {
        const output: unknown[] = [];
        const available = Math.max(0, totalItemBudget - usedItems);
        const count = Math.min(value.length, limits.maxItems, available);
        if (value.length > count) {
          truncated = true;
          pushNote(`${path}: array truncated from ${value.length} to ${count} items`);
        }
        for (let index = 0; index < count; index += 1) {
          if (isBudgetExhausted()) {
            markBudget(path);
            break;
          }
          output.push(walk(value[index], depth + 1, `${path}[${index}]`, seen));
        }
        return output;
      }

      if (value instanceof Map) {
        const entries = [...value.entries()];
        const available = Math.max(0, totalItemBudget - usedItems);
        const count = Math.min(entries.length, limits.maxItems, available);
        if (entries.length > count) {
          truncated = true;
          pushNote(`${path}: map truncated from ${entries.length} to ${count} entries`);
        }
        const output: Record<string, unknown> = {};
        for (let index = 0; index < count; index += 1) {
          if (isBudgetExhausted()) {
            markBudget(path);
            break;
          }
          const [key, entryValue] = entries[index]!;
          Object.defineProperty(output, String(key), {
            value: walk(entryValue, depth + 1, `${path}[${JSON.stringify(String(key))}]`, seen),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return output;
      }

      if (value instanceof Set) {
        const entries = [...value.values()];
        const available = Math.max(0, totalItemBudget - usedItems);
        const count = Math.min(entries.length, limits.maxItems, available);
        if (entries.length > count) {
          truncated = true;
          pushNote(`${path}: set truncated from ${entries.length} to ${count} items`);
        }
        const output: unknown[] = [];
        for (let index = 0; index < count; index += 1) {
          if (isBudgetExhausted()) {
            markBudget(path);
            break;
          }
          output.push(walk(entries[index], depth + 1, `${path}[${index}]`, seen));
        }
        return output;
      }

      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        return String(value);
      }

      const entries = Object.entries(value as Record<string, unknown>);
      const available = Math.max(0, totalItemBudget - usedItems);
      const count = Math.min(entries.length, limits.maxItems, available);
      if (entries.length > count) {
        truncated = true;
        pushNote(`${path}: object truncated from ${entries.length} to ${count} keys`);
      }
      const output: Record<string, unknown> = {};
      for (let index = 0; index < count; index += 1) {
        if (isBudgetExhausted()) {
          markBudget(path);
          break;
        }
        const [key, entryValue] = entries[index]!;
        Object.defineProperty(output, key, {
          value: walk(entryValue, depth + 1, `${path}.${key}`, seen),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return output;
    }

    return String(value);
  }

  const value = walk(reply, 0, '$', new WeakSet());

  if (budgetReached) {
    notes.push(
      `Result size budget reached (items=${usedItems}/${totalItemBudget}, chars=${usedChars}/${totalCharBudget}); remaining entries were omitted.`,
    );
  }

  return { value, truncated, notes };
}

export function truncateString(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, maxChars), truncated: true };
}
