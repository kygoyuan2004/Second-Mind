import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RuntimeConfigRegistry,
  runtimeConfigInternals,
} from '../src/runtime-config-registry.mjs';

const LLM_SECRET = 'offline-llm-fixture-credential';

const MODEL_CATALOG = [{
  id: 'qwen',
  label: 'Default one',
  shortLabel: 'One',
  actualModel: 'default-one',
  efforts: ['default'],
  defaultEffort: 'default',
  available: true,
}, {
  id: 'kimi',
  label: 'Default two',
  shortLabel: 'Two',
  actualModel: 'default-two',
  efforts: ['default'],
  defaultEffort: 'default',
  available: true,
}, {
  id: 'deepseek',
  label: 'Default three',
  shortLabel: 'Three',
  actualModel: 'default-three',
  efforts: ['default'],
  defaultEffort: 'default',
  available: true,
}];

function connection(id, protocol, apiBase) {
  return {
    id,
    label: id,
    protocol,
    apiBase,
    authMode: protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer',
    apiKey: LLM_SECRET,
  };
}

function model(id, connectionId, actualModel, requestProfile = 'anthropic-standard') {
  return {
    id,
    displayName: id,
    shortLabel: id,
    connectionId,
    actualModel,
    requestProfile,
    efforts: ['default'],
    defaultEffort: 'default',
    enabled: true,
    description: '',
  };
}

function dynamicDocument({ connections, models }) {
  return {
    version: 2,
    revision: 'offline-boundary-revision-0001',
    updatedAt: '2026-09-03T00:00:00.000Z',
    connections,
    models,
    defaultModelId: models[0].id,
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
}

async function writePrivateJson(filename, value) {
  await fsp.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(filename, 0o600);
}

async function legacyRegistryFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-branding-boundary-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const settingsFile = path.join(root, 'settings.json');
  const managedFile = path.join(root, 'managed.json');
  await writePrivateJson(managedFile, {
    version: 1,
    revision: 'legacy-branding-revision-0001',
    updatedAt: '2026-09-03T00:00:00.000Z',
    models: {},
    embedding: {},
    webSearch: {},
  });
  const registry = new RuntimeConfigRegistry({
    settingsFile,
    managedFile,
    modelCatalog: MODEL_CATALOG,
    llm: {
      protocol: 'anthropic-messages',
      apiBase: 'https://models.example.com/anthropic',
      apiKey: LLM_SECRET,
      authMode: 'x-api-key',
    },
    embedding: { provider: 'disabled' },
    webSearch: { enabled: false },
    branding: {
      appName: 'Deployment App',
      vaultLabel: 'Deployment Vault',
    },
  });
  await registry.ready;
  return { managedFile, registry };
}

test('legacy direct aliases migrate only for exact IDs on the DashScope Anthropic gateway', () => {
  const managed = runtimeConfigInternals.normalizeManagedDocumentV2(dynamicDocument({
    connections: [
      connection(
        'dashscope-anthropic',
        'anthropic-messages',
        'https://dashscope.aliyuncs.com/apps/anthropic',
      ),
      connection(
        'dashscope-openai',
        'openai-chat-completions',
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      ),
      connection('custom-anthropic', 'anthropic-messages', 'https://models.example.com/anthropic'),
    ],
    models: [
      model('legacy-qwen', 'dashscope-anthropic', 'qwen3.8-max-0902[1M]'),
      model('legacy-kimi', 'dashscope-anthropic', 'kimi-k3[1M]'),
      model('case-sensitive-near-match', 'dashscope-anthropic', 'QWEN3.8-max-0902[1M]'),
      model('different-bracket-alias', 'dashscope-anthropic', 'qwen3.8-max-0902[2M]'),
      model(
        'dashscope-openai-alias',
        'dashscope-openai',
        'qwen3.8-max-0902[1M]',
        'openai-standard',
      ),
      model('custom-exact-alias', 'custom-anthropic', 'kimi-k3[1M]'),
      model('custom-bracket-id', 'custom-anthropic', 'vendor/model[preview-v2]'),
    ].map((entry, index) => ({ ...entry, enabled: index < 3 })),
  }));
  const actual = new Map(managed.models.map((entry) => [entry.id, entry.actualModel]));

  assert.equal(actual.get('legacy-qwen'), 'qwen3.8-max-0902');
  assert.equal(actual.get('legacy-kimi'), 'kimi-k3');
  assert.equal(actual.get('case-sensitive-near-match'), 'QWEN3.8-max-0902[1M]');
  assert.equal(actual.get('different-bracket-alias'), 'qwen3.8-max-0902[2M]');
  assert.equal(actual.get('dashscope-openai-alias'), 'qwen3.8-max-0902[1M]');
  assert.equal(actual.get('custom-exact-alias'), 'kimi-k3[1M]');
  assert.equal(actual.get('custom-bracket-id'), 'vendor/model[preview-v2]');
});

test('persisted provider adapters reject cross-wired vendor request profiles', () => {
  const document = dynamicDocument({
    connections: [{
      ...connection('kimi-official', 'openai-chat-completions', 'https://api.moonshot.cn/v1'),
      providerId: 'kimi',
    }],
    models: [model(
      'unsafe-kimi',
      'kimi-official',
      'kimi-model',
      'deepseek-openai',
    )],
  });
  assert.throws(
    () => runtimeConfigInternals.normalizeManagedDocumentV2(document),
    { code: 'INVALID_RUNTIME_CONFIG', status: 400 },
  );
});

test('persisted provider adapters reject undeclared reasoning strengths', () => {
  const document = dynamicDocument({
    connections: [{
      ...connection(
        'bailian-official',
        'anthropic-messages',
        'https://dashscope.aliyuncs.com/apps/anthropic',
      ),
      providerId: 'bailian',
    }],
    models: [{
      ...model('unsafe-effort', 'bailian-official', 'qwen3.8-max-0902'),
      efforts: ['max'],
      defaultEffort: 'max',
    }],
  });
  assert.throws(
    () => runtimeConfigInternals.normalizeManagedDocumentV2(document),
    { code: 'INVALID_RUNTIME_CONFIG', status: 400 },
  );
});

test('legacy v2 files without providerId are upgraded to the fail-safe Custom profile', () => {
  const document = dynamicDocument({
    connections: [connection(
      'legacy-custom',
      'anthropic-messages',
      'https://models.example.com/anthropic',
    )],
    models: [model(
      'legacy-custom-model',
      'legacy-custom',
      'vendor/model',
      'anthropic-standard',
    )],
  });
  const managed = runtimeConfigInternals.normalizeManagedDocumentV2(document);
  assert.equal(managed.connections[0].providerId, 'custom');
  assert.equal(managed.models[0].requestProfile, 'default');
  assert.deepEqual(managed.models[0].efforts, ['default']);
});

test('legacy branding falls back to deployment defaults and branding updates do not change the model catalog revision', async (t) => {
  const { managedFile, registry } = await legacyRegistryFixture(t);
  const deploymentBranding = { appName: 'Deployment App', vaultLabel: 'Deployment Vault' };

  assert.deepEqual(registry.publicSnapshot().branding, deploymentBranding);
  assert.deepEqual(registry.runtimeSnapshot().branding, deploymentBranding);

  const upgraded = await registry.bootstrapManagedV2();
  const catalogRevision = upgraded.modelCatalogRevision;
  const updated = await registry.update({
    schemaVersion: 2,
    expectedRevision: upgraded.revision,
    branding: { appName: 'Updated App', vaultLabel: 'Updated Vault' },
  });

  assert.deepEqual(updated.branding, { appName: 'Updated App', vaultLabel: 'Updated Vault' });
  assert.deepEqual(registry.publicSnapshot().branding, updated.branding);
  assert.deepEqual(registry.runtimeSnapshot().branding, updated.branding);
  assert.equal(updated.modelCatalogRevision, catalogRevision);
  assert.notEqual(updated.revision, upgraded.revision);
  const stored = JSON.parse(await fsp.readFile(managedFile, 'utf8'));
  assert.deepEqual(stored.branding, updated.branding);
});

test('previewUpdate is CAS guarded and leaves both disk and the active snapshots unchanged', async (t) => {
  const { managedFile, registry } = await legacyRegistryFixture(t);
  const initial = await registry.bootstrapManagedV2();
  const beforeBytes = await fsp.readFile(managedFile);
  const beforePublic = registry.publicSnapshot();
  const beforeRuntime = registry.runtimeSnapshot();

  const candidate = await registry.previewUpdate({
    schemaVersion: 2,
    branding: { appName: 'Preview App', vaultLabel: 'Preview Vault' },
  }, { expectedRevision: initial.revision });

  assert.deepEqual(candidate.branding, { appName: 'Preview App', vaultLabel: 'Preview Vault' });
  assert.equal(candidate.modelCatalogRevision, initial.modelCatalogRevision);
  assert.deepEqual(registry.publicSnapshot(), beforePublic);
  assert.deepEqual(registry.runtimeSnapshot(), beforeRuntime);
  assert.deepEqual(await fsp.readFile(managedFile), beforeBytes);

  await assert.rejects(
    () => registry.previewUpdate({
      schemaVersion: 2,
      branding: { appName: 'Rejected App', vaultLabel: 'Rejected Vault' },
    }, { expectedRevision: 'outdated-runtime-revision' }),
    { code: 'RUNTIME_CONFIG_REVISION_CONFLICT', status: 409 },
  );
  await assert.rejects(
    () => registry.previewUpdate({
      schemaVersion: 2,
      branding: { appName: 'Missing CAS', vaultLabel: 'Missing CAS' },
    }),
    { code: 'RUNTIME_CONFIG_REVISION_REQUIRED', status: 400 },
  );
  assert.deepEqual(await fsp.readFile(managedFile), beforeBytes);
  assert.deepEqual(registry.publicSnapshot(), beforePublic);
});
