import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertProviderConfigRevision,
  buildProviderConfigPatch,
  buildRegisteredProviderConfigPatch,
  MAX_SIMPLIFIED_ENABLED_MODELS,
  ProviderValidationStageStore,
  providerCandidateDigest,
  toSimplifiedProviderConfig,
  ValidationCredentialStore,
  VALIDATION_CREDENTIAL_TTL_MS,
} from '../src/provider-config-dto.mjs';

const PROVIDER_KEY = ['provider', 'fixture', 'credential', '123456'].join('-');
const REPLACEMENT_KEY = ['replacement', 'fixture', 'credential', '123456'].join('-');
const REVISION = 'a'.repeat(64);

function snapshot() {
  return {
    version: 2,
    revision: REVISION,
    defaultModelId: 'main-model',
    connections: [{
      id: 'primary-provider',
      label: 'Primary provider',
      providerId: 'custom',
      protocol: 'openai-chat-completions',
      apiBase: 'https://models.example.com/v1',
      authMode: 'bearer',
      apiKeyConfigured: true,
      apiKey: PROVIDER_KEY,
    }],
    models: [{
      id: 'main-model',
      label: 'Main model',
      shortLabel: 'Main',
      connectionId: 'primary-provider',
      actualModel: 'provider-model-v1',
      requestProfile: 'openai-standard',
      efforts: ['low', 'high'],
      defaultEffort: 'high',
      enabled: true,
      available: true,
    }],
  };
}

test('simplified DTO groups models under providers without exposing credentials', () => {
  const dto = toSimplifiedProviderConfig(snapshot());
  assert.equal(dto.schemaVersion, 1);
  assert.equal(dto.revision, REVISION);
  assert.equal(dto.providers[0].id, 'primary-provider');
  assert.equal(dto.providers[0].providerId, 'custom');
  assert.equal(dto.providers[0].apiKeyConfigured, true);
  assert.equal(dto.providers[0].models[0].id, 'main-model');
  assert.equal(dto.providers[0].models[0].actualModel, 'provider-model-v1');
  assert.equal(dto.providers[0].models[0].default, true);
  assert.deepEqual(dto.providers[0].models[0].reasoningMapping, { mode: 'auto' });
  assert.deepEqual(dto.providers[0].models[0].effortMapping, {
    low: 'default', medium: 'default', high: 'default', xhigh: 'default', max: 'default',
  });
  assert.equal(Object.hasOwn(dto.providers[0].models[0], 'requestProfile'), false);
  assert.equal(Object.hasOwn(dto.providers[0].models[0], 'efforts'), false);
  assert.equal(Object.hasOwn(dto.providers[0].models[0], 'defaultEffort'), false);
  assert.equal(JSON.stringify(dto).includes(PROVIDER_KEY), false);
  assert.equal(Object.hasOwn(dto.providers[0], 'apiKey'), false);
});

test('DTO mapping preserves existing stable IDs and generates server-owned IDs for new rows', () => {
  let generated = 0;
  const result = buildProviderConfigPatch({
    schemaVersion: 1,
    expectedRevision: REVISION,
    providers: [{
      id: 'primary-provider',
      label: 'Renamed provider',
      protocol: 'openai-chat-completions',
      apiBase: 'https://models.example.com/v1',
      authMode: 'bearer',
      apiKeyAction: 'keep',
      models: [{
        id: 'main-model', displayName: 'Renamed model', actualModel: 'provider-model-v2',
        requestProfile: 'openai-standard', efforts: ['high'], defaultEffort: 'high', enabled: true,
      }, {
        displayName: 'Second model', actualModel: 'second-provider-model',
        requestProfile: 'openai-standard', efforts: ['default'], enabled: true,
      }],
    }, {
      preset: 'zhipu',
      label: 'GLM connection',
      apiKeyAction: 'replace',
      apiKey: REPLACEMENT_KEY,
      models: [{ displayName: 'GLM model', actualModel: 'glm-fixture', enabled: true }],
    }],
  }, snapshot(), {
    idFactory: (prefix) => `${prefix}-generated-${++generated}`,
  });

  assert.equal(result.patch.connections[0].id, 'primary-provider');
  assert.equal(result.patch.models[0].id, 'main-model');
  assert.equal(result.patch.models[0].actualModel, 'provider-model-v2');
  assert.equal(result.patch.connections[1].protocol, 'openai-chat-completions');
  assert.equal(result.patch.connections[1].apiBase, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(result.patch.models[2].requestProfile, 'glm-openai');
  assert.deepEqual(result.idAssignments, {
    providers: [{ index: 1, id: 'provider-generated-2' }],
    models: [
      { providerIndex: 0, modelIndex: 1, id: 'model-generated-1' },
      { providerIndex: 1, modelIndex: 0, id: 'model-generated-3' },
    ],
  });
  assert.equal(result.patch.defaultModelId, 'main-model');
  assert.match(result.candidateDigest, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(result.idAssignments).includes(REPLACEMENT_KEY), false);
});

test('preset resolution can be injected without coupling DTO mapping to a provider registry module', () => {
  const result = buildProviderConfigPatch({
    schemaVersion: 1,
    expectedRevision: REVISION,
    providers: [{
      preset: 'fixture-private-cloud', label: 'Fixture private cloud',
      apiKeyAction: 'replace', apiKey: REPLACEMENT_KEY,
      models: [{ displayName: 'Fixture', actualModel: 'fixture-model' }],
    }],
  }, snapshot(), {
    idFactory: (prefix) => `${prefix}-fixture`,
    presetResolver: (id) => id === 'fixture-private-cloud' ? {
      label: 'Injected fixture', protocol: 'anthropic-messages',
      apiBase: 'https://private-cloud.example.com/anthropic', authMode: 'x-api-key',
      requestProfile: 'anthropic-standard',
    } : null,
  });
  assert.equal(result.patch.connections[0].protocol, 'anthropic-messages');
  assert.equal(result.patch.connections[0].authMode, 'x-api-key');
  assert.equal(result.patch.models[0].requestProfile, 'anthropic-standard');
});

test('the simplified boundary allows at most three enabled models', () => {
  assert.equal(MAX_SIMPLIFIED_ENABLED_MODELS, 3);
  const models = Array.from({ length: 4 }, (_, index) => ({
    displayName: `Model ${index + 1}`,
    actualModel: `provider-model-${index + 1}`,
    requestProfile: 'openai-standard',
    enabled: true,
  }));
  let generated = 0;
  assert.throws(
    () => buildProviderConfigPatch({
      schemaVersion: 1,
      expectedRevision: REVISION,
      providers: [{
        id: 'primary-provider', label: 'Primary provider',
        protocol: 'openai-chat-completions', apiBase: 'https://models.example.com/v1',
        authMode: 'bearer', apiKeyAction: 'keep', models,
      }],
    }, snapshot(), { idFactory: (prefix) => `${prefix}-limit-${++generated}` }),
    { code: 'TOO_MANY_ENABLED_MODELS', status: 400 },
  );
});

test('clients cannot invent or rename internal stable IDs', () => {
  assert.throws(
    () => buildProviderConfigPatch({
      schemaVersion: 1,
      expectedRevision: REVISION,
      providers: [{
        id: 'client-invented-provider', label: 'Unexpected',
        protocol: 'openai-chat-completions', apiBase: 'https://models.example.com/v1',
        authMode: 'bearer', apiKeyAction: 'keep',
        models: [{ id: 'main-model', displayName: 'Main', actualModel: 'provider-model-v1' }],
      }],
    }, snapshot()),
    { code: 'UNKNOWN_STABLE_ID', status: 409 },
  );
  assert.throws(
    () => buildProviderConfigPatch({
      schemaVersion: 1,
      expectedRevision: REVISION,
      providers: [{
        id: 'primary-provider', label: 'Primary',
        protocol: 'openai-chat-completions', apiBase: 'https://models.example.com/v1',
        authMode: 'bearer', apiKeyAction: 'keep',
        models: [{ id: 'client-invented-model', displayName: 'Unexpected', actualModel: 'unknown' }],
      }],
    }, snapshot()),
    { code: 'UNKNOWN_STABLE_ID', status: 409 },
  );
});

test('the registered-provider boundary derives hidden transport fields and rejects extra input', () => {
  const input = {
    schemaVersion: 1,
    expectedRevision: REVISION,
    providers: [{
      id: 'primary-provider',
      providerId: 'custom',
      apiBase: 'https://models.example.com/v1',
      apiKeyAction: 'keep',
      protocol: 'openai-chat-completions',
      authMode: 'bearer',
      models: [{
        id: 'main-model',
        displayName: '',
        actualModel: 'provider-model-v2',
        enabled: true,
      }],
    }],
    defaultModelId: 'main-model',
  };
  const result = buildRegisteredProviderConfigPatch(input, snapshot());
  assert.equal(result.patch.connections[0].protocol, 'openai-chat-completions');
  assert.equal(result.patch.connections[0].providerId, 'custom');
  assert.equal(result.patch.models[0].requestProfile, 'default');
  assert.deepEqual(result.patch.models[0].efforts, ['default']);
  assert.equal(result.patch.models[0].displayName, 'provider-model-v2');
  assert.throws(
    () => buildRegisteredProviderConfigPatch({ ...input, requestProfile: 'deepseek-openai' }, snapshot()),
    { code: 'INVALID_PROVIDER_CONFIG', status: 400 },
  );
});

test('registered Provider DTO accepts semantic five-tier overrides and projects through provider capabilities', () => {
  const current = snapshot();
  current.connections[0] = {
    ...current.connections[0],
    providerId: 'deepseek',
    label: 'DeepSeek',
    apiBase: 'https://api.deepseek.com',
  };
  current.models[0] = {
    ...current.models[0],
    actualModel: 'deepseek-reasoner',
    requestProfile: 'deepseek-openai',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  };
  const manual = {
    mode: 'manual',
    tiers: { low: 'default', medium: 'low', high: 'medium', xhigh: 'xhigh', max: 'max' },
  };
  const result = buildRegisteredProviderConfigPatch({
    schemaVersion: 1,
    expectedRevision: REVISION,
    providers: [{
      id: 'primary-provider', providerId: 'deepseek', apiBase: 'https://api.deepseek.com',
      apiKeyAction: 'keep',
      models: [{
        id: 'main-model', actualModel: 'deepseek-reasoner', enabled: true, default: true,
        reasoningMapping: manual,
      }],
    }],
  }, current);
  assert.deepEqual(result.patch.models[0].reasoningMapping, manual);

  current.models[0].reasoningMapping = manual;
  const dto = toSimplifiedProviderConfig(current);
  assert.deepEqual(dto.providers[0].models[0].reasoningMapping, manual);
  assert.deepEqual(dto.providers[0].models[0].effortMapping, {
    low: 'default', medium: 'low', high: 'high', xhigh: 'max', max: 'max',
  });
  assert.deepEqual(dto.providers[0].models[0].automaticEffortMapping, {
    low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max',
  });

  const legacyClient = buildRegisteredProviderConfigPatch({
    schemaVersion: 1,
    expectedRevision: REVISION,
    providers: [{
      id: 'primary-provider', providerId: 'deepseek', apiBase: 'https://api.deepseek.com',
      apiKeyAction: 'keep',
      models: [{ id: 'main-model', actualModel: 'deepseek-reasoner', enabled: true }],
    }],
  }, current);
  assert.deepEqual(
    legacyClient.patch.models[0].reasoningMapping,
    manual,
    'an older simplified client that omits the new field must preserve the saved mapping',
  );

  const invalid = structuredClone(manual);
  invalid.tiers.max = 'ultra';
  assert.throws(
    () => buildRegisteredProviderConfigPatch({
      schemaVersion: 1,
      expectedRevision: REVISION,
      providers: [{
        id: 'primary-provider', providerId: 'deepseek', apiBase: 'https://api.deepseek.com',
        apiKeyAction: 'keep',
        models: [{
          id: 'main-model', actualModel: 'deepseek-reasoner', enabled: true,
          reasoningMapping: invalid,
        }],
      }],
    }, current),
    { code: 'MODEL_PROVIDER_EFFORT_MAPPING_INVALID' },
  );
});

test('registered provider identity survives a compatible proxy API Base', () => {
  const current = snapshot();
  current.connections[0].providerId = 'deepseek';
  current.connections[0].apiBase = 'https://deepseek-proxy.example.com/v1';
  const dto = toSimplifiedProviderConfig(current);
  assert.equal(dto.providers[0].providerId, 'deepseek');
  const result = buildRegisteredProviderConfigPatch({
    schemaVersion: 1,
    expectedRevision: REVISION,
    providers: [{
      id: 'primary-provider',
      providerId: 'deepseek',
      apiBase: 'https://deepseek-proxy.example.com/v1',
      apiKeyAction: 'keep',
      models: [{
        id: 'main-model', actualModel: 'deepseek-v4-pro', enabled: true, default: true,
      }],
    }],
  }, current);
  assert.equal(result.patch.connections[0].providerId, 'deepseek');
  assert.equal(result.patch.connections[0].apiBase, 'https://deepseek-proxy.example.com/v1');
});

test('DeepSeek provider DTO normalizes its exact legacy alias without rewriting custom models', () => {
  const current = snapshot();
  current.connections[0].providerId = 'deepseek';
  current.connections[0].apiBase = 'https://api.deepseek.com';
  current.connections[0].protocol = 'openai-chat-completions';
  current.connections[0].authMode = 'bearer';
  current.models[0].actualModel = 'deepseek-v4-pro-0813';
  current.models[0].requestProfile = 'deepseek-openai';
  current.models[0].efforts = ['low', 'high'];
  current.models[0].defaultEffort = 'high';

  const dto = toSimplifiedProviderConfig(current);
  assert.equal(dto.providers[0].models[0].actualModel, 'deepseek-v4-pro');
  const normalized = buildRegisteredProviderConfigPatch({
    schemaVersion: 1,
    expectedRevision: REVISION,
    providers: [{
      id: 'primary-provider', providerId: 'deepseek',
      apiBase: 'https://api.deepseek.com', apiKeyAction: 'keep',
      models: [{
        id: 'main-model', actualModel: 'deepseek-v4-pro-0813', enabled: true, default: true,
      }],
    }],
  }, current);
  assert.equal(normalized.patch.models[0].actualModel, 'deepseek-v4-pro');

  const custom = snapshot();
  const untouched = buildRegisteredProviderConfigPatch({
    schemaVersion: 1,
    expectedRevision: REVISION,
    providers: [{
      id: 'primary-provider', providerId: 'custom',
      apiBase: 'https://models.example.com/v1', apiKeyAction: 'keep',
      protocol: 'openai-chat-completions', authMode: 'bearer',
      models: [{
        id: 'main-model', actualModel: 'deepseek-v4-pro-0813', enabled: true, default: true,
      }],
    }],
  }, custom);
  assert.equal(untouched.patch.models[0].actualModel, 'deepseek-v4-pro-0813');
});

test('candidate commitments change with replacement secrets without revealing them', () => {
  const first = { connections: [{ id: 'one', apiKeyAction: 'replace', apiKey: REPLACEMENT_KEY }] };
  const second = { connections: [{ id: 'one', apiKeyAction: 'replace', apiKey: `${REPLACEMENT_KEY}-new` }] };
  const digest = providerCandidateDigest(first);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.notEqual(digest, providerCandidateDigest(second));
  assert.equal(digest.includes(REPLACEMENT_KEY), false);
});

test('validation credentials stage a secret candidate for ten minutes and are one-shot', () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let tokenNumber = 0;
  const store = new ValidationCredentialStore({
    clock: () => now,
    randomBytes: () => Buffer.alloc(32, ++tokenNumber),
  });
  const candidate = {
    schemaVersion: 2,
    expectedRevision: REVISION,
    connections: [{ id: 'provider', apiKeyAction: 'replace', apiKey: REPLACEMENT_KEY }],
  };
  const receipt = store.issue({ adminId: 'admin-user', baseRevision: REVISION, candidate });
  assert.equal(Date.parse(receipt.expiresAt) - now, VALIDATION_CREDENTIAL_TTL_MS);
  assert.equal(JSON.stringify(receipt).includes(REPLACEMENT_KEY), false);
  assert.equal(Object.hasOwn(receipt, 'candidate'), false);
  assert.equal(store.size, 1);

  const staged = store.claim({
    token: receipt.token, adminId: 'admin-user', currentRevision: REVISION,
  });
  assert.deepEqual(staged, candidate);
  assert.notEqual(staged, candidate);
  assert.equal(store.size, 0);
  assert.throws(
    () => store.claim({ token: receipt.token, adminId: 'admin-user', currentRevision: REVISION }),
    { code: 'VALIDATION_CREDENTIAL_INVALID', status: 409 },
  );
});

test('validation credentials are bound to administrator, candidate, and CAS revision', () => {
  let tokenNumber = 10;
  const store = new ValidationCredentialStore({
    randomBytes: () => Buffer.alloc(32, ++tokenNumber),
  });
  const candidate = { expectedRevision: REVISION, apiKey: REPLACEMENT_KEY };
  const candidateDigest = providerCandidateDigest(candidate);

  const wrongAdmin = store.issue({ adminId: 'admin-a', baseRevision: REVISION, candidate });
  assert.throws(
    () => store.claim({ token: wrongAdmin.token, adminId: 'admin-b', currentRevision: REVISION }),
    { code: 'VALIDATION_CREDENTIAL_MISMATCH', status: 409 },
  );

  const wrongCandidate = store.issue({ adminId: 'admin-a', baseRevision: REVISION, candidate });
  assert.throws(
    () => store.claim({
      token: wrongCandidate.token, adminId: 'admin-a', currentRevision: REVISION,
      candidateDigest: 'b'.repeat(64),
    }),
    { code: 'VALIDATION_CREDENTIAL_MISMATCH', status: 409 },
  );

  const stale = store.issue({ adminId: 'admin-a', baseRevision: REVISION, candidate, candidateDigest });
  assert.throws(
    () => store.claim({
      token: stale.token, adminId: 'admin-a', currentRevision: 'c'.repeat(64),
    }),
    { code: 'PROVIDER_CONFIG_REVISION_CONFLICT', status: 409 },
  );
  assert.equal(store.size, 0, 'a claim attempt always invalidates its bearer token');
});

test('expired validation candidates are removed and CAS helper fails closed', () => {
  let now = 1_000;
  const store = new ValidationCredentialStore({
    ttlMs: 1_000,
    clock: () => now,
    randomBytes: () => Buffer.alloc(32, 42),
  });
  const receipt = store.issue({
    adminId: 'admin', baseRevision: REVISION,
    candidate: { expectedRevision: REVISION, apiKey: REPLACEMENT_KEY },
  });
  now += 1_001;
  assert.equal(store.size, 0);
  assert.throws(
    () => store.claim({ token: receipt.token, adminId: 'admin', currentRevision: REVISION }),
    { code: 'VALIDATION_CREDENTIAL_INVALID', status: 409 },
  );
  assert.equal(assertProviderConfigRevision(REVISION, REVISION), REVISION);
  assert.throws(
    () => assertProviderConfigRevision(REVISION, 'd'.repeat(64)),
    { code: 'PROVIDER_CONFIG_REVISION_CONFLICT', status: 409 },
  );
});

test('provider validation stages retain exact candidates without becoming commit receipts', () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const stages = new ProviderValidationStageStore({
    clock: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
  });
  const candidate = {
    schemaVersion: 2,
    expectedRevision: REVISION,
    connections: [{ id: 'provider-one', apiKeyAction: 'replace', apiKey: REPLACEMENT_KEY }],
  };
  const issued = stages.issue({
    adminId: 'admin-user',
    baseRevision: REVISION,
    candidate,
    connectionId: 'provider-one',
  });
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(JSON.stringify(issued).includes(REPLACEMENT_KEY), false);
  stages.add({
    token: issued.token,
    adminId: 'admin-user',
    currentRevision: REVISION,
    connectionId: 'provider-two',
  });
  const resumed = stages.resume({
    token: issued.token,
    adminId: 'admin-user',
    currentRevision: REVISION,
  });
  assert.deepEqual(resumed.connectionIds.sort(), ['provider-one', 'provider-two']);
  assert.equal(resumed.candidate.connections[0].apiKey, REPLACEMENT_KEY);
  assert.throws(
    () => stages.resume({
      token: issued.token,
      adminId: 'different-admin',
      currentRevision: REVISION,
    }),
    { code: 'PROVIDER_VALIDATION_STAGE_MISMATCH', status: 409 },
  );
  now += VALIDATION_CREDENTIAL_TTL_MS + 1;
  assert.throws(
    () => stages.resume({
      token: issued.token,
      adminId: 'admin-user',
      currentRevision: REVISION,
    }),
    { code: 'PROVIDER_VALIDATION_STAGE_INVALID', status: 409 },
  );
});
