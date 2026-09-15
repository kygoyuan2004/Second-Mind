import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WINDOWS_CONTAINER_SECURITY_SUITES,
  selectTestFiles,
} from '../scripts/run-tests.mjs';

test('test runner keeps POSIX container guarantees explicit on Windows', () => {
  assert.deepEqual(WINDOWS_CONTAINER_SECURITY_SUITES, [
    'embedding-runtime.test.mjs',
    'knowledge-base-registry.test.mjs',
    'multi-knowledge-base-api.test.mjs',
    'runtime-admin-api.test.mjs',
    'runtime-admin-v2-security.test.mjs',
    'runtime-bootstrap.test.mjs',
    'runtime-config-registry-boundaries.test.mjs',
    'runtime-config-registry.test.mjs',
    'sdk-browser.test.mjs',
    'sdk-lifecycle.test.mjs',
    'sdk-media.test.mjs',
    'sdk-multi-knowledge-base-browser.test.mjs',
    'sdk-production.test.mjs',
    'sdk-provider-matrix.test.mjs',
    'server.test.mjs',
    'vault-replica.test.mjs',
  ]);
  const fixtures = [
    'sdk-production.test.mjs', 'runtime-config-registry.test.mjs', 'sdk-browser.test.mjs',
    'install-cli.test.mjs', 'sdk-transport.test.mjs',
  ];
  assert.deepEqual(selectTestFiles(fixtures, 'linux'), [...fixtures].sort());
  assert.deepEqual(selectTestFiles(fixtures, 'darwin'), [...fixtures].sort());
  assert.deepEqual(selectTestFiles(fixtures, 'win32'), [
    'install-cli.test.mjs', 'sdk-transport.test.mjs',
  ]);
});
