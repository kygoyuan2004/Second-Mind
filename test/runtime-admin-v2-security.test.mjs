import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RuntimeConfigRegistry } from '../src/runtime-config-registry.mjs';
import { createApp } from '../src/server.mjs';
import { temporaryProject } from './helpers.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_PASSWORD = ['correct', 'horse', 'battery', 'staple'].join(' ');
const MODEL_SECRET = ['model', 'fixture', 'credential', '123456'].join('-');
const BAILIAN_SECRET = ['bailian', 'fixture', 'credential', '123456'].join('-');
const TAVILY_SECRET = ['tavily', 'fixture', 'credential', '123456'].join('-');

const MODEL_CATALOG = ['qwen', 'kimi', 'deepseek'].map((id) => ({
  id, label: id, actualModel: `${id}-fixture-model`, provider: 'anthropic',
  efforts: ['default'], defaultEffort: 'default', available: true,
}));

function appConfig(project) {
  return {
    ...project.config,
    projectRoot,
    publicDir: path.join(projectRoot, 'public'),
    appName: 'Runtime admin v2 fixture',
    vaultLabel: 'Fixture Vault',
    host: '127.0.0.1',
    port: 0,
    timezone: 'UTC',
    trustProxy: false,
    auth: {
      username: 'admin', password: ADMIN_PASSWORD,
      sessionSecret: 'TEST_ONLY_NOT_A_REAL_SESSION_SECRET',
      sessionTtlSeconds: 3_600, secureCookie: false,
    },
    modelCatalog: MODEL_CATALOG,
    llm: {
      provider: 'anthropic', protocol: 'anthropic-messages',
      apiBase: 'https://models.example.test/anthropic', apiKey: MODEL_SECRET,
      authMode: 'x-api-key', model: 'qwen-fixture-model', timeoutMs: 1_000,
      maxOutputTokens: 256, temperature: null, allowInsecureHttp: false,
    },
    embedding: {
      provider: 'disabled', apiBase: '', apiKey: '', model: '', dimensions: 1_024,
      batchSize: 2, timeoutMs: 1_000, allowInsecureHttp: false,
    },
    webSearch: {
      provider: 'bailian-mcp', enabled: false, apiKey: BAILIAN_SECRET,
      timeoutMs: 1_000, resultCount: 15, deepResultCount: 6,
      maxResultsPerDomain: 2, modelSourceLimit: 10, maxContextChars: 30_000,
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

test('v2 admin PUT validates before commit, keeps CAS, and never crosses or echoes provider keys', async (t) => {
  const project = await temporaryProject('vaultmind-runtime-admin-v2-');
  const config = appConfig(project);
  const managedFile = path.join(project.dataDir, 'runtime-config-v2.json');
  const registry = new RuntimeConfigRegistry({
    managedFile,
    modelCatalog: MODEL_CATALOG,
    llm: config.llm,
    embedding: config.embedding,
    webSearch: config.webSearch,
  });
  await registry.ready;
  await registry.bootstrapManagedV2({ tavilyApiKey: TAVILY_SECRET });

  let rejectLlmValidation = true;
  let llmValidationCalls = 0;
  let webValidationCalls = 0;
  let extractionCalls = 0;
  const llmRouter = {
    validateAllEnabled: async (snapshot) => {
      llmValidationCalls += 1;
      assert.equal(snapshot.connections[0].apiKey, MODEL_SECRET);
      if (rejectLlmValidation) {
        const error = new Error('fixture model validation rejected');
        error.code = 'LLM_VALIDATION_FAILED';
        error.status = 400;
        throw error;
      }
      return { ok: true, checked: 3 };
    },
  };
  const webSearch = {
    publicStatus: () => ({ enabled: false, configured: false, provider: 'bailian-mcp' }),
    acquireForTask: async ({ runtimeSnapshot }) => {
      webValidationCalls += 1;
      assert.equal(runtimeSnapshot.webSearch.provider, 'tavily-rest');
      assert.equal(runtimeSnapshot.webSearch.apiKey, TAVILY_SECRET);
      assert.equal(runtimeSnapshot.webSearch.providerConfigs['bailian-mcp'].apiKey, BAILIAN_SECRET);
      return {
        publicStatus: () => ({ enabled: true, configured: true, provider: 'tavily-rest' }),
        searchMany: async () => ({
          results: [{ title: 'Example', url: 'https://example.com/', snippet: '' }],
          attempts: [{ status: 'completed' }], errors: [],
        }),
        close: async () => {},
      };
    },
  };
  const responsesExtractor = {
    acquireForTask: async () => {
      extractionCalls += 1;
      throw new Error('extractor must remain disabled in this fixture');
    },
  };
  const embeddingRuntime = { startRebuild: async () => ({ status: 'running' }) };
  const llm = { generate: async () => 'fixture response' };
  let app;
  t.after(async () => {
    if (app) {
      await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await project.cleanup();
  });
  app = await createApp(config, {
    runtimeConfig: registry, embeddingRuntime, llm, llmRouter, webSearch, responsesExtractor,
  });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await requestJson(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie');
  const headers = { cookie, 'content-type': 'application/json', 'x-vaultmind-request': '1' };
  const initial = await requestJson(base, '/api/admin/runtime-config', { headers: { cookie } });
  assert.equal(initial.body.schemaVersion, 2);
  assert.equal(JSON.stringify(initial.body).includes(MODEL_SECRET), false);
  assert.equal(JSON.stringify(initial.body).includes(BAILIAN_SECRET), false);
  assert.equal(JSON.stringify(initial.body).includes(TAVILY_SECRET), false);
  const before = await fsp.readFile(managedFile, 'utf8');
  const patch = {
    schemaVersion: 2,
    expectedRevision: initial.body.revision,
    adminPassword: ADMIN_PASSWORD,
    webSearch: {
      enabled: true,
      provider: 'tavily-rest',
      providers: {
        'bailian-mcp': { apiKeyAction: 'keep', extractFallbackEnabled: false },
        'tavily-rest': { apiKeyAction: 'keep', extractFallbackEnabled: false },
      },
    },
  };

  const rejected = await requestJson(base, '/api/admin/runtime-config', {
    method: 'PUT', headers, body: JSON.stringify(patch),
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.error, 'LLM_VALIDATION_FAILED');
  assert.equal(await fsp.readFile(managedFile, 'utf8'), before);
  assert.equal(webValidationCalls, 0);

  rejectLlmValidation = false;
  const saved = await requestJson(base, '/api/admin/runtime-config', {
    method: 'PUT', headers, body: JSON.stringify(patch),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.webSearch.provider, 'tavily-rest');
  assert.equal(saved.body.webSearch.configured, true);
  assert.equal(llmValidationCalls, 2);
  assert.equal(webValidationCalls, 1);
  assert.equal(extractionCalls, 0);
  assert.equal(JSON.stringify(saved.body).includes(MODEL_SECRET), false);
  assert.equal(JSON.stringify(saved.body).includes(BAILIAN_SECRET), false);
  assert.equal(JSON.stringify(saved.body).includes(TAVILY_SECRET), false);

  const stale = await requestJson(base, '/api/admin/runtime-config', {
    method: 'PUT', headers, body: JSON.stringify(patch),
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error, 'RUNTIME_CONFIG_REVISION_CONFLICT');
  assert.equal(llmValidationCalls, 2);
  assert.equal(webValidationCalls, 1);
});
