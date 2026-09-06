import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registryLogin, redactRegistryDiagnostic } from '../scripts/registry-auth.js';

const credentials = { Username: 'test-user', Secret: 'private-test-secret' };
const helper = { status: 0, stdout: JSON.stringify(credentials), stderr: '' };
test('registry login uses stdin and reports success only after Docker succeeds', () => {
  const calls = [];
  registryLogin('/tmp/test-config', (command, args, options) => {
    calls.push(command);
    if (command === 'glab') return helper;
    assert.equal(options.input, credentials.Secret);
    assert.ok(!args.includes(credentials.Secret));
    assert.ok(args.includes('--password-stdin'));
    assert.equal(options.timeout, 45000);
    return { status: 0, stdout: 'Login Succeeded', stderr: '' };
  });
  assert.deepEqual(calls, ['glab', 'docker']);
});
test('registry errors preserve the cause while removing credential representations', () => {
  const encoded = Buffer.from(`${credentials.Username}:${credentials.Secret}`).toString('base64');
  assert.throws(() => registryLogin('/tmp/test-config', command => command === 'glab' ? helper : {
    status: 1, stderr: `unauthorized: ${credentials.Secret}; Authorization: Basic ${encoded}`,
  }), error => error.message.includes('unauthorized') && !error.message.includes(credentials.Secret) && !error.message.includes(encoded));
  assert.match(redactRegistryDiagnostic('access_token=abc&refresh_token=xyz Authorization: Bearer other'), /access_token=\[REDACTED\]&refresh_token=\[REDACTED\]/);
});
test('registry diagnostics distinguish process/network failures from authentication denial', () => {
  assert.throws(() => registryLogin('/tmp/test-config', command => command === 'glab' ? helper : {
    status: null, error: { code: 'ETIMEDOUT' }, stderr: 'TLS handshake timeout',
  }), /ETIMEDOUT.*TLS handshake timeout/);
});
test('malformed credential output is never echoed', () => {
  assert.throws(() => registryLogin('/tmp/test-config', () => ({status:0,stdout:'private-test-secret'})), error => !error.message.includes('private-test-secret'));
});
