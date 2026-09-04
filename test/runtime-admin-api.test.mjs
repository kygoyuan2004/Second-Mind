import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RuntimeConfigRegistry } from '../src/runtime-config-registry.mjs';
import { createApp } from '../src/server.mjs';
import { temporaryProject } from './helpers.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_PASSWORD = 'correct horse battery staple';

const MODEL_CATALOG = [
  {
    id: 'qwen', label: 'Qwen', actualModel: 'qwen-default', provider: 'anthropic',
    efforts: ['low', 'xhigh'], defaultEffort: 'xhigh', available: true,
  },
  {
    id: 'kimi', label: 'Kimi', actualModel: 'kimi-default', provider: 'anthropic',
    efforts: ['medium', 'high'], defaultEffort: 'medium', available: true,
  },
  {
    id: 'deepseek', label: 'DeepSeek', actualModel: 'deepseek-default', provider: 'anthropic',
    efforts: ['high', 'max'], defaultEffort: 'high', available: true,
  },
];

function settings(models) {
  return {
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: models.qwen,
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Qwen managed by settings',
      ANTHROPIC_DEFAULT_SONNET_MODEL: models.kimi,
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Kimi managed by settings',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: models.deepseek,
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'DeepSeek managed by settings',
      UNRELATED_PRIVATE_VALUE: 'must-not-appear',
    },
  };
}

async function writePrivateJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fsp.chmod(filename, 0o600);
}

function appConfig(project) {
  return {
    ...project.config,
    projectRoot,
    publicDir: path.join(projectRoot, 'public'),
    appName: 'Runtime admin fixture',
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
    modelCatalog: MODEL_CATALOG,
    llm: {
      provider: 'anthropic', apiBase: 'https://provider.invalid', apiKey: 'fixture-only',
      model: 'qwen-default', timeoutMs: 1_000, maxOutputTokens: 256, temperature: 0,
      allowInsecureHttp: false,
    },
    embedding: {
      provider: 'disabled', apiBase: '', apiKey: '', model: '', dimensions: 1_024,
      batchSize: 2, timeoutMs: 1_000, allowInsecureHttp: false,
    },
    webSearch: {
      provider: 'bailian-mcp', enabled: false, apiKey: '', timeoutMs: 1_000,
      resultCount: 15, deepResultCount: 6, maxResultsPerDomain: 2,
      modelSourceLimit: 10, maxContextChars: 30_000,
    },
    responsesFallback: { enabled: false },
    webReader: { enabled: false, pdfEnabled: false },
    research: { contextualizerEnabled: false, loopEnabled: false },
    retrieval: { topK: 8, maxContextChars: 10_000, watch: false, reconcileIntervalMs: 60_000 },
    deep: { enabled: true, topK: 12 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  return { response, body: await response.json() };
}

test('administrator runtime API hot-refreshes real IDs, guards revisions, and never echoes credentials', async (t) => {
  const project = await temporaryProject('vaultmind-runtime-admin-');
  const settingsFile = path.join(project.dataDir, 'settings.json');
  const managedFile = path.join(project.dataDir, 'runtime-config.json');
  await writePrivateJson(settingsFile, settings({
    qwen: 'qwen-real-v1[1M]',
    kimi: 'kimi-real-v1[1M]',
    deepseek: 'deepseek-real-v1',
  }));
  const config = appConfig(project);
  const registry = new RuntimeConfigRegistry({
    settingsFile,
    managedFile,
    modelCatalog: MODEL_CATALOG,
    embedding: config.embedding,
    webSearch: config.webSearch,
  });
  await registry.ready;
  const rebuildCalls = [];
  const embeddingRuntime = {
    startRebuild: async (revision) => {
      rebuildCalls.push(revision);
      return {
        id: 'fixture-rebuild', revision, status: 'running', phase: 'validating',
        embedding: { provider: 'dashscope', model: 'embed-fixture', dimensions: 1_024 },
        progress: { phase: 'validating', completed: 0, total: 1, percent: 0 },
      };
    },
  };
  const llm = {
    publicStatus: () => ({ provider: 'fixture', model: 'fixture', configured: true }),
    generate: async () => 'fixture response',
  };
  let app;
  t.after(async () => {
    if (app) {
      await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await project.cleanup();
  });
  app = await createApp(config, { runtimeConfig: registry, embeddingRuntime, llm });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const anonymous = await requestJson(base, '/api/admin/runtime-config');
  assert.equal(anonymous.response.status, 401);

  const login = await requestJson(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie');
  const readHeaders = { cookie };
  const writeHeaders = {
    cookie,
    'content-type': 'application/json',
    'x-vaultmind-request': '1',
  };

  const session = await requestJson(base, '/api/session', { headers: readHeaders });
  assert.equal(session.body.permissions.manageRuntimeConfig, true);
  const initial = await requestJson(base, '/api/admin/runtime-config', { headers: readHeaders });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.models[0].actualModel, 'qwen-real-v1[1M]');
  assert.equal(initial.body.source, 'settings');
  assert.equal(JSON.stringify(initial.body).includes('must-not-appear'), false);
  assert.equal(Object.hasOwn(initial.body.webSearch, 'apiKey'), false);
  assert.equal(Object.hasOwn(initial.body.embedding, 'apiKey'), false);

  const oldCatalogRevision = initial.body.modelCatalogRevision;
  await writePrivateJson(settingsFile, settings({
    qwen: 'qwen-real-v2[1M]',
    kimi: 'kimi-real-v1[1M]',
    deepseek: 'deepseek-real-v1',
  }));
  const hotStatus = await requestJson(base, '/api/knowledge/status', { headers: readHeaders });
  assert.equal(hotStatus.body.models[0].actualModel, 'qwen-real-v2[1M]');
  assert.notEqual(hotStatus.body.modelCatalogRevision, oldCatalogRevision);
  const staleTask = await requestJson(base, '/api/knowledge/tasks', {
    method: 'POST', headers: writeHeaders,
    body: JSON.stringify({
      kind: 'qa', prompt: 'fixture question', model: 'qwen', effort: 'xhigh',
      modelCatalogRevision: oldCatalogRevision,
    }),
  });
  assert.equal(staleTask.response.status, 409);
  assert.equal(staleTask.body.error, 'MODEL_CATALOG_CHANGED');

  const withoutGuard = await requestJson(base, '/api/admin/runtime-config', {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(withoutGuard.response.status, 403);
  const wrongPassword = await requestJson(base, '/api/admin/runtime-config', {
    method: 'PUT', headers: writeHeaders,
    body: JSON.stringify({ expectedRevision: hotStatus.body.configRevision, adminPassword: 'wrong password' }),
  });
  assert.equal(wrongPassword.response.status, 401);

  const webSecret = 'web-secret-fixture-123456';
  const latest = await requestJson(base, '/api/admin/runtime-config', { headers: readHeaders });
  const saved = await requestJson(base, '/api/admin/runtime-config', {
    method: 'PUT', headers: writeHeaders,
    body: JSON.stringify({
      expectedRevision: latest.body.revision,
      adminPassword: ADMIN_PASSWORD,
      webSearch: { enabled: true, apiKeyAction: 'replace', apiKey: webSecret },
    }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.webSearch.configured, true);
  assert.equal(JSON.stringify(saved.body).includes(webSecret), false);
  assert.equal((await fsp.stat(managedFile)).mode & 0o777, 0o600);

  const embeddingSecret = 'embedding-secret-fixture-123456';
  const built = await requestJson(base, '/api/admin/embedding-rebuild', {
    method: 'POST', headers: writeHeaders,
    body: JSON.stringify({
      expectedRevision: saved.body.revision,
      adminPassword: ADMIN_PASSWORD,
      action: 'validate-and-build',
      embedding: {
        provider: 'dashscope',
        apiBase: 'https://dashscope.aliyuncs.com',
        model: 'embed-fixture',
        dimensions: 1_024,
        apiKeyAction: 'replace',
        apiKey: embeddingSecret,
      },
    }),
  });
  assert.equal(built.response.status, 202);
  assert.equal(built.body.rebuild.id, 'fixture-rebuild');
  assert.equal(rebuildCalls.length, 1);
  assert.equal(rebuildCalls[0], built.body.revision);
  assert.equal(JSON.stringify(built.body).includes(embeddingSecret), false);
  assert.equal(JSON.stringify(built.body).includes(webSecret), false);
});
