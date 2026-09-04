import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/server.mjs';
import { temporaryProject } from './helpers.mjs';

const ADMIN_PASSWORD = 'embedding cancel administrator fixture';
const ACTIVE_ID = '63f9271b-9933-4c60-9849-acf461b62db7';
const OTHER_ID = '3ba05ea2-87cf-499e-b585-64c5d68c154b';

function publicIndex() {
  return {
    revision: 'active-index-r1',
    available: true,
    generation: 'active-index-generation-r1',
    files: 3,
    chunks: 5,
    embeddedChunks: 5,
    lexicalAvailable: true,
    semanticAvailable: true,
    embedding: { provider: 'dashscope', model: 'embedding-current', dimensions: 8 },
  };
}

function appConfig(project) {
  return {
    ...project.config,
    publicDir: path.resolve(new URL('../public', import.meta.url).pathname),
    appName: 'Embedding cancel fixture',
    vaultLabel: 'Fixture Vault',
    host: '127.0.0.1',
    port: 0,
    timezone: 'UTC',
    trustProxy: false,
    auth: {
      username: 'admin',
      password: ADMIN_PASSWORD,
      sessionSecret: 'TEST_ONLY_NOT_A_REAL_SESSION_SECRET',
      sessionTtlSeconds: 3_600,
      secureCookie: false,
    },
  };
}

function runtimeSnapshot() {
  return {
    schemaVersion: 2,
    version: 2,
    revision: 'a'.repeat(64),
    stale: false,
    connections: [],
    models: [],
    defaultModelId: '',
    webSearch: { enabled: false, provider: 'bailian-mcp', providers: [] },
    embedding: {
      provider: 'dashscope',
      model: 'embedding-next',
      dimensions: 8,
      apiKeyConfigured: true,
    },
  };
}

function pendingJob(phase = 'building') {
  return {
    id: ACTIVE_ID,
    revision: 'candidate-r2',
    status: 'running',
    phase,
    startedAt: '2026-09-03T00:00:00.000Z',
    finishedAt: null,
    embedding: { provider: 'dashscope', model: 'embedding-next', dimensions: 8 },
    progress: { phase, completed: 2, total: 5, percent: 40 },
  };
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  return { response, body: await response.json() };
}

test('admin cancellation authenticates, validates the exact rebuild UUID, and leaves the active index unchanged', async (t) => {
  const project = await temporaryProject('vaultmind-embedding-cancel-api-');
  let pending = pendingJob();
  const cancelled = [];
  const active = publicIndex();
  const index = {
    policy: { root: project.vaultPath },
    status: () => ({ state: pending ? 'rebuilding' : 'ready', active, pending, ...active }),
  };
  const embeddingRuntime = {
    publicStatus: () => ({ state: pending ? 'rebuilding' : 'ready', active, pending, lastAttempt: null }),
    cancel(id) {
      if (!pending || pending.id !== id || ['commit_barrier', 'switching'].includes(pending.phase)) return false;
      cancelled.push(id);
      pending = null;
      return true;
    },
  };
  const registry = {
    ready: Promise.resolve(),
    refresh: async () => runtimeSnapshot(),
  };
  const manager = { ready: Promise.resolve(), close: async () => {} };
  let app;
  t.after(async () => {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    await project.cleanup();
  });
  app = await createApp(appConfig(project), {
    runtimeConfig: registry,
    embeddingRuntime,
    index,
    manager,
    store: {},
    llm: {},
    llmRouter: {},
    webSearch: {},
    webReader: { publicStatus: () => ({ enabled: false, pdfAvailable: false }) },
    responsesExtractor: {},
    conversations: {},
  });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const body = (rebuildId = ACTIVE_ID, adminPassword = ADMIN_PASSWORD, extra = {}) => JSON.stringify({
    action: 'cancel', rebuildId, adminPassword, ...extra,
  });
  const headers = { 'content-type': 'application/json', 'x-vaultmind-request': '1' };

  const anonymous = await requestJson(base, '/api/admin/embedding-rebuild', {
    method: 'POST', headers, body: body(),
  });
  assert.equal(anonymous.response.status, 401);

  const login = await requestJson(base, '/api/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  assert.equal(login.response.status, 200);
  const authenticatedHeaders = { ...headers, cookie: login.response.headers.get('set-cookie') };

  const conflictingEmbeddingUpdate = await requestJson(base, '/api/admin/runtime-config', {
    method: 'PUT',
    headers: authenticatedHeaders,
    body: JSON.stringify({
      schemaVersion: 2,
      expectedRevision: 'a'.repeat(64),
      embedding: { provider: 'disabled' },
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(conflictingEmbeddingUpdate.response.status, 409);
  assert.equal(conflictingEmbeddingUpdate.body.error, 'INDEX_REBUILD_IN_PROGRESS');

  const wrongPassword = await requestJson(base, '/api/admin/embedding-rebuild', {
    method: 'POST', headers: authenticatedHeaders, body: body(ACTIVE_ID, 'incorrect password'),
  });
  assert.equal(wrongPassword.response.status, 401);
  assert.deepEqual(cancelled, []);

  const invalidId = await requestJson(base, '/api/admin/embedding-rebuild', {
    method: 'POST', headers: authenticatedHeaders, body: body('../candidate-slot'),
  });
  assert.equal(invalidId.response.status, 400);
  assert.equal(invalidId.body.error, 'INVALID_EMBEDDING_REBUILD_ID');

  const unsupported = await requestJson(base, '/api/admin/embedding-rebuild', {
    method: 'POST', headers: authenticatedHeaders, body: body(ACTIVE_ID, ADMIN_PASSWORD, { expectedRevision: 'ignored' }),
  });
  assert.equal(unsupported.response.status, 400);
  assert.equal(unsupported.body.error, 'UNSUPPORTED_REBUILD_OPTION');

  const differentTask = await requestJson(base, '/api/admin/embedding-rebuild', {
    method: 'POST', headers: authenticatedHeaders, body: body(OTHER_ID),
  });
  assert.equal(differentTask.response.status, 404);
  assert.equal(differentTask.body.error, 'INDEX_REBUILD_NOT_FOUND');

  pending = pendingJob('commit_barrier');
  const tooLate = await requestJson(base, '/api/admin/embedding-rebuild', {
    method: 'POST', headers: authenticatedHeaders, body: body(),
  });
  assert.equal(tooLate.response.status, 409);
  assert.equal(tooLate.body.error, 'INDEX_REBUILD_NOT_CANCELLABLE');
  assert.deepEqual(cancelled, []);

  pending = pendingJob('building');
  const accepted = await requestJson(base, '/api/admin/embedding-rebuild', {
    method: 'POST', headers: authenticatedHeaders, body: body(),
  });
  assert.equal(accepted.response.status, 202);
  assert.deepEqual(accepted.body.cancellation, { id: ACTIVE_ID, status: 'cancelling' });
  assert.deepEqual(cancelled, [ACTIVE_ID]);
  assert.equal(accepted.body.index.active.revision, active.revision);
  assert.equal(accepted.body.index.active.generation, active.generation);
});
