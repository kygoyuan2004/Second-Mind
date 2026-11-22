import assert from 'node:assert/strict';
import test from 'node:test';
import { selectTestFiles } from '../scripts/run-tests.mjs';

test('native Windows includes real SDK, storage, HTTP and desktop lifecycle suites', () => {
  const core = ['sdk-production.test.mjs', 'runtime-config-registry.test.mjs', 'server.test.mjs', 'desktop-backend.test.mjs'];
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.deepEqual(selectTestFiles([...core, 'deployment-entrypoints.test.mjs', 'require-ci-success.test.mjs'], platform), core.toSorted());
  }
});
