import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WINDOWS_CONTAINER_SECURITY_SUITES,
  selectTestFiles,
} from '../scripts/run-tests.mjs';

test('test runner keeps POSIX container guarantees explicit on Windows', () => {
  assert.deepEqual(WINDOWS_CONTAINER_SECURITY_SUITES, [
    'benchmark-adjudication.test.mjs',
    'benchmark-approval.test.mjs',
    'benchmark-cloud-executor.test.mjs',
    'benchmark-core.test.mjs',
    'benchmark-systems.test.mjs',
    'completeness-eval.test.mjs',
    'embedding-runtime.test.mjs',
    'knowledge-base-registry.test.mjs',
    'multi-knowledge-base-api.test.mjs',
    'provider-config-api.test.mjs',
    'runtime-admin-api.test.mjs',
    'runtime-admin-v2-security.test.mjs',
    'runtime-bootstrap.test.mjs',
    'runtime-config-registry-boundaries.test.mjs',
    'runtime-config-registry.test.mjs',
    'runtime-v2-integration.test.mjs',
    'vault-replica.test.mjs',
  ]);
  const fixtures = [
    '/repo/test/runtime-config-registry.test.mjs',
    '/repo/test/install-cli.test.mjs',
    '/repo/test/server.test.mjs',
  ];
  assert.deepEqual(selectTestFiles(fixtures, 'linux'), [...fixtures].sort());
  assert.deepEqual(selectTestFiles(fixtures, 'darwin'), [...fixtures].sort());
  assert.deepEqual(selectTestFiles(fixtures, 'win32'), [
    '/repo/test/install-cli.test.mjs',
    '/repo/test/server.test.mjs',
  ]);
});
