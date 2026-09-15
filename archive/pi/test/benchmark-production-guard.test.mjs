import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProductionHealthy,
  captureProductionState,
  compareProductionState,
  parseSystemctlShow,
} from '../scripts/lib/benchmark-production-guard.mjs';

const SHOW = `MainPID=1234
NRestarts=2
ExecMainStartTimestamp=Mon 2026-08-31 10:00:00 CST
ActiveState=active
SubState=running
`;

test('systemctl state parsing is strict and typed', () => {
  assert.deepEqual(parseSystemctlShow(SHOW), {
    activeState: 'active',
    subState: 'running',
    mainPid: 1234,
    execMainStartTimestamp: 'Mon 2026-08-31 10:00:00 CST',
    restarts: 2,
  });
  assert.throws(() => parseSystemctlShow('ActiveState=active\n'), /Incomplete systemctl state/);
});

test('capture checks both service state and loopback HTTP 200', async () => {
  const state = await captureProductionState({
    services: [{ id: 'one', name: 'one.service', user: true }],
    endpoints: [{ id: 'page', url: 'http://127.0.0.1:8787/knowledge.html' }],
    readService: async () => parseSystemctlShow(SHOW),
    probeEndpoint: async () => 200,
  });
  assert.equal(state.services.one.mainPid, 1234);
  assert.equal(state.endpoints.page, 200);
  assert.equal(Object.isFrozen(state), true);

  await assert.rejects(() => captureProductionState({
    services: [{ id: 'one', name: 'one.service', user: true }],
    endpoints: [{ id: 'bad', url: 'https://example.com/' }],
    readService: async () => parseSystemctlShow(SHOW),
    probeEndpoint: async () => 200,
  }), (error) => error.code === 'INVALID_HEALTH_ENDPOINT');
});

test('health and before/after comparison fail on HTTP errors or restarts', () => {
  const before = {
    services: { one: parseSystemctlShow(SHOW) },
    endpoints: { page: 200 },
  };
  assert.deepEqual(compareProductionState(before, before), { healthy: true, unchanged: true });
  assert.throws(() => assertProductionHealthy({
    services: before.services,
    endpoints: { page: 503 },
  }), (error) => error.code === 'PRODUCTION_UNHEALTHY');
  assert.throws(() => compareProductionState(before, {
    services: {
      one: { ...before.services.one, mainPid: 9999, restarts: 3 },
    },
    endpoints: { page: 200 },
  }), (error) => error.code === 'PRODUCTION_STATE_CHANGED' && error.details.length === 2);
});
