import test from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage, redactSecrets } from '../src/errors.js';

test('redactSecrets removes URL, key/value, JSON and AUTH credentials', () => {
  assert.equal(redactSecrets('redis://user:secret@host:6379/2'), 'redis://user:***@host:6379/2');
  assert.equal(redactSecrets('rediss://:secret@host'), 'rediss://:***@host');
  assert.equal(redactSecrets('password=secret'), 'password=***');
  assert.equal(redactSecrets('password: secret'), 'password: ***');
  assert.equal(redactSecrets('{"password":"secret"}'), '{"password":"***"}');
  assert.equal(redactSecrets("password='secret value'"), "password='***'");
  assert.equal(redactSecrets('{"password":"it\'s-secret"}'), '{"password":"***"}');
  assert.equal(redactSecrets('password="it\'s secret"'), 'password="***"');
  assert.equal(redactSecrets('password=\'say "hi"\''), "password='***'");
  assert.equal(redactSecrets('{"password":"say \\"hi\\""}'), '{"password":"***"}');
  assert.equal(redactSecrets('AUTH secret'), 'AUTH ***');
  assert.equal(redactSecrets('AUTH user pass'), 'AUTH ***');
});

test('errorMessage redacts error messages and handles non-errors', () => {
  assert.equal(errorMessage(new Error('password=secret')), 'password=***');
  assert.equal(errorMessage('redis://user:secret@host'), 'redis://user:***@host');
  assert.equal(errorMessage(42), '42');
});
