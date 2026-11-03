import test from 'node:test';
import assert from 'node:assert/strict';
import { truncateReply, truncateString } from '../src/truncate.js';

const limits = { maxItems: 3, maxChars: 10, maxDepth: 3 };

test('short replies pass through unchanged', () => {
  const result = truncateReply(['OK', 1, null], limits);
  assert.deepEqual(result.value, ['OK', 1, null]);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.notes, []);
});

test('strings are truncated with a note', () => {
  const result = truncateReply('abcdefghijklmnop', limits);
  assert.equal(result.value, 'abcdefghij');
  assert.equal(result.truncated, true);
  assert.match(result.notes[0] ?? '', /string truncated from 16 to 10/);
});

test('arrays are truncated to maxItems', () => {
  const result = truncateReply(['a', 'b', 'c', 'd', 'e'], limits);
  assert.deepEqual(result.value, ['a', 'b', 'c']);
  assert.equal(result.truncated, true);
  assert.match(result.notes[0] ?? '', /array truncated from 5 to 3 items/);
});

test('nested containers are cut at maxDepth', () => {
  const result = truncateReply([[['deep']]], { maxItems: 10, maxChars: 10, maxDepth: 2 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.value, [['[Container(1) omitted: max depth reached]']]);
  assert.match(result.notes[0] ?? '', /container omitted at depth 3/);
});

test('buffers become bounded base64 objects', () => {
  const result = truncateReply(Buffer.from('hello world'), limits);
  assert.deepEqual(result.value, { type: 'Buffer', bytes: 11, base64: 'aGVsbG8gd2' });
  assert.equal(result.truncated, true);
});

test('objects are truncated by key count', () => {
  const result = truncateReply({ a: 1, b: 2, c: 3, d: 4 }, limits);
  assert.deepEqual(result.value, { a: 1, b: 2, c: 3 });
  assert.match(result.notes[0] ?? '', /object truncated from 4 to 3 keys/);
});

test('circular references do not overflow', () => {
  const value: Record<string, unknown> = {};
  value.self = value;
  const result = truncateReply(value, limits);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.value, { self: '[Circular]' });
});

test('maps and sets are handled defensively', () => {
  const mapResult = truncateReply(new Map([['a', 1], ['b', 2]]), limits);
  assert.deepEqual(mapResult.value, { a: 1, b: 2 });
  const setResult = truncateReply(new Set(['a', 'b']), limits);
  assert.deepEqual(setResult.value, ['a', 'b']);
});

test('a global item budget bounds nested replies', () => {
  const reply = Array.from({ length: 100 }, () =>
    Array.from({ length: 100 }, () => 'x'.repeat(100)),
  );
  const result = truncateReply(reply, {
    maxItems: 100,
    maxChars: 10,
    maxDepth: 3,
    maxTotalItems: 50,
    maxTotalChars: 1_000,
  });

  assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result.value).length < 2_000);
  assert.match(result.notes.join(' '), /size budget reached/i);
});

test('a global character budget bounds long nested strings', () => {
  const result = truncateReply(['a'.repeat(1_000), 'b'.repeat(1_000)], {
    maxItems: 10,
    maxChars: 1_000,
    maxDepth: 3,
    maxTotalChars: 1_500,
  });

  assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result.value).length <= 1_500 + 20);
  assert.match(result.notes.join(' '), /character budget|truncated from/);
});

test('own __proto__ keys are preserved instead of mutating the prototype', () => {
  const value = JSON.parse('{"__proto__":"x","a":1}') as Record<string, unknown>;
  const result = truncateReply(value, limits);
  assert.equal(JSON.stringify(result.value), '{"__proto__":"x","a":1}');
  assert.equal(Object.prototype.hasOwnProperty.call(result.value, '__proto__'), true);
});

test('truncateString reports whether it cut the value', () => {
  assert.deepEqual(truncateString('abc', 10), { value: 'abc', truncated: false });
  assert.deepEqual(truncateString('abcdef', 3), { value: 'abc', truncated: true });
});
