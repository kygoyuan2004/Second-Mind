import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ValidationCredentialStore } from '../src/provider-config-dto.mjs';
import { RuntimeChatModelRouter } from '../src/runtime-chat-model-router.mjs';
import { RuntimeConfigRegistry } from '../src/runtime-config-registry.mjs';
import { createApp } from '../src/server.mjs';
import { temporaryProject } from './helpers.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_PASSWORD = 'fixture administrator password';
const MODEL_KEY = 'fixture-model-api-key-private';
const API_BASE = 'https://models.example.test/anthropic';

const MODEL_CATALOG = ['qwen', 'kimi', 'deepseek'].map((id) => ({
  id,
  label: `Model ${id}`,
  actualModel: `provider-${id}-v1`,
  provider: 'anthropic',
  efforts: ['default'],
  defaultEffort: 'default',
  available: true,
}));

function appConfig(project) {
  return {
    ...project.config,
    projectRoot,
    publicDir: path.join(projectRoot, 'public'),
    appName: 'Fixture App',
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
      apiBase: API_BASE, apiKey: MODEL_KEY, authMode: 'x-api-key',
      model: MODEL_CATALOG[0].actualModel, timeoutMs: 1_000,
      maxOutputTokens: 256, temperature: null, allowInsecureHttp: false,
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

async function login(base) {
  const result = await requestJson(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  assert.equal(result.response.status, 200);
  return result.response.headers.get('set-cookie');
}

function writeHeaders(cookie) {
  return { cookie, 'content-type': 'application/json', 'x-vaultmind-request': '1' };
}

function editablePayload(dto) {
  return {
    schemaVersion: dto.schemaVersion,
    expectedRevision: dto.revision,
    defaultModelId: dto.defaultModelId,
    adminPassword: ADMIN_PASSWORD,
    providers: dto.providers.map((provider) => ({
      id: provider.id,
      providerId: provider.providerId,
      apiBase: provider.apiBase,
      protocol: provider.protocol,
      authMode: provider.authMode,
      apiKeyAction: 'keep',
      models: provider.models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        actualModel: model.actualModel,
        enabled: model.enabled,
      })),
    })),
  };
}

async function listen(app) {
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}

async function closeApp(app) {
  await app.manager.close();
  await new Promise((resolve) => app.server.close(resolve));
}

test('provider configuration API is redacted, validates transactionally, and uses one-shot receipts', async (t) => {
  const project = await temporaryProject('vaultmind-provider-config-api-');
  const config = appConfig(project);
  const registry = new RuntimeConfigRegistry({
    managedFile: path.join(project.dataDir, 'runtime-config-v2.json'),
    modelCatalog: MODEL_CATALOG,
    llm: config.llm,
    embedding: config.embedding,
    webSearch: config.webSearch,
    branding: { appName: 'Managed Fixture', vaultLabel: 'Private Fixture Vault' },
  });
  await registry.ready;
  await registry.bootstrapManagedV2();

  let failedModel = MODEL_CATALOG[1].id;
  const validationCalls = [];
  const llmRouter = new RuntimeChatModelRouter({
    registry,
    baseConfig: config.llm,
    clientFactory: (privateConfig) => ({
      async generate(messages, options) {
        validationCalls.push({ privateConfig, messages, options });
        if (privateConfig.model === `provider-${failedModel}-v1`) {
          const error = new Error(`credential ${privateConfig.apiKey} rejected`);
          error.code = 'FIXTURE_MODEL_REJECTED';
          throw error;
        }
        return 'OK';
      },
    }),
  });
  const webSearch = {
    publicStatus: () => ({ enabled: false, configured: false, provider: 'bailian-mcp' }),
  };
  const responsesExtractor = {
    publicStatus: () => ({ enabled: false, configured: false }),
  };
  const embeddingProbes = [];
  const embeddingRebuilds = [];
  const embeddingRuntime = {
    async detectDimensions(candidate) {
      embeddingProbes.push(candidate);
      return 768;
    },
    async startRebuild(revision) {
      embeddingRebuilds.push(revision);
      return { id: 'embedding-fixture-rebuild', status: 'running', revision };
    },
  };
  const apps = [];
  t.after(async () => {
    for (const app of apps.reverse()) await closeApp(app);
    await project.cleanup();
  });

  const firstStore = new ValidationCredentialStore();
  const app = await createApp(config, {
    runtimeConfig: registry,
    embeddingRuntime,
    llmRouter,
    providerValidationCredentials: firstStore,
    webSearch,
    responsesExtractor,
    llm: { generate: async () => 'unused' },
  });
  apps.push(app);
  const base = await listen(app);
  const cookie = await login(base);

  const anonymous = await requestJson(base, '/api/admin/provider-config');
  assert.equal(anonymous.response.status, 401);
  const initial = await requestJson(base, '/api/admin/provider-config', { headers: { cookie } });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.branding.appName, 'Managed Fixture');
  assert.equal(initial.body.branding.vaultLabel, 'Private Fixture Vault');
  assert.deepEqual(initial.body.providerOptions.map((entry) => entry.id), [
    'bailian', 'deepseek', 'glm', 'kimi', 'custom',
  ]);
  assert.equal(initial.body.providers[0].apiBase, API_BASE);
  assert.equal(initial.body.providers[0].apiKeyConfigured, true);
  assert.equal(JSON.stringify(initial.body).includes(MODEL_KEY), false);
  assert.equal(Object.hasOwn(initial.body.providers[0], 'apiKey'), false);

  const publicStatus = await requestJson(base, '/api/knowledge/status', { headers: { cookie } });
  assert.equal(publicStatus.response.status, 200);
  assert.equal(JSON.stringify(publicStatus.body).includes(API_BASE), false);
  assert.equal(JSON.stringify(publicStatus.body).includes(MODEL_KEY), false);

  const failed = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie),
    body: JSON.stringify(editablePayload(initial.body)),
  });
  assert.equal(failed.response.status, 422, JSON.stringify(failed.body));
  assert.equal(failed.body.error, 'LLM_VALIDATION_FAILED');
  assert.equal(failed.body.results.length, 3);
  assert.equal(failed.body.results.filter((entry) => entry.ok === false).length, 1);
  assert.deepEqual(
    failed.body.results.map((entry) => entry.modelId).sort(),
    MODEL_CATALOG.map((entry) => entry.id).sort(),
  );
  assert.equal(Object.hasOwn(failed.body, 'validationId'), false);
  assert.equal(JSON.stringify(failed.body).includes(MODEL_KEY), false);
  assert.equal(firstStore.size, 0);
  assert.equal(validationCalls.length, 3);
  for (const call of validationCalls) {
    assert.equal(call.options.maxOutputTokens, 64);
    assert.equal(call.options.stream, false);
    assert.equal(JSON.stringify(call.messages).includes('Reply with OK.'), true);
  }
  const afterRejectedValidation = await requestJson(base, '/api/admin/provider-config', {
    headers: { cookie },
  });
  assert.equal(afterRejectedValidation.body.revision, initial.body.revision);

  failedModel = '';
  const callsBeforeTargetCheck = validationCalls.length;
  const targetChecked = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie),
    body: JSON.stringify({
      ...editablePayload(initial.body),
      validateConnectionId: initial.body.providers[0].id,
    }),
  });
  assert.equal(targetChecked.response.status, 200, JSON.stringify(targetChecked.body));
  assert.equal(targetChecked.body.scope.kind, 'provider');
  assert.equal(targetChecked.body.scope.connectionId, initial.body.providers[0].id);
  assert.equal(targetChecked.body.webSearch.skipped, true);
  assert.equal(Object.hasOwn(targetChecked.body, 'validationId'), false);
  assert.match(targetChecked.body.validationStageId, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(validationCalls.length - callsBeforeTargetCheck, 3);
  assert.equal(firstStore.size, 0);

  const validated = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: initial.body.revision,
      validationStageId: targetChecked.body.validationStageId,
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(validated.response.status, 200);
  assert.equal(validated.body.results.length, 3);
  assert.equal(validated.body.results.every((entry) => entry.ok === true), true);
  assert.match(validated.body.validationId, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(JSON.stringify(validated.body).includes(MODEL_KEY), false);
  assert.equal(Object.hasOwn(validated.body, 'candidate'), false);
  assert.equal(firstStore.size, 1);
  assert.equal(
    validationCalls.length - callsBeforeTargetCheck,
    3,
    'the final validation must not bill the already checked Provider again',
  );
  const callsAfterFullValidation = validationCalls.length;

  const committed = await requestJson(base, '/api/admin/provider-config', {
    method: 'PUT', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: initial.body.revision,
      validationId: validated.body.validationId,
      branding: { appName: 'Renamed Fixture', vaultLabel: 'Renamed Vault' },
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(committed.response.status, 200);
  assert.equal(committed.body.branding.appName, 'Renamed Fixture');
  assert.equal(committed.body.revision === initial.body.revision, false);
  assert.equal(firstStore.size, 0);
  assert.equal(
    validationCalls.length,
    callsAfterFullValidation,
    'PUT must commit the validated candidate without a second LLM call',
  );

  const replay = await requestJson(base, '/api/admin/provider-config', {
    method: 'PUT', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: committed.body.revision,
      validationId: validated.body.validationId,
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(replay.response.status, 409);
  assert.equal(replay.body.error, 'VALIDATION_CREDENTIAL_INVALID');

  const beforeBrandingValidationCalls = validationCalls.length;
  const brandingOnly = await requestJson(base, '/api/admin/provider-config', {
    method: 'PUT', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: committed.body.revision,
      branding: { appName: 'Brand Only', vaultLabel: 'No Model Validation' },
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(brandingOnly.response.status, 200);
  assert.equal(brandingOnly.body.branding.appName, 'Brand Only');
  assert.equal(validationCalls.length, beforeBrandingValidationCalls);

  const current = brandingOnly.body;
  const staleValidated = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie),
    body: JSON.stringify(editablePayload(current)),
  });
  assert.equal(staleValidated.response.status, 200);
  const edited = await requestJson(base, '/api/admin/provider-config', {
    method: 'PUT', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: current.revision,
      branding: { appName: 'Edited Later', vaultLabel: 'Receipt Must Expire' },
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(edited.response.status, 200);
  const staleCommit = await requestJson(base, '/api/admin/provider-config', {
    method: 'PUT', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: current.revision,
      validationId: staleValidated.body.validationId,
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(staleCommit.response.status, 409);
  assert.equal(staleCommit.body.error, 'PROVIDER_CONFIG_REVISION_CONFLICT');
  assert.equal(firstStore.size, 0);

  const restartValidated = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie),
    body: JSON.stringify(editablePayload(edited.body)),
  });
  assert.equal(restartValidated.response.status, 200);
  assert.equal(firstStore.size, 1);

  const restartedApp = await createApp(config, {
    runtimeConfig: registry,
    embeddingRuntime,
    llmRouter,
    providerValidationCredentials: new ValidationCredentialStore(),
    webSearch,
    responsesExtractor,
    llm: { generate: async () => 'unused' },
  });
  apps.push(restartedApp);
  const restartedBase = await listen(restartedApp);
  const restartedCookie = await login(restartedBase);
  const afterRestart = await requestJson(restartedBase, '/api/admin/provider-config', {
    method: 'PUT', headers: writeHeaders(restartedCookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: edited.body.revision,
      validationId: restartValidated.body.validationId,
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(afterRestart.response.status, 409);
  assert.equal(afterRestart.body.error, 'VALIDATION_CREDENTIAL_INVALID');

  const beforeEmbedding = await requestJson(restartedBase, '/api/admin/provider-config', {
    headers: { cookie: restartedCookie },
  });
  const embeddingKey = ['fixture', 'embedding', 'credential', 'private'].join('-');
  const embeddingBuild = await requestJson(restartedBase, '/api/admin/embedding-rebuild', {
    method: 'POST', headers: writeHeaders(restartedCookie),
    body: JSON.stringify({
      action: 'validate-and-build',
      expectedRevision: beforeEmbedding.body.revision,
      adminPassword: ADMIN_PASSWORD,
      embedding: {
        provider: 'dashscope',
        apiBase: 'https://dashscope.aliyuncs.com',
        model: 'fixture-embedding-model',
        apiKeyAction: 'replace',
        apiKey: embeddingKey,
      },
    }),
  });
  assert.equal(embeddingBuild.response.status, 202, JSON.stringify(embeddingBuild.body));
  assert.equal(embeddingBuild.body.embedding.dimensions, 768);
  assert.equal(embeddingProbes.length, 1);
  assert.equal(embeddingRebuilds.length, 1);
  assert.equal(JSON.stringify(embeddingBuild.body).includes(embeddingKey), false);
  assert.equal(registry.runtimeSnapshot().embedding.dimensions, 768);
});

test('provider receipt validates and commits model plus Web Search changes once', async (t) => {
  const project = await temporaryProject('vaultmind-provider-web-transaction-');
  const modelKey = ['fixture', 'model', 'transaction', 'credential'].join('-');
  const searchKey = ['fixture', 'search', 'transaction', 'credential'].join('-');
  const config = {
    ...appConfig(project),
    llm: { ...appConfig(project).llm, apiKey: modelKey },
    webSearch: { ...appConfig(project).webSearch, enabled: true, apiKey: searchKey },
  };
  const registry = new RuntimeConfigRegistry({
    managedFile: path.join(project.dataDir, 'runtime-config-v2.json'),
    modelCatalog: MODEL_CATALOG,
    llm: config.llm,
    embedding: config.embedding,
    webSearch: config.webSearch,
  });
  await registry.ready;
  await registry.bootstrapManagedV2();
  let modelCalls = 0;
  let searchCalls = 0;
  const llmRouter = new RuntimeChatModelRouter({
    registry,
    baseConfig: config.llm,
    clientFactory: () => ({
      async generate() {
        modelCalls += 1;
        return 'OK';
      },
    }),
  });
  const webSearch = {
    publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
    async acquireForTask() {
      return {
        publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
        async searchMany() {
          searchCalls += 1;
          return {
            attempts: [{ status: 'completed' }], errors: [],
            results: [{ title: 'Fixture', url: 'https://example.com/', snippet: 'Fixture' }],
          };
        },
        async close() {},
      };
    },
  };
  const app = await createApp(config, {
    runtimeConfig: registry,
    embeddingRuntime: { startRebuild: async () => ({ status: 'running' }) },
    llmRouter,
    webSearch,
    responsesExtractor: { publicStatus: () => ({ enabled: false, configured: false }) },
    llm: { generate: async () => 'unused' },
  });
  t.after(async () => {
    await closeApp(app);
    await project.cleanup();
  });
  const base = await listen(app);
  const cookie = await login(base);
  const current = await requestJson(base, '/api/admin/provider-config', { headers: { cookie } });
  const candidate = editablePayload(current.body);
  candidate.webSearch = {
    enabled: true,
    provider: 'bailian-mcp',
    providers: {
      'bailian-mcp': { apiKeyAction: 'keep', extractFallbackEnabled: false },
      'tavily-rest': { apiKeyAction: 'keep', extractFallbackEnabled: false },
    },
  };
  const validated = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie), body: JSON.stringify(candidate),
  });
  assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
  assert.equal(validated.body.webSearch.ok, true);
  assert.equal(validated.body.webSearch.webSearch, true);
  assert.equal(modelCalls, 3);
  assert.equal(searchCalls, 1);
  const committed = await requestJson(base, '/api/admin/provider-config', {
    method: 'PUT', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: current.body.revision,
      validationId: validated.body.validationId,
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(committed.response.status, 200, JSON.stringify(committed.body));
  assert.equal(modelCalls, 3, 'receipt commit must not repeat model validation');
  assert.equal(searchCalls, 1, 'receipt commit must not repeat Web Search validation');
  assert.equal(committed.body.webSearch.provider, 'bailian-mcp');
});

test('Web extraction validation failure reports a sanitized stage and nested cause', async (t) => {
  const project = await temporaryProject('vaultmind-provider-web-extract-error-');
  const modelKey = ['fixture', 'model', 'extract', 'credential'].join('-');
  const searchKey = ['fixture', 'search', 'extract', 'credential'].join('-');
  const sensitiveProviderDetail = ['private', 'provider', 'diagnostic'].join('-');
  let extractionErrorCode = 'BAILIAN_EXTRACTOR_FORBIDDEN';
  const config = {
    ...appConfig(project),
    llm: { ...appConfig(project).llm, apiKey: modelKey },
    webSearch: { ...appConfig(project).webSearch, enabled: true, apiKey: searchKey },
  };
  const registry = new RuntimeConfigRegistry({
    managedFile: path.join(project.dataDir, 'runtime-config-v2.json'),
    modelCatalog: MODEL_CATALOG,
    llm: config.llm,
    embedding: config.embedding,
    webSearch: config.webSearch,
  });
  await registry.ready;
  await registry.bootstrapManagedV2();
  const llmRouter = new RuntimeChatModelRouter({
    registry,
    baseConfig: config.llm,
    clientFactory: () => ({ generate: async () => 'OK' }),
  });
  const webSearch = {
    async acquireForTask() {
      return {
        publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
        async searchMany() {
          return {
            attempts: [{ status: 'completed' }],
            errors: [],
            results: [{ title: 'Fixture', url: 'https://example.com/', snippet: 'Fixture' }],
          };
        },
        async close() {},
      };
    },
  };
  const responsesExtractor = {
    async acquireForTask() {
      return {
        publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-responses' }),
        async extract() {
          return {
            attempts: [{ status: 'failed' }],
            errors: [{
              code: extractionErrorCode,
              message: sensitiveProviderDetail,
            }],
          };
        },
        async close() {},
      };
    },
  };
  const app = await createApp(config, {
    runtimeConfig: registry,
    embeddingRuntime: { startRebuild: async () => ({ status: 'running' }) },
    llmRouter,
    webSearch,
    responsesExtractor,
    llm: { generate: async () => 'unused' },
  });
  t.after(async () => {
    await closeApp(app);
    await project.cleanup();
  });
  const base = await listen(app);
  const cookie = await login(base);
  const current = await requestJson(base, '/api/admin/provider-config', { headers: { cookie } });
  const candidate = editablePayload(current.body);
  candidate.webSearch = {
    enabled: true,
    provider: 'bailian-mcp',
    providers: {
      'bailian-mcp': { apiKeyAction: 'keep', extractFallbackEnabled: true },
      'tavily-rest': { apiKeyAction: 'keep', extractFallbackEnabled: false },
    },
  };
  const validated = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie), body: JSON.stringify(candidate),
  });
  assert.equal(validated.response.status, 422, JSON.stringify(validated.body));
  assert.equal(validated.body.error, 'WEB_EXTRACT_VALIDATION_FAILED');
  assert.deepEqual(validated.body.webSearch, {
    ok: false,
    provider: 'bailian-mcp',
    stage: 'extract',
    code: 'WEB_EXTRACT_VALIDATION_FAILED',
    causeCode: 'BAILIAN_EXTRACTOR_FORBIDDEN',
    searchPassed: true,
  });
  assert.equal(Object.hasOwn(validated.body, 'validationId'), false);
  assert.equal(JSON.stringify(validated.body).includes(searchKey), false);
  assert.equal(JSON.stringify(validated.body).includes(sensitiveProviderDetail), false);

  extractionErrorCode = 'unsafe cause with account detail';
  const malformedCause = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie), body: JSON.stringify(candidate),
  });
  assert.equal(malformedCause.response.status, 422, JSON.stringify(malformedCause.body));
  assert.equal(malformedCause.body.webSearch.causeCode, 'WEB_EXTRACT_VALIDATION_FAILED');
  assert.equal(JSON.stringify(malformedCause.body).includes(extractionErrorCode), false);
});

test('staged checks support a new Provider and do not repeat already checked model calls', async (t) => {
  const project = await temporaryProject('vaultmind-provider-staged-new-');
  const config = appConfig(project);
  const registry = new RuntimeConfigRegistry({
    managedFile: path.join(project.dataDir, 'runtime-config-v2.json'),
    modelCatalog: MODEL_CATALOG,
    llm: config.llm,
    embedding: config.embedding,
    webSearch: config.webSearch,
  });
  await registry.ready;
  await registry.bootstrapManagedV2();

  const validationCalls = [];
  const llmRouter = new RuntimeChatModelRouter({
    registry,
    baseConfig: config.llm,
    clientFactory: (privateConfig) => ({
      async generate() {
        validationCalls.push({
          apiBase: privateConfig.apiBase,
          model: privateConfig.model,
        });
        return 'OK';
      },
    }),
  });
  const app = await createApp(config, {
    runtimeConfig: registry,
    embeddingRuntime: { startRebuild: async () => ({ status: 'running' }) },
    llmRouter,
    webSearch: {
      publicStatus: () => ({ enabled: false, configured: false, provider: 'bailian-mcp' }),
    },
    responsesExtractor: { publicStatus: () => ({ enabled: false, configured: false }) },
    llm: { generate: async () => 'unused' },
  });
  t.after(async () => {
    await closeApp(app);
    await project.cleanup();
  });
  const base = await listen(app);
  const cookie = await login(base);
  const current = await requestJson(base, '/api/admin/provider-config', { headers: { cookie } });
  assert.equal(current.response.status, 200);

  const existing = current.body.providers[0];
  const movedModel = existing.models.find((model) => model.id === 'deepseek');
  const candidate = {
    schemaVersion: current.body.schemaVersion,
    expectedRevision: current.body.revision,
    defaultModelId: current.body.defaultModelId,
    adminPassword: ADMIN_PASSWORD,
    providers: [
      {
        id: existing.id,
        providerId: existing.providerId,
        apiBase: existing.apiBase,
        protocol: existing.protocol,
        authMode: existing.authMode,
        apiKeyAction: 'keep',
        models: existing.models.filter((model) => model.id !== 'deepseek').map((model) => ({
          id: model.id,
          displayName: model.displayName,
          actualModel: model.actualModel,
          enabled: model.enabled,
        })),
      },
      {
        providerId: 'deepseek',
        apiBase: 'https://api.deepseek.com',
        apiKeyAction: 'replace',
        apiKey: 'fixture-deepseek-private-key',
        models: [{
          id: movedModel.id,
          displayName: movedModel.displayName,
          actualModel: 'deepseek-chat',
          enabled: true,
        }],
      },
    ],
  };

  const checkedNew = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie),
    body: JSON.stringify({ ...candidate, validateProviderIndex: 1 }),
  });
  assert.equal(checkedNew.response.status, 200, JSON.stringify(checkedNew.body));
  assert.equal(checkedNew.body.scope.providerIndex, 1);
  assert.equal(checkedNew.body.results.length, 1);
  assert.equal(validationCalls.length, 1);
  assert.equal(checkedNew.body.idAssignments.providers.length, 1);
  assert.equal(JSON.stringify(checkedNew.body).includes('fixture-deepseek-private-key'), false);

  const checkedExisting = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: current.body.revision,
      validationStageId: checkedNew.body.validationStageId,
      validateProviderIndex: 0,
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(checkedExisting.response.status, 200, JSON.stringify(checkedExisting.body));
  assert.equal(checkedExisting.body.results.length, 2);
  assert.equal(validationCalls.length, 3);

  const checkedExistingAgain = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: current.body.revision,
      validationStageId: checkedExisting.body.validationStageId,
      validateProviderIndex: 0,
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(checkedExistingAgain.response.status, 200, JSON.stringify(checkedExistingAgain.body));
  assert.equal(checkedExistingAgain.body.results.every((result) => result.cached === true), true);
  assert.equal(validationCalls.length, 3, 'checking the same staged Provider twice must not call it again');

  const fullyValidated = await requestJson(base, '/api/admin/provider-config/validate', {
    method: 'POST', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: current.body.revision,
      validationStageId: checkedExistingAgain.body.validationStageId,
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(fullyValidated.response.status, 200, JSON.stringify(fullyValidated.body));
  assert.equal(fullyValidated.body.results.length, 3);
  assert.equal(fullyValidated.body.results.every((result) => result.cached === true), true);
  assert.equal(validationCalls.length, 3);

  const committed = await requestJson(base, '/api/admin/provider-config', {
    method: 'PUT', headers: writeHeaders(cookie),
    body: JSON.stringify({
      schemaVersion: 1,
      expectedRevision: current.body.revision,
      validationId: fullyValidated.body.validationId,
      adminPassword: ADMIN_PASSWORD,
    }),
  });
  assert.equal(committed.response.status, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.providers.length, 2);
  assert.equal(committed.body.providers[1].providerId, 'deepseek');
  assert.equal(committed.body.providers[1].models[0].actualModel, 'deepseek-chat');
  assert.equal(validationCalls.length, 3);
});
