import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RuntimeConfigRegistry,
  runtimeConfigInternals,
} from '../src/runtime-config-registry.mjs';

const EMBEDDING_SECRET = ['embedding', 'fixture', 'credential', '123456'].join('-');
const WEB_SECRET = ['web', 'fixture', 'credential', '123456'].join('-');
const LLM_SECRET = ['llm', 'fixture', 'credential', '123456'].join('-');
const TAVILY_SECRET = ['tavily', 'fixture', 'credential', '123456'].join('-');

const MODEL_CATALOG = [{
  id: 'qwen',
  label: 'Qwen default',
  shortLabel: 'Qwen',
  actualModel: 'qwen-default',
  efforts: ['low', 'medium', 'xhigh'],
  defaultEffort: 'xhigh',
  available: true,
  capabilityVerified: true,
}, {
  id: 'kimi',
  label: 'Kimi default',
  shortLabel: 'Kimi',
  actualModel: 'kimi-default',
  efforts: ['medium', 'high', 'max'],
  defaultEffort: 'medium',
  available: true,
  capabilityVerified: true,
}, {
  id: 'deepseek',
  label: 'DeepSeek default',
  shortLabel: 'DeepSeek',
  actualModel: 'deepseek-default',
  efforts: ['high', 'max'],
  defaultEffort: 'high',
  available: true,
  capabilityVerified: true,
}];

function claudeSettings(suffix = 'v1') {
  return {
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: `qwen-runtime-${suffix}[1M]`,
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: `Qwen runtime ${suffix}`,
      ANTHROPIC_DEFAULT_SONNET_MODEL: `kimi-runtime-${suffix}[1M]`,
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: `Kimi runtime ${suffix}`,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: `deepseek-runtime-${suffix}`,
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: `DeepSeek runtime ${suffix}`,
      UNRELATED_SECRET: 'must-not-enter-the-registry',
    },
    permissions: { allow: ['fixture'] },
  };
}

async function privateJson(filename, value) {
  await fsp.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(filename, 0o600);
}

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-config-registry-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const settingsFile = path.join(root, 'settings.json');
  const managedFile = path.join(root, 'managed.json');
  if (options.settings !== null) await privateJson(settingsFile, options.settings || claudeSettings());
  if (options.settingsMode !== undefined) await fsp.chmod(settingsFile, options.settingsMode);
  if (options.managed) await privateJson(managedFile, options.managed);
  const registry = new RuntimeConfigRegistry({
    settingsFile,
    managedFile,
    modelCatalog: MODEL_CATALOG,
    llm: {
      provider: 'anthropic',
      protocol: 'anthropic-messages',
      apiBase: 'https://models.example.com/anthropic',
      apiKey: LLM_SECRET,
      authMode: 'x-api-key',
    },
    embedding: {
      provider: 'dashscope',
      apiBase: 'https://dashscope.aliyuncs.com',
      apiKey: ['inherited', 'embedding', 'credential'].join('-'),
      model: 'embedding-default',
      dimensions: 1_024,
    },
    webSearch: {
      enabled: false,
      apiKey: ['inherited', 'web', 'credential'].join('-'),
    },
  });
  return { root, settingsFile, managedFile, registry };
}

function editableConnections(snapshot) {
  return snapshot.connections.map((connection) => ({
    id: connection.id,
    label: connection.label,
    providerId: connection.providerId,
    protocol: connection.protocol,
    apiBase: connection.apiBase,
    authMode: connection.authMode,
    apiKeyAction: 'keep',
  }));
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

test('one-time v2 bootstrap imports current values and then stops following settings.json', async (t) => {
  const value = await fixture(t);
  const legacy = await value.registry.ready;
  const upgraded = await value.registry.bootstrapManagedV2({ tavilyApiKey: TAVILY_SECRET });

  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.source, 'managed');
  assert.equal(upgraded.defaultModelId, 'qwen');
  assert.equal(upgraded.models[0].actualModel, legacy.models[0].actualModel);
  assert.equal(upgraded.connections.length, 1);
  assert.equal(upgraded.connections[0].apiKeyConfigured, true);
  assert.equal(upgraded.webSearch.providers.find((entry) => entry.id === 'tavily-rest').apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(upgraded), new RegExp(`${LLM_SECRET}|${TAVILY_SECRET}`, 'u'));

  const privateSnapshot = value.registry.runtimeSnapshot();
  assert.equal(privateSnapshot.connections[0].apiKey, LLM_SECRET);
  assert.equal(privateSnapshot.webSearch.providerConfigs['tavily-rest'].apiKey, TAVILY_SECRET);
  await privateJson(value.settingsFile, claudeSettings('ignored-after-upgrade'));
  const refreshed = await value.registry.refresh();
  assert.equal(refreshed.models[0].actualModel, legacy.models[0].actualModel);
});

test('v2 supports dynamic providers and model IDs while keeping credentials out of binding revisions', async (t) => {
  const value = await fixture(t);
  await value.registry.ready;
  const initial = await value.registry.bootstrapManagedV2();
  const connections = editableConnections(initial);
  connections.push({
    id: 'glm-official',
    label: 'GLM Official',
    protocol: 'openai-chat-completions',
    apiBase: 'https://open.bigmodel.cn/api/paas/v4',
    authMode: 'bearer',
    apiKeyAction: 'replace',
    apiKey: ['glm', 'fixture', 'credential', '123456'].join('-'),
  });
  const models = editableModels(initial);
  models[2].enabled = false;
  models.push({
    id: 'glm-main',
    displayName: 'GLM Main',
    shortLabel: 'GLM',
    connectionId: 'glm-official',
    actualModel: 'glm-5',
    requestProfile: 'glm-openai',
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    enabled: true,
    description: 'Fixture model',
  });
  const added = await value.registry.update({
    schemaVersion: 2,
    expectedRevision: initial.revision,
    connections,
    models,
    defaultModelId: 'glm-main',
  });
  const addedModel = added.models.find((model) => model.id === 'glm-main');
  assert.equal(added.defaultModelId, 'glm-main');
  assert.equal(addedModel.actualModel, 'glm-5');
  assert.equal(value.registry.runtimeSnapshot().connections
    .find((connection) => connection.id === 'glm-official').providerId, 'glm');
  const oldBinding = addedModel.bindingRevision;
  const oldCatalog = added.modelCatalogRevision;

  const rotatedConnections = editableConnections(added).map((connection) => (
    connection.id === 'glm-official'
      ? { ...connection, apiKeyAction: 'replace', apiKey: ['new', 'glm', 'credential', '123456'].join('-') }
      : connection
  ));
  const rotated = await value.registry.update({
    schemaVersion: 2,
    expectedRevision: added.revision,
    connections: rotatedConnections,
  });
  assert.equal(rotated.modelCatalogRevision, oldCatalog);
  assert.equal(rotated.models.find((model) => model.id === 'glm-main').bindingRevision, oldBinding);
});

test('v2 core enforces at most three enabled models for both management APIs', async (t) => {
  const value = await fixture(t);
  await value.registry.ready;
  const initial = await value.registry.bootstrapManagedV2();
  const models = editableModels(initial);
  models.push({
    id: 'fourth-model',
    displayName: 'Fourth model',
    shortLabel: 'Fourth model',
    connectionId: initial.connections[0].id,
    actualModel: 'fourth-provider-model',
    requestProfile: models[0].requestProfile,
    efforts: ['default'],
    defaultEffort: 'default',
    enabled: true,
    description: '',
  });
  await assert.rejects(
    () => value.registry.update({
      schemaVersion: 2,
      expectedRevision: initial.revision,
      models,
    }),
    { code: 'TOO_MANY_ENABLED_MODELS', status: 400 },
  );
});

test('v2 persists an explicitly selected provider adapter for compatible proxy hosts', async (t) => {
  const value = await fixture(t);
  await value.registry.ready;
  const initial = await value.registry.bootstrapManagedV2();
  const connections = editableConnections(initial);
  connections[0] = {
    ...connections[0],
    providerId: 'deepseek',
    protocol: 'openai-chat-completions',
    apiBase: 'https://deepseek-proxy.example.com/v1',
    authMode: 'bearer',
    apiKeyAction: 'replace',
    apiKey: ['proxy', 'fixture', 'credential', '123456'].join('-'),
  };
  const models = editableModels(initial).map((entry) => ({
    ...entry,
    requestProfile: 'deepseek-openai',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  }));
  await value.registry.update({
    schemaVersion: 2,
    expectedRevision: initial.revision,
    connections,
    models,
  });
  await value.registry.refresh();
  assert.equal(value.registry.runtimeSnapshot().connections[0].providerId, 'deepseek');
});

test('v2 requires credential replacement on destination changes and preserves both search keys', async (t) => {
  const value = await fixture(t);
  await value.registry.ready;
  const initial = await value.registry.bootstrapManagedV2({ tavilyApiKey: TAVILY_SECRET });
  const unsafeConnections = editableConnections(initial).map((connection) => ({
    ...connection,
    apiBase: 'https://other-models.example.com/v1',
  }));
  await assert.rejects(
    () => value.registry.update({
      schemaVersion: 2,
      expectedRevision: initial.revision,
      connections: unsafeConnections,
    }),
    { code: 'MODEL_CREDENTIAL_REPLACEMENT_REQUIRED', status: 400 },
  );

  const selectedTavily = await value.registry.update({
    schemaVersion: 2,
    expectedRevision: initial.revision,
    webSearch: {
      enabled: true,
      provider: 'tavily-rest',
      providers: {
        'bailian-mcp': { apiKeyAction: 'keep', extractFallbackEnabled: true },
        'tavily-rest': { apiKeyAction: 'keep', extractFallbackEnabled: false },
      },
    },
  });
  const runtime = value.registry.runtimeSnapshot();
  assert.equal(runtime.webSearch.provider, 'tavily-rest');
  assert.equal(runtime.webSearch.apiKey, TAVILY_SECRET);
  assert.equal(runtime.webSearch.providerConfigs['bailian-mcp'].apiKey, 'inherited-web-credential');
  assert.equal(runtime.webSearch.providerConfigs['tavily-rest'].apiKey, TAVILY_SECRET);
  assert.equal(selectedTavily.webSearch.provider, 'tavily-rest');
  assert.equal(selectedTavily.webSearch.extractFallbackEnabled, false);
});

test('v2 candidate validation runs before commit and a failure keeps the last-known-good file', async (t) => {
  const value = await fixture(t);
  await value.registry.ready;
  const initial = await value.registry.bootstrapManagedV2();
  const before = await fsp.readFile(value.managedFile, 'utf8');
  let observedCandidate = null;
  await assert.rejects(
    () => value.registry.update({
      schemaVersion: 2,
      expectedRevision: initial.revision,
      models: editableModels(initial).map((model, index) => (
        index === 0 ? { ...model, displayName: 'Rejected candidate' } : model
      )),
    }, {
      beforeCommit: async (candidate) => {
        observedCandidate = candidate;
        const error = new Error('fixture validation failed');
        error.code = 'MODEL_VALIDATION_FAILED';
        throw error;
      },
    }),
    { code: 'MODEL_VALIDATION_FAILED' },
  );
  assert.equal(observedCandidate.models[0].label, 'Rejected candidate');
  assert.equal(await fsp.readFile(value.managedFile, 'utf8'), before);
  assert.equal(value.registry.publicSnapshot().revision, initial.revision);
});

test('safely imports only the three fixed Claude model fields and hot-refreshes real IDs', async (t) => {
  const value = await fixture(t);
  const first = await value.registry.ready;

  assert.deepEqual(first.models.map(({ id, actualModel, label }) => ({ id, actualModel, label })), [{
    id: 'qwen', actualModel: 'qwen-runtime-v1[1M]', label: 'Qwen runtime v1',
  }, {
    id: 'kimi', actualModel: 'kimi-runtime-v1[1M]', label: 'Kimi runtime v1',
  }, {
    id: 'deepseek', actualModel: 'deepseek-runtime-v1', label: 'DeepSeek runtime v1',
  }]);
  assert.equal(first.stale, false);
  assert.doesNotMatch(JSON.stringify(first), /must-not-enter-the-registry/u);

  await privateJson(value.settingsFile, claudeSettings('v2'));
  const second = await value.registry.refresh();
  assert.equal(second.models[0].actualModel, 'qwen-runtime-v2[1M]');
  assert.notEqual(second.modelCatalogRevision, first.modelCatalogRevision);
  assert.notEqual(second.revision, first.revision);
});

test('managed overrides are atomic, revision guarded, and public snapshots never echo secrets', async (t) => {
  const value = await fixture(t);
  const initial = await value.registry.ready;
  const updated = await value.registry.update({
    expectedRevision: initial.revision,
    models: {
      qwen: { actualModel: 'qwen-managed-v2', displayName: 'Qwen managed' },
    },
    embedding: {
      provider: 'openai-compatible',
      apiBase: 'https://embeddings.example.com/v1/',
      model: 'embedding-managed',
      dimensions: 1_536,
      apiKeyAction: 'replace',
      apiKey: EMBEDDING_SECRET,
    },
    webSearch: {
      enabled: true,
      apiKeyAction: 'replace',
      apiKey: WEB_SECRET,
    },
  });

  assert.equal(updated.models[0].actualModel, 'qwen-managed-v2');
  assert.equal(updated.embedding.apiBase, 'https://embeddings.example.com/v1');
  assert.equal(updated.embedding.apiKeyConfigured, true);
  assert.equal(updated.webSearch.configured, true);
  assert.doesNotMatch(JSON.stringify(updated), new RegExp(`${EMBEDDING_SECRET}|${WEB_SECRET}`, 'u'));
  assert.equal((await fsp.stat(value.managedFile)).mode & 0o777, 0o600);

  const runtime = value.registry.runtimeSnapshot();
  assert.equal(runtime.embedding.apiKey, EMBEDDING_SECRET);
  assert.equal(runtime.webSearch.apiKey, WEB_SECRET);
  assert.equal(runtime.webSearch.endpoint, runtimeConfigInternals.BAILIAN_WEB_SEARCH_ENDPOINT);
  const stored = JSON.parse(await fsp.readFile(value.managedFile, 'utf8'));
  assert.equal(stored.embedding.apiKey, EMBEDDING_SECRET);
  assert.equal(stored.webSearch.apiKey, WEB_SECRET);

  await assert.rejects(
    () => value.registry.update({
      expectedRevision: initial.revision,
      webSearch: { enabled: false },
    }),
    { code: 'RUNTIME_CONFIG_REVISION_CONFLICT', status: 409 },
  );
});

test('credential-only updates preserve modelCatalogRevision and support explicit keep and clear', async (t) => {
  const value = await fixture(t);
  const initial = await value.registry.ready;
  const replaced = await value.registry.update({
    expectedRevision: initial.revision,
    webSearch: { enabled: true, apiKeyAction: 'replace', apiKey: WEB_SECRET },
  });
  assert.equal(replaced.modelCatalogRevision, initial.modelCatalogRevision);

  const kept = await value.registry.update({
    expectedRevision: replaced.revision,
    webSearch: { enabled: false, apiKeyAction: 'keep' },
  });
  assert.equal(value.registry.runtimeSnapshot().webSearch.apiKey, WEB_SECRET);
  assert.equal(kept.apiKey, undefined);

  const cleared = await value.registry.update({
    expectedRevision: kept.revision,
    webSearch: { enabled: false, apiKeyAction: 'clear' },
    embedding: { apiKeyAction: 'clear' },
  });
  assert.equal(cleared.webSearch.apiKeyConfigured, false);
  assert.equal(cleared.embedding.apiKeyConfigured, false);
  assert.equal(value.registry.runtimeSnapshot().webSearch.apiKey, '');
  assert.equal(value.registry.runtimeSnapshot().embedding.apiKey, '');
});

test('credential values require an explicit action and managed parents cannot be broadly writable', async (t) => {
  const value = await fixture(t);
  const initial = await value.registry.ready;
  await assert.rejects(
    () => value.registry.update({
      expectedRevision: initial.revision,
      webSearch: { apiKey: WEB_SECRET },
    }),
    { code: 'INVALID_RUNTIME_CONFIG_UPDATE', status: 400 },
  );

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-config-open-parent-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.chmod(root, 0o777);
  await assert.rejects(
    () => runtimeConfigInternals.atomicPrivateJson(path.join(root, 'managed.json'), {}),
    { code: 'UNSAFE_RUNTIME_CONFIG_PATH' },
  );
});

test('an Embedding credential can never be silently reused across provider destinations', async (t) => {
  const value = await fixture(t);
  const initial = await value.registry.ready;
  await assert.rejects(
    () => value.registry.update({
      expectedRevision: initial.revision,
      embedding: {
        provider: 'openai-compatible',
        apiBase: 'https://first-embedding.example/v1',
        model: 'embedding-private',
        dimensions: 1_024,
        apiKeyAction: 'keep',
      },
    }),
    { code: 'EMBEDDING_CREDENTIAL_REPLACEMENT_REQUIRED', status: 400 },
  );
  assert.equal(await fsp.stat(value.managedFile).then(() => true, () => false), false);

  const replaced = await value.registry.update({
    expectedRevision: initial.revision,
    embedding: {
      provider: 'openai-compatible',
      apiBase: 'https://first-embedding.example/v1',
      model: 'embedding-private',
      dimensions: 1_024,
      apiKeyAction: 'replace',
      apiKey: EMBEDDING_SECRET,
    },
  });
  await assert.rejects(
    () => value.registry.update({
      expectedRevision: replaced.revision,
      embedding: {
        provider: 'openai-compatible',
        apiBase: 'https://second-embedding.example/v1',
        model: 'embedding-private',
        dimensions: 1_024,
        apiKeyAction: 'keep',
      },
    }),
    { code: 'EMBEDDING_CREDENTIAL_REPLACEMENT_REQUIRED', status: 400 },
  );
  assert.equal(value.registry.runtimeSnapshot().embedding.apiBase, 'https://first-embedding.example/v1');

  const unsafeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-config-key-binding-'));
  t.after(() => fsp.rm(unsafeRoot, { recursive: true, force: true }));
  const unsafeSettings = path.join(unsafeRoot, 'settings.json');
  const unsafeManaged = path.join(unsafeRoot, 'managed.json');
  await privateJson(unsafeSettings, claudeSettings());
  await privateJson(unsafeManaged, {
    version: 1,
    revision: 'unsafe-binding-v1',
    updatedAt: new Date().toISOString(),
    models: {},
    embedding: {
      provider: 'openai-compatible',
      apiBase: 'https://unbound-embedding.example/v1',
      model: 'embedding-private',
      dimensions: 1_024,
    },
    webSearch: {},
  });
  const unsafeRegistry = new RuntimeConfigRegistry({
    settingsFile: unsafeSettings,
    managedFile: unsafeManaged,
    modelCatalog: MODEL_CATALOG,
    embedding: {
      provider: 'dashscope',
      apiBase: 'https://dashscope.aliyuncs.com',
      apiKey: EMBEDDING_SECRET,
      model: 'embedding-default',
      dimensions: 1_024,
    },
  });
  await assert.rejects(
    unsafeRegistry.ready,
    { code: 'EMBEDDING_CREDENTIAL_REPLACEMENT_REQUIRED' },
  );
});

test('a directory sync error after rename cannot turn a visible pointer commit into failure', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-config-commit-point-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.chmod(root, 0o700);
  const filename = path.join(root, 'pointer.json');
  await runtimeConfigInternals.atomicPrivateJson(filename, { generation: 'old' });

  await runtimeConfigInternals.atomicPrivateJson(
    filename,
    { generation: 'new' },
    { syncDirectory: async () => { throw new Error('injected post-rename failure'); } },
  );
  assert.deepEqual(JSON.parse(await fsp.readFile(filename, 'utf8')), { generation: 'new' });
  assert.equal((await fsp.stat(filename)).mode & 0o777, 0o600);
});

test('model overrides can return to settings inheritance without freezing unrelated settings', async (t) => {
  const value = await fixture(t);
  const initial = await value.registry.ready;
  const managed = await value.registry.update({
    expectedRevision: initial.revision,
    models: { qwen: { actualModel: 'qwen-managed', displayName: 'Managed Qwen' } },
  });
  assert.equal(managed.models[0].actualModel, 'qwen-managed');

  await privateJson(value.settingsFile, claudeSettings('later'));
  const stillManaged = await value.registry.refresh();
  assert.equal(stillManaged.models[0].actualModel, 'qwen-managed');
  assert.equal(stillManaged.models[1].actualModel, 'kimi-runtime-later[1M]');

  const inherited = await value.registry.update({
    expectedRevision: stillManaged.revision,
    models: { qwen: { inherit: true } },
  });
  assert.equal(inherited.models[0].actualModel, 'qwen-runtime-later[1M]');
});

test('last-known-good remains active and is marked stale for malformed or unsafe source files', async (t) => {
  const value = await fixture(t);
  const initial = await value.registry.ready;

  await fsp.writeFile(value.settingsFile, '{not-json', { mode: 0o600 });
  const malformed = await value.registry.refresh();
  assert.equal(malformed.stale, true);
  assert.equal(malformed.staleCode, 'INVALID_RUNTIME_CONFIG_JSON');
  assert.equal(malformed.models[0].actualModel, initial.models[0].actualModel);

  await privateJson(value.settingsFile, claudeSettings('restored'));
  const restored = await value.registry.refresh();
  assert.equal(restored.stale, false);
  assert.equal(restored.models[0].actualModel, 'qwen-runtime-restored[1M]');

  await fsp.chmod(value.settingsFile, 0o644);
  const unsafe = await value.registry.refresh();
  assert.equal(unsafe.stale, true);
  assert.equal(unsafe.staleCode, 'UNSAFE_RUNTIME_CONFIG_FILE');
  assert.equal(unsafe.models[0].actualModel, restored.models[0].actualModel);

  await assert.rejects(
    () => value.registry.update({
      expectedRevision: unsafe.revision,
      webSearch: { enabled: true },
    }),
    { code: 'RUNTIME_CONFIG_STALE', status: 409 },
  );
});

test('unsafe initial files and symlinks are rejected before any last-known-good exists', async (t) => {
  const wrongMode = await fixture(t, { settingsMode: 0o644 });
  await assert.rejects(wrongMode.registry.ready, { code: 'UNSAFE_RUNTIME_CONFIG_FILE' });

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-config-symlink-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.json');
  const settingsFile = path.join(root, 'settings.json');
  await privateJson(target, claudeSettings());
  await fsp.symlink(target, settingsFile);
  const registry = new RuntimeConfigRegistry({
    settingsFile,
    managedFile: path.join(root, 'managed.json'),
    modelCatalog: MODEL_CATALOG,
  });
  await assert.rejects(registry.ready, { code: 'RUNTIME_CONFIG_FILE_UNAVAILABLE' });
});

test('embedding URL validation excludes credentialed, local, IP, insecure, and unusual endpoints', () => {
  assert.equal(
    runtimeConfigInternals.safeEmbeddingUrl('https://api.example.com/v1/'),
    'https://api.example.com/v1',
  );
  for (const invalid of [
    'http://api.example.com/v1',
    'https://user:password@api.example.com/v1',
    'https://127.0.0.1/v1',
    'https://[::1]/v1',
    'https://localhost/v1',
    'https://service.internal/v1',
    'https://api.example.com:8443/v1',
    'https://api.example.com/v1?token=secret',
    'https://api.example.com/v1#fragment',
  ]) {
    assert.throws(
      () => runtimeConfigInternals.safeEmbeddingUrl(invalid),
      { code: 'INVALID_EMBEDDING_URL' },
    );
  }
});

test('serialized compare-and-swap permits only one concurrent update from a shared revision', async (t) => {
  const value = await fixture(t);
  const initial = await value.registry.ready;
  const outcomes = await Promise.allSettled([
    value.registry.update({
      expectedRevision: initial.revision,
      webSearch: { enabled: true },
    }),
    value.registry.update({
      expectedRevision: initial.revision,
      webSearch: { enabled: false },
    }),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((entry) => entry.status === 'rejected');
  assert.equal(rejected.reason.code, 'RUNTIME_CONFIG_REVISION_CONFLICT');
});

test('direct managed edits must advance their stored revision', async (t) => {
  const value = await fixture(t);
  const initial = await value.registry.ready;
  const updated = await value.registry.update({
    expectedRevision: initial.revision,
    webSearch: { enabled: true },
  });
  const document = JSON.parse(await fsp.readFile(value.managedFile, 'utf8'));
  document.webSearch.enabled = false;
  await privateJson(value.managedFile, document);

  const stale = await value.registry.refresh();
  assert.equal(stale.stale, true);
  assert.equal(stale.staleCode, 'RUNTIME_CONFIG_REVISION_REUSED');
  assert.equal(stale.revision, updated.revision);
  assert.equal(value.registry.runtimeSnapshot().webSearch.enabled, true);
});

test('WebSearch endpoint cannot be supplied by managed files or update payloads', async (t) => {
  const value = await fixture(t);
  const initial = await value.registry.ready;
  await assert.rejects(
    () => value.registry.update({
      expectedRevision: initial.revision,
      webSearch: { endpoint: 'https://attacker.example.com/mcp' },
    }),
    { code: 'INVALID_RUNTIME_CONFIG_UPDATE' },
  );

  const unsafeManaged = {
    version: 1,
    revision: 'fixture-revision-0001',
    updatedAt: new Date().toISOString(),
    models: {},
    embedding: {},
    webSearch: { endpoint: 'https://attacker.example.com/mcp' },
  };
  await privateJson(value.managedFile, unsafeManaged);
  const stale = await value.registry.refresh();
  assert.equal(stale.stale, true);
  assert.equal(stale.staleCode, 'INVALID_RUNTIME_CONFIG');
});

test('v2 accepts a canonical empty LLM state and non-model updates preserve it', async (t) => {
  const emptyDocument = {
    version: 2,
    revision: 'empty-runtime-revision-0001',
    updatedAt: new Date().toISOString(),
    connections: [],
    models: [],
    defaultModelId: '',
    branding: { appName: 'Second Mind', vaultLabel: 'Fixture Vault' },
    embedding: { provider: 'disabled', apiKey: null },
    webSearch: {
      enabled: false,
      provider: 'bailian-mcp',
      providers: {
        'bailian-mcp': { apiKey: null, extractFallbackEnabled: false },
        'tavily-rest': { apiKey: null, extractFallbackEnabled: false },
      },
    },
  };
  const value = await fixture(t, { settings: null, managed: emptyDocument });
  const initial = await value.registry.ready;
  assert.equal(initial.schemaVersion, 2);
  assert.equal(initial.source, 'managed');
  assert.deepEqual(initial.connections, []);
  assert.deepEqual(initial.models, []);
  assert.equal(initial.defaultModelId, '');
  assert.match(initial.modelCatalogRevision, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(initial), /"apiKey":/u);

  const updated = await value.registry.update({
    expectedRevision: initial.revision,
    branding: { appName: 'Second Mind', vaultLabel: 'Empty Catalog Vault' },
  });
  assert.deepEqual(updated.connections, []);
  assert.deepEqual(updated.models, []);
  assert.equal(updated.defaultModelId, '');
  assert.equal(updated.branding.vaultLabel, 'Empty Catalog Vault');

  assert.throws(
    () => runtimeConfigInternals.normalizeManagedDocumentV2({
      ...emptyDocument,
      revision: 'empty-runtime-revision-0002',
      defaultModelId: 'missing-model',
    }),
    { code: 'INVALID_RUNTIME_CONFIG' },
  );
});

test('a fresh registry recovers its durable last-known-good document without exposing secrets', async (t) => {
  const value = await fixture(t, { settings: null });
  const upgraded = await value.registry.bootstrapManagedV2();
  const validPrimary = await fsp.readFile(value.managedFile);
  const backupFile = `${value.managedFile}.last-good`;
  assert.equal((await fsp.stat(backupFile)).mode & 0o777, 0o600);

  await fsp.writeFile(value.managedFile, '{malformed-json', { mode: 0o600 });
  await fsp.chmod(value.managedFile, 0o600);
  const recoveredRegistry = new RuntimeConfigRegistry({
    settingsFile: value.settingsFile,
    managedFile: value.managedFile,
    modelCatalog: MODEL_CATALOG,
    llm: {
      provider: 'anthropic',
      protocol: 'anthropic-messages',
      apiBase: 'https://models.example.com/anthropic',
      apiKey: LLM_SECRET,
      authMode: 'x-api-key',
    },
    embedding: {
      provider: 'dashscope',
      apiBase: 'https://dashscope.aliyuncs.com',
      apiKey: ['inherited', 'embedding', 'credential'].join('-'),
      model: 'embedding-default',
      dimensions: 1_024,
    },
    webSearch: {
      enabled: false,
      apiKey: ['inherited', 'web', 'credential'].join('-'),
    },
  });
  const recovered = await recoveredRegistry.ready;
  assert.equal(recovered.stale, true);
  assert.equal(recovered.staleCode, 'INVALID_RUNTIME_CONFIG_JSON');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.revision, upgraded.revision);
  assert.deepEqual(recovered.models, upgraded.models);
  assert.equal(recoveredRegistry.runtimeSnapshot().connections[0].apiKey, LLM_SECRET);
  assert.doesNotMatch(JSON.stringify(recovered), new RegExp(LLM_SECRET, 'u'));
  assert.equal(await fsp.readFile(value.managedFile, 'utf8'), '{malformed-json');
  await assert.rejects(
    () => recoveredRegistry.update({
      expectedRevision: recovered.revision,
      branding: { appName: 'Second Mind', vaultLabel: 'Blocked while stale' },
    }),
    { code: 'RUNTIME_CONFIG_STALE', status: 409 },
  );

  await fsp.writeFile(value.managedFile, validPrimary, { mode: 0o600 });
  await fsp.chmod(value.managedFile, 0o600);
  const restored = await recoveredRegistry.refresh();
  assert.equal(restored.stale, false);
  assert.equal(restored.recovered, false);
  assert.equal(restored.revision, upgraded.revision);
});
