import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConversationStore } from '../src/conversation-store.mjs';
import { RuntimeConfigRegistry } from '../src/runtime-config-registry.mjs';
import { createApp } from '../src/server.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { temporaryProject } from './helpers.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_PASSWORD = 'v2 fixture administrator password';
const LLM_KEY = ['runtime', 'llm', 'fixture', 'credential'].join('-');
const BAILIAN_KEY = ['runtime', 'bailian', 'fixture', 'credential'].join('-');
const TAVILY_KEY = ['runtime', 'tavily', 'fixture', 'credential'].join('-');

const LEGACY_MODELS = [{
  id: 'qwen', label: 'Main model', actualModel: 'provider-model-v1',
  provider: 'anthropic', efforts: ['default'], defaultEffort: 'default', available: true,
}, {
  id: 'kimi', label: 'Reviewer model', actualModel: 'provider-reviewer-v1',
  provider: 'anthropic', efforts: ['default'], defaultEffort: 'default', available: true,
}, {
  id: 'deepseek', label: 'Third model', actualModel: 'provider-third-v1',
  provider: 'anthropic', efforts: ['default'], defaultEffort: 'default', available: true,
}];

async function writePrivateJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fsp.chmod(filename, 0o600);
}

function baseConfig(project) {
  return {
    ...project.config,
    projectRoot,
    publicDir: path.join(projectRoot, 'public'),
    appName: 'Runtime v2 integration fixture',
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
    modelCatalog: LEGACY_MODELS,
    llm: {
      provider: 'anthropic', protocol: 'anthropic-messages',
      apiBase: 'https://models.example.com/anthropic', apiKey: LLM_KEY,
      authMode: 'x-api-key', model: 'provider-model-v1', timeoutMs: 1_000,
      maxOutputTokens: 256, temperature: 0, allowInsecureHttp: false,
    },
    embedding: {
      provider: 'disabled', apiBase: '', apiKey: '', model: '', dimensions: 1_024,
      batchSize: 2, timeoutMs: 1_000, allowInsecureHttp: false,
    },
    webSearch: {
      provider: 'bailian-mcp', enabled: false, apiKey: BAILIAN_KEY, timeoutMs: 1_000,
      resultCount: 15, deepResultCount: 6, maxResultsPerDomain: 2,
      modelSourceLimit: 10, maxContextChars: 30_000,
    },
    responsesFallback: { enabled: true, timeoutMs: 1_000 },
    webReader: { enabled: false, pdfEnabled: false },
    research: { contextualizerEnabled: false, loopEnabled: false },
    retrieval: { topK: 8, maxContextChars: 10_000, watch: false, reconcileIntervalMs: 60_000 },
    deep: { enabled: true, topK: 12 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
}

function stubIndex() {
  return {
    ready: Promise.resolve(),
    status: () => ({
      available: true, files: 0, chunks: 0, semanticAvailable: false,
      embedding: { provider: 'disabled', model: null, dimensions: null },
    }),
    search: async () => ({ route: 'keyword', results: [], diagnostics: {} }),
    close: async () => {},
  };
}

function stubStore() {
  return {
    ready: Promise.resolve(), cleanupDrafts: async () => {}, auditBestEffort: async () => [],
  };
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  return { response, body: await response.json() };
}

function editableModels(snapshot) {
  return snapshot.models.map((model) => ({
    id: model.id,
    displayName: model.label,
    shortLabel: model.shortLabel,
    connectionId: model.connectionId,
    actualModel: model.actualModel,
    requestProfile: model.requestProfile,
    efforts: model.efforts,
    defaultEffort: model.defaultEffort,
    enabled: model.enabled,
    description: model.description,
  }));
}

test('v2 administrator save validates all models and the selected search/extract provider transactionally', async (t) => {
  const project = await temporaryProject('vaultmind-runtime-v2-admin-');
  const settingsFile = path.join(project.dataDir, 'settings.json');
  const managedFile = path.join(project.dataDir, 'runtime-config.json');
  await writePrivateJson(settingsFile, {
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'provider-model-v1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'provider-reviewer-v1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'provider-third-v1',
    },
  });
  const config = baseConfig(project);
  const registry = new RuntimeConfigRegistry({
    settingsFile,
    managedFile,
    modelCatalog: LEGACY_MODELS,
    llm: config.llm,
    embedding: config.embedding,
    webSearch: config.webSearch,
  });
  await registry.ready;
  await registry.bootstrapManagedV2({ tavilyApiKey: TAVILY_KEY });

  const validation = { llm: [], searches: [], extracts: [], failLlm: false };
  const llmRouter = {
    async validateAllEnabled(snapshot, options) {
      validation.llm.push({
        ids: snapshot.models.filter((model) => model.enabled !== false).map((model) => model.id),
        concurrency: options.concurrency,
      });
      if (validation.failLlm) {
        const error = new Error('fixture model validation failed');
        error.code = 'LLM_VALIDATION_FAILED';
        error.status = 400;
        throw error;
      }
      return { ok: true };
    },
    async acquireForTask() {
      throw new Error('No task model call is expected in this API test.');
    },
  };
  const webSearch = {
    publicStatus: () => ({ enabled: false, configured: false, provider: 'bailian-mcp' }),
    async acquireForTask({ runtimeSnapshot }) {
      const provider = runtimeSnapshot.webSearch.provider;
      const key = runtimeSnapshot.webSearch.apiKey;
      validation.searches.push({ provider, keyMatchesTavily: key === TAVILY_KEY });
      return {
        publicStatus: () => ({ enabled: true, configured: true, provider }),
        searchMany: async (queries, options) => ({
          results: [{ title: 'Fixture result', url: 'https://www.example.com/', snippet: 'Fixture' }],
          attempts: [{ status: 'completed', resultCount: 1 }], errors: [], queries, options,
        }),
        close: async () => {},
      };
    },
  };
  const responsesExtractor = {
    publicStatus: () => ({ enabled: false, configured: false, provider: 'fixture-extract' }),
    async acquireForTask({ runtimeSnapshot }) {
      validation.extracts.push({
        provider: runtimeSnapshot.webSearch.provider,
        keyMatchesTavily: runtimeSnapshot.webSearch.apiKey === TAVILY_KEY,
      });
      return {
        publicStatus: () => ({ enabled: true, configured: true, provider: 'tavily-extract-rest' }),
        extract: async () => ({ attempts: [{ status: 'completed' }], errors: [], documents: [] }),
        close: async () => {},
      };
    },
  };
  const conversations = new ConversationStore(project.config.conversationFile);
  let app;
  t.after(async () => {
    if (app) {
      await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await project.cleanup();
  });
  app = await createApp(config, {
    runtimeConfig: registry,
    embeddingRuntime: { startRebuild: async () => { throw new Error('not expected'); } },
    index: stubIndex(), store: stubStore(), conversations,
    llm: { generate: async () => 'unused' }, llmRouter, webSearch, responsesExtractor,
    webReader: { publicStatus: () => ({ enabled: false, pdfAvailable: false }) },
  });
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
  const cookie = login.response.headers.get('set-cookie');
  const readHeaders = { cookie };
  const writeHeaders = { cookie, 'content-type': 'application/json', 'x-vaultmind-request': '1' };
  const initial = await requestJson(base, '/api/admin/runtime-config', { headers: readHeaders });
  assert.equal(initial.body.schemaVersion, 2);
  assert.equal(initial.body.connections[0].apiBase, 'https://models.example.com/anthropic');
  assert.equal(initial.body.connections[0].apiKeyConfigured, true);
  assert.equal(JSON.stringify(initial.body).includes(LLM_KEY), false);
  assert.equal(JSON.stringify(initial.body).includes(BAILIAN_KEY), false);
  assert.equal(JSON.stringify(initial.body).includes(TAVILY_KEY), false);

  const ordinary = await requestJson(base, '/api/knowledge/status', { headers: readHeaders });
  assert.equal(JSON.stringify(ordinary.body).includes('models.example.com'), false,
    'model destinations belong only to the administrator response');
  assert.equal(JSON.stringify(ordinary.body).includes(LLM_KEY), false);

  const saved = await requestJson(base, '/api/admin/runtime-config', {
    method: 'PUT', headers: writeHeaders,
    body: JSON.stringify({
      schemaVersion: 2,
      expectedRevision: initial.body.revision,
      adminPassword: ADMIN_PASSWORD,
      webSearch: {
        enabled: true,
        provider: 'tavily-rest',
        providers: {
          'bailian-mcp': { apiKeyAction: 'keep', extractFallbackEnabled: false },
          'tavily-rest': { apiKeyAction: 'keep', extractFallbackEnabled: true },
        },
      },
    }),
  });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(validation.llm, [{ ids: ['qwen', 'kimi', 'deepseek'], concurrency: 2 }]);
  assert.deepEqual(validation.searches, [{ provider: 'tavily-rest', keyMatchesTavily: true }]);
  assert.deepEqual(validation.extracts, [{ provider: 'tavily-rest', keyMatchesTavily: true }]);
  assert.equal(saved.body.webSearch.provider, 'tavily-rest');
  assert.equal(saved.body.webSearch.extractFallbackEnabled, true);

  const beforeFailure = await fsp.readFile(managedFile, 'utf8');
  const successfulRevision = saved.body.revision;
  validation.failLlm = true;
  const failed = await requestJson(base, '/api/admin/runtime-config', {
    method: 'PUT', headers: writeHeaders,
    body: JSON.stringify({
      schemaVersion: 2,
      expectedRevision: successfulRevision,
      adminPassword: ADMIN_PASSWORD,
      models: editableModels(saved.body).map((model) => (
        model.id === 'qwen' ? { ...model, displayName: 'Uncommitted label' } : model
      )),
    }),
  });
  assert.equal(failed.response.status, 400);
  assert.equal(failed.body.error, 'LLM_VALIDATION_FAILED');
  assert.equal(await fsp.readFile(managedFile, 'utf8'), beforeFailure,
    'failed connectivity validation must not alter the managed file');
  const afterFailure = await requestJson(base, '/api/admin/runtime-config', { headers: readHeaders });
  assert.equal(afterFailure.body.revision, successfulRevision);
  assert.notEqual(afterFailure.body.models[0].label, 'Uncommitted label');
});

function runtimeSnapshot({
  actualModel = 'provider-model-v1',
  catalogRevision = 'a'.repeat(64),
  configRevision = 'runtime-v1',
  webProvider = 'bailian-mcp',
  webBinding = 'web-binding-a',
  webKey = 'web-key-a',
} = {}) {
  return {
    version: 2,
    revision: configRevision,
    modelCatalogRevision: catalogRevision,
    defaultModelId: 'main',
    stale: false,
    connections: [{
      id: 'primary', label: 'Primary', protocol: 'openai-chat-completions',
      apiBase: 'https://models.example.com/v1', authMode: 'bearer', apiKey: 'model-key',
    }],
    models: [{
      id: 'main', label: 'Main', shortLabel: 'Main', connectionId: 'primary',
      provider: 'primary', actualModel, requestProfile: 'openai-standard',
      efforts: ['default'], defaultEffort: 'default', enabled: true, available: true,
      capabilityVerified: true, bindingRevision: `binding-${actualModel}`,
    }],
    embedding: { provider: 'disabled', apiBase: '', apiKey: '', model: '', dimensions: 1_024 },
    webSearch: {
      enabled: true, provider: webProvider, apiKey: webKey, bindingRevision: webBinding,
      extractFallbackEnabled: false,
      providerConfigs: { [webProvider]: { apiKey: webKey, extractFallbackEnabled: false } },
    },
  };
}

class MutableRuntimeRegistry {
  constructor(snapshot) { this.current = structuredClone(snapshot); }
  set(snapshot) { this.current = structuredClone(snapshot); }
  publicSnapshot() { return structuredClone(this.current); }
  runtimeSnapshot() { return structuredClone(this.current); }
  async refresh() { return this.publicSnapshot(); }
}

async function taskManagerFixture(t, snapshot, options = {}) {
  const project = await temporaryProject('vaultmind-runtime-v2-task-');
  const registry = new MutableRuntimeRegistry(snapshot);
  const conversations = new ConversationStore(project.config.conversationFile);
  const modelAcquisitions = [];
  const webAcquisitions = [];
  const llmRouter = {
    async acquireForTask({ modelId, expectedCatalogRevision, snapshot: acquired }) {
      const model = acquired.models.find((entry) => entry.id === modelId);
      const pinned = { actualModel: model.actualModel, bindingRevision: model.bindingRevision };
      modelAcquisitions.push({ expectedCatalogRevision, ...pinned });
      return {
        ...pinned,
        model: {
          ...model,
          effortMapping: model.effortMapping || {
            low: 'default', medium: 'default', high: 'default',
            xhigh: 'default', max: 'default',
          },
        },
        generate: async () => {
          if (options.beforeGenerate) await options.beforeGenerate(pinned.actualModel);
          return `Answer from ${pinned.actualModel}.`;
        },
      };
    },
  };
  const webSearch = {
    publicStatus() {
      const state = registry.runtimeSnapshot().webSearch;
      return {
        enabled: state.enabled, configured: Boolean(state.apiKey),
        provider: state.provider, bindingRevision: state.bindingRevision,
      };
    },
    async acquireForTask({ runtimeSnapshot: acquired }) {
      const pinned = {
        provider: acquired.webSearch.provider,
        bindingRevision: acquired.webSearch.bindingRevision,
        key: acquired.webSearch.apiKey,
      };
      webAcquisitions.push(pinned);
      return {
        provider: pinned.provider,
        publicStatus: () => ({ enabled: true, configured: true, provider: pinned.provider }),
        searchMany: async (queries) => ({
          results: [], candidates: [], attempts: queries.map(() => ({ status: 'completed', resultCount: 0 })),
          errors: [], queryCount: queries.length,
        }),
        close: async () => {},
      };
    },
  };
  const config = {
    ...baseConfig(project),
    modelCatalog: snapshot.models,
    research: { contextualizerEnabled: false, loopEnabled: false },
  };
  const manager = new TaskManager(config, {
    allowLegacyTestEngine: true,
    runtimeConfig: registry, conversations, index: stubIndex(), store: stubStore(),
    llm: { generate: async () => 'legacy client must not be used' }, llmRouter, webSearch,
    responsesExtractor: {
      publicStatus: () => ({ enabled: false, configured: false }),
      acquireForTask: async () => ({
        publicStatus: () => ({ enabled: false, configured: false }),
        extract: async () => ({ attempts: [], errors: [] }), close: async () => {},
      }),
    },
  });
  await manager.ready;
  t.after(async () => {
    await manager.close();
    await project.cleanup();
  });
  return { manager, registry, conversations, modelAcquisitions, webAcquisitions };
}

test('TaskManager pins each running model lease while new tasks use the refreshed snapshot', async (t) => {
  let releaseFirst;
  const firstBarrier = new Promise((resolve) => { releaseFirst = resolve; });
  const first = runtimeSnapshot();
  const value = await taskManagerFixture(t, first, {
    beforeGenerate: async (actualModel) => {
      if (actualModel === 'provider-model-v1') await firstBarrier;
    },
  });
  const createdOne = await value.manager.createTask('user-a', {
    kind: 'qa', prompt: 'First isolated fixture question.', model: 'main', webSearch: false,
    modelCatalogRevision: first.modelCatalogRevision,
  });
  const second = runtimeSnapshot({
    actualModel: 'provider-model-v2', catalogRevision: 'b'.repeat(64), configRevision: 'runtime-v2',
  });
  value.registry.set(second);
  const createdTwo = await value.manager.createTask('user-b', {
    kind: 'qa', prompt: 'Second isolated fixture question.', model: 'main', webSearch: false,
    modelCatalogRevision: second.modelCatalogRevision,
  });
  releaseFirst();
  await Promise.all([
    value.manager.getTask('user-a', createdOne.taskId).runPromise,
    value.manager.getTask('user-b', createdTwo.taskId).runPromise,
  ]);

  assert.deepEqual(value.modelAcquisitions, [{
    expectedCatalogRevision: first.modelCatalogRevision,
    actualModel: 'provider-model-v1', bindingRevision: 'binding-provider-model-v1',
  }, {
    expectedCatalogRevision: second.modelCatalogRevision,
    actualModel: 'provider-model-v2', bindingRevision: 'binding-provider-model-v2',
  }]);
  assert.match(value.conversations.get('user-a', createdOne.conversationId).messages.at(-1).content,
    /provider-model-v1/u);
  assert.match(value.conversations.get('user-b', createdTwo.conversationId).messages.at(-1).content,
    /provider-model-v2/u);
});

test('Web provider/binding changes require a fork while credential-only rotation continues in place', async (t) => {
  const initial = runtimeSnapshot();
  const value = await taskManagerFixture(t, initial);
  const first = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'First web-enabled fixture question.', model: 'main', webSearch: true,
  });
  await value.manager.getTask('admin', first.taskId).runPromise;

  value.registry.set(runtimeSnapshot({
    configRevision: 'runtime-key-rotation', webKey: 'web-key-rotated',
  }));
  const continued = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Continue after credential rotation.', model: 'main', webSearch: true,
    conversationId: first.conversationId,
  });
  await value.manager.getTask('admin', continued.taskId).runPromise;
  assert.equal(continued.conversationId, first.conversationId);

  value.registry.set(runtimeSnapshot({
    configRevision: 'runtime-provider-change', webProvider: 'tavily-rest',
    webBinding: 'web-binding-b', webKey: 'tavily-key',
  }));
  await assert.rejects(
    () => value.manager.createTask('admin', {
      kind: 'qa', prompt: 'Unsafe in-place provider change.', model: 'main', webSearch: true,
      conversationId: first.conversationId,
    }),
    { code: 'CONVERSATION_SETTINGS_CHANGED', status: 409 },
  );
  const forked = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Fork after provider change.', model: 'main', webSearch: true,
    forkFromConversationId: first.conversationId,
  });
  await value.manager.getTask('admin', forked.taskId).runPromise;
  assert.notEqual(forked.conversationId, first.conversationId);
  assert.equal(forked.forkedFromConversationId, first.conversationId);
  assert.deepEqual(value.webAcquisitions.map(({ provider, key }) => ({ provider, key })), [
    { provider: 'bailian-mcp', key: 'web-key-a' },
    { provider: 'bailian-mcp', key: 'web-key-rotated' },
    { provider: 'tavily-rest', key: 'tavily-key' },
  ]);
});
