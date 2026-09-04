import crypto from 'node:crypto';
import { markPublicMessage } from './public-errors.mjs';

import {
  identifyModelProvider,
  legacyV2ProviderFields,
  listModelProviders,
  normalizeProviderModelId,
  resolveModelReasoningPolicy,
  resolveModelProvider,
} from './model-provider-registry.mjs';

export const SIMPLIFIED_PROVIDER_SCHEMA_VERSION = 1;
export const MAX_SIMPLIFIED_ENABLED_MODELS = 3;
export const VALIDATION_CREDENTIAL_TTL_MS = 10 * 60_000;

const MAX_CONNECTIONS = 16;
const MAX_MODELS = 32;
const MAX_VALIDATION_CREDENTIALS = 64;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,240}$/u;
const REVISION_PATTERN = /^(?:[a-f0-9]{64}|[A-Za-z0-9._-]{1,160})$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const PROTOCOLS = new Set(['openai-chat-completions', 'anthropic-messages']);
const AUTH_MODES = new Set(['bearer', 'x-api-key', 'none']);
const PROFILES = new Set([
  'default', 'openai-standard', 'anthropic-standard', 'bailian-openai',
  'deepseek-openai', 'glm-openai',
]);
const EFFORTS = new Set(['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SECRET_ACTIONS = new Set(['keep', 'replace', 'clear']);

export const PROVIDER_CONFIG_PRESETS = Object.freeze({
  bailian: Object.freeze({
    label: '百炼', protocol: 'anthropic-messages',
    apiBase: 'https://dashscope.aliyuncs.com/apps/anthropic',
    authMode: 'x-api-key', requestProfile: 'anthropic-standard',
  }),
  deepseek: Object.freeze({
    label: 'DeepSeek 官网', protocol: 'openai-chat-completions',
    apiBase: 'https://api.deepseek.com', authMode: 'bearer',
    requestProfile: 'deepseek-openai',
  }),
  zhipu: Object.freeze({
    label: '智谱 GLM', protocol: 'openai-chat-completions',
    apiBase: 'https://open.bigmodel.cn/api/paas/v4', authMode: 'bearer',
    requestProfile: 'glm-openai',
  }),
  moonshot: Object.freeze({
    label: 'Moonshot / Kimi', protocol: 'openai-chat-completions',
    apiBase: 'https://api.moonshot.cn', authMode: 'bearer', requestProfile: 'default',
  }),
  'custom-openai': Object.freeze({
    label: 'OpenAI-compatible', protocol: 'openai-chat-completions', apiBase: '',
    authMode: 'bearer', requestProfile: 'default',
  }),
  'custom-anthropic': Object.freeze({
    label: 'Anthropic-compatible', protocol: 'anthropic-messages', apiBase: '',
    authMode: 'x-api-key', requestProfile: 'anthropic-standard',
  }),
});

export class ProviderConfigDtoError extends Error {
  constructor(message, code = 'INVALID_PROVIDER_CONFIG', status = 400, options = {}) {
    super(message, options);
    this.name = 'ProviderConfigDtoError';
    this.code = code;
    this.status = status;
    markPublicMessage(this);
  }
}

function fail(message, code = 'INVALID_PROVIDER_CONFIG', status = 400) {
  throw new ProviderConfigDtoError(message, code, status);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, label) {
  if (!plainObject(value)) fail(`${label} must be an object.`);
  return value;
}

function onlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains an unsupported field.`);
  }
}

function text(value, label, maximum, { required = true } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') fail(`${label} must be text.`);
  const output = value.trim();
  if ((required && !output) || output.length > maximum || /[\u0000-\u001f\u007f]/u.test(output)) {
    fail(`${label} is invalid.`);
  }
  return output;
}

function stableId(value, label) {
  const output = text(value, label, 64);
  if (!ID_PATTERN.test(output)) fail(`${label} is invalid.`);
  return output;
}

function modelValue(value, label) {
  const output = text(value, label, 240);
  if (!MODEL_PATTERN.test(output)) fail(`${label} is invalid.`);
  return output;
}

function secretAction(value, label, { isNew = false, authMode = 'bearer' } = {}) {
  const fallback = isNew ? (authMode === 'none' ? 'clear' : 'replace') : 'keep';
  const output = String(value || fallback).trim().toLowerCase();
  if (!SECRET_ACTIONS.has(output)) fail(`${label} is unsupported.`);
  return output;
}

function opaqueSecret(value, label) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (
    output.length < 8 || output.length > 16_384 ||
    /[\s\u0000-\u001f\u007f]/u.test(output)
  ) fail(`${label} is invalid.`);
  return output;
}

function normalizedEfforts(value, label) {
  const source = value === undefined ? ['default'] : value;
  if (!Array.isArray(source) || source.length < 1 || source.length > EFFORTS.size) {
    fail(`${label} is invalid.`);
  }
  const output = [...new Set(source.map((entry) => String(entry || '').trim().toLowerCase()))];
  if (output.some((entry) => !EFFORTS.has(entry))) fail(`${label} is invalid.`);
  return output;
}

function normalizedProtocol(value, fallback) {
  const output = String(value || fallback || '').trim().toLowerCase();
  if (!PROTOCOLS.has(output)) fail('provider.protocol is unsupported.');
  return output;
}

function normalizedAuthMode(value, fallback) {
  const output = String(value || fallback || '').trim().toLowerCase();
  if (!AUTH_MODES.has(output)) fail('provider.authMode is unsupported.');
  return output;
}

function normalizedProfile(value, fallback, protocol) {
  const output = String(value || fallback || 'default').trim().toLowerCase();
  if (!PROFILES.has(output)) fail('model.requestProfile is unsupported.');
  if (
    (protocol === 'anthropic-messages' && output !== 'anthropic-standard' && output !== 'default') ||
    (protocol === 'openai-chat-completions' && output === 'anthropic-standard')
  ) fail('model.requestProfile does not match the provider protocol.');
  return output;
}

function normalizedBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail('model.enabled must be true or false.');
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function secretCommitted(value, key = '') {
  if (Array.isArray(value)) return value.map((entry) => secretCommitted(entry));
  if (!plainObject(value)) {
    return /(?:api[-_]?key|token|secret|authorization|credential)/iu.test(key)
      ? { present: Boolean(value), commitment: value ? sha256(String(value)) : '' }
      : value;
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    secretCommitted(childValue, childKey),
  ]));
}

export function providerCandidateDigest(candidate) {
  if (!plainObject(candidate)) fail('The validation candidate must be an object.');
  return sha256(JSON.stringify(canonical(secretCommitted(candidate))));
}

function defaultIdFactory(prefix) {
  return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function uniqueGeneratedId(prefix, occupied, idFactory) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = stableId(idFactory(prefix), `generated ${prefix} ID`);
    const normalized = candidate.toLowerCase();
    if (!occupied.has(normalized)) {
      occupied.add(normalized);
      return candidate;
    }
  }
  fail('A unique internal ID could not be generated.', 'STABLE_ID_GENERATION_FAILED', 500);
}

function publicConnection(connection) {
  return {
    id: connection.id,
    label: connection.label,
    protocol: connection.protocol,
    apiBase: connection.apiBase,
    authMode: connection.authMode,
    apiKeyConfigured: connection.authMode === 'none' ||
      connection.apiKeyConfigured === true || Boolean(connection.apiKey),
  };
}

function publicModel(model, defaultModelId = '', adapter = null) {
  const actualModel = adapter
    ? normalizeProviderModelId(adapter, model.actualModel)
    : model.actualModel;
  let reasoning = null;
  if (adapter) {
    try {
      reasoning = resolveModelReasoningPolicy(adapter, actualModel, model.reasoningMapping);
    } catch {}
  }
  return {
    id: model.id,
    displayName: model.displayName || model.label || model.actualModel,
    actualModel,
    enabled: model.enabled !== false && model.available !== false,
    default: model.id === defaultModelId,
    reasoningMapping: structuredClone(reasoning?.reasoningMapping || model.reasoningMapping || { mode: 'auto' }),
    effortMapping: { ...(reasoning?.effortMapping || model.effortMapping || {}) },
    automaticEffortMapping: {
      ...(reasoning?.automaticEffortMapping || model.automaticEffortMapping || reasoning?.effortMapping || {}),
    },
  };
}

export function toSimplifiedProviderConfig(snapshot) {
  object(snapshot, 'Runtime configuration');
  if (Number(snapshot.version || snapshot.schemaVersion) !== 2) {
    fail('Dynamic runtime configuration version 2 is required.', 'PROVIDER_CONFIG_UPGRADE_REQUIRED', 409);
  }
  const connections = Array.isArray(snapshot.connections) ? snapshot.connections : [];
  const models = Array.isArray(snapshot.models) ? snapshot.models : [];
  const providers = connections.map((connection) => {
    const providerId = String(connection.providerId || identifyModelProvider(connection));
    let adapter = {};
    let providerAdapter = null;
    try {
      providerAdapter = resolveModelProvider({
        providerId,
        apiBase: connection.apiBase,
        protocol: providerId === 'custom' ? connection.protocol : undefined,
        authMode: providerId === 'custom' ? connection.authMode : undefined,
      });
      adapter = legacyV2ProviderFields({
        providerId,
        apiBase: connection.apiBase,
        protocol: providerId === 'custom' ? connection.protocol : undefined,
        authMode: providerId === 'custom' ? connection.authMode : undefined,
      });
    } catch {}
    return {
      ...publicConnection(connection),
      providerId,
      endpointPreview: adapter.endpointPreview || '',
      docsUrl: adapter.docsUrl || '',
      models: models.filter((model) => model.connectionId === connection.id)
        .map((model) => publicModel(model, snapshot.defaultModelId, providerAdapter)),
    };
  });
  return {
    schemaVersion: SIMPLIFIED_PROVIDER_SCHEMA_VERSION,
    revision: String(snapshot.revision || ''),
    defaultModelId: String(snapshot.defaultModelId || ''),
    providers,
    providerOptions: listModelProviders(),
    branding: {
      appName: String(snapshot.branding?.appName || 'Second Mind'),
      vaultLabel: String(snapshot.branding?.vaultLabel || '知识库'),
    },
  };
}

export function buildRegisteredProviderConfigPatch(input, currentSnapshot, options = {}) {
  object(input, 'Provider configuration request');
  onlyKeys(input, new Set([
    'schemaVersion', 'expectedRevision', 'providers', 'defaultModelId', 'webSearch',
  ]),
    'Provider configuration request');
  const providerLabels = new Map(listModelProviders().map((entry) => [entry.id, entry.label]));
  const currentModelsById = new Map((currentSnapshot.models || []).map((model) => [
    String(model.id || '').toLowerCase(),
    model,
  ]));
  let flattenedModelIndex = 0;
  let selectedDefaultIndex = -1;
  const providers = Array.isArray(input.providers) ? input.providers.map((raw, providerIndex) => {
    object(raw, `providers[${providerIndex}]`);
    onlyKeys(raw, new Set([
      'id', 'providerId', 'apiBase', 'apiKeyAction', 'apiKey', 'models',
      'protocol', 'authMode',
    ]), `providers[${providerIndex}]`);
    const providerId = String(raw.providerId || '').trim().toLowerCase();
    const resolved = legacyV2ProviderFields({
      providerId,
      apiBase: raw.apiBase,
      protocol: providerId === 'custom' ? raw.protocol : undefined,
      authMode: providerId === 'custom' ? raw.authMode : undefined,
    });
    return {
      ...(raw.id ? { id: raw.id } : {}),
      providerId,
      label: providerLabels.get(providerId) || '自定义兼容服务',
      protocol: resolved.protocol,
      apiBase: raw.apiBase,
      authMode: resolved.authMode,
      apiKeyAction: raw.apiKeyAction,
      ...(Object.hasOwn(raw, 'apiKey') ? { apiKey: raw.apiKey } : {}),
      models: (Array.isArray(raw.models) ? raw.models : []).map((model, modelIndex) => {
        object(model, `providers[${providerIndex}].models[${modelIndex}]`);
        onlyKeys(model, new Set([
          'id', 'displayName', 'actualModel', 'enabled', 'default', 'reasoningMapping',
        ]),
          `providers[${providerIndex}].models[${modelIndex}]`);
        if (model.default !== undefined && typeof model.default !== 'boolean') {
          fail(`providers[${providerIndex}].models[${modelIndex}].default must be true or false.`);
        }
        if (model.default === true) {
          if (selectedDefaultIndex !== -1) fail('Only one submitted model may be the default.');
          selectedDefaultIndex = flattenedModelIndex;
        }
        flattenedModelIndex += 1;
        const configuredActualModel = modelValue(
          model.actualModel,
          `providers[${providerIndex}].models[${modelIndex}].actualModel`,
        );
        const providerAdapter = resolveModelProvider({
          providerId,
          apiBase: raw.apiBase,
          protocol: providerId === 'custom' ? raw.protocol : undefined,
          authMode: providerId === 'custom' ? raw.authMode : undefined,
        });
        const actualModel = normalizeProviderModelId(providerAdapter, configuredActualModel);
        const display = String(model.displayName || '').trim() || actualModel;
        const previousModel = model.id
          ? currentModelsById.get(String(model.id).toLowerCase())
          : null;
        const modelResolved = legacyV2ProviderFields({
          providerId,
          apiBase: raw.apiBase,
          protocol: providerId === 'custom' ? raw.protocol : undefined,
          authMode: providerId === 'custom' ? raw.authMode : undefined,
          actualModel,
        });
        const reasoning = resolveModelReasoningPolicy(
          providerAdapter,
          actualModel,
          Object.hasOwn(model, 'reasoningMapping')
            ? model.reasoningMapping
            : previousModel?.reasoningMapping,
        );
        return {
          ...(model.id ? { id: model.id } : {}),
          displayName: display,
          actualModel,
          requestProfile: modelResolved.requestProfile,
          efforts: [...modelResolved.efforts],
          defaultEffort: modelResolved.defaultEffort,
          reasoningMapping: structuredClone(reasoning.reasoningMapping),
          enabled: model.enabled !== false,
        };
      }),
    };
  }) : input.providers;
  const result = buildProviderConfigPatch({
    schemaVersion: input.schemaVersion,
    expectedRevision: input.expectedRevision,
    providers,
    defaultModelId: input.defaultModelId,
  }, currentSnapshot, options);
  if (selectedDefaultIndex !== -1) {
    const selected = result.patch.models[selectedDefaultIndex];
    if (!selected?.enabled) fail('The default model must be enabled.', 'INVALID_DEFAULT_MODEL');
    if (input.defaultModelId && input.defaultModelId !== selected.id) {
      fail('defaultModelId conflicts with the selected default model.', 'INVALID_DEFAULT_MODEL');
    }
    result.patch.defaultModelId = selected.id;
  }
  if (input.webSearch !== undefined) result.patch.webSearch = structuredClone(input.webSearch);
  return {
    ...result,
    candidateDigest: providerCandidateDigest(result.patch),
  };
}

function resolveExistingId(rawId, existing, label) {
  if (rawId === undefined || rawId === null || rawId === '') return '';
  const id = stableId(rawId, label);
  const matched = existing.get(id.toLowerCase());
  if (!matched) fail(`${label} is not an existing internal ID.`, 'UNKNOWN_STABLE_ID', 409);
  return matched.id;
}

function registryConnection(provider, current, occupied, idFactory, presetResolver, position) {
  object(provider, `providers[${position}]`);
  onlyKeys(provider, new Set([
    'id', 'preset', 'providerId', 'label', 'protocol', 'apiBase', 'authMode', 'apiKeyAction',
    'apiKey', 'models',
  ]), `providers[${position}]`);
  const presetId = String(provider.preset || '').trim().toLowerCase();
  const preset = presetId
    ? presetResolver?.(presetId) || PROVIDER_CONFIG_PRESETS[presetId]
    : null;
  if (presetId && !preset) fail(`providers[${position}].preset is unsupported.`);
  const id = resolveExistingId(provider.id, current, `providers[${position}].id`) ||
    uniqueGeneratedId('provider', occupied, idFactory);
  const previous = current.get(id.toLowerCase());
  const protocol = normalizedProtocol(provider.protocol, previous?.protocol || preset?.protocol);
  const authMode = normalizedAuthMode(
    provider.authMode,
    previous?.authMode || preset?.authMode || (protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'),
  );
  const apiBase = text(
    provider.apiBase ?? previous?.apiBase ?? preset?.apiBase,
    `providers[${position}].apiBase`,
    2_048,
  );
  const presetProviderId = ({
    bailian: 'bailian',
    deepseek: 'deepseek',
    zhipu: 'glm',
    moonshot: 'kimi',
    'custom-openai': 'custom',
    'custom-anthropic': 'custom',
  })[presetId];
  const providerId = String(
    provider.providerId || previous?.providerId || presetProviderId || identifyModelProvider({ apiBase }),
  ).trim().toLowerCase();
  if (!listModelProviders().some((entry) => entry.id === providerId)) {
    fail(`providers[${position}].providerId is unsupported.`);
  }
  const action = secretAction(provider.apiKeyAction, `providers[${position}].apiKeyAction`, {
    isNew: !previous, authMode,
  });
  if (!previous && authMode !== 'none' && action !== 'replace') {
    fail('A new authenticated provider requires a replacement credential.',
      'PROVIDER_CREDENTIAL_REQUIRED');
  }
  if (action === 'keep' && provider.apiKey !== undefined) {
    fail('A kept credential value must be omitted.');
  }
  if (action === 'clear' && provider.apiKey !== undefined) {
    fail('A cleared credential value must be omitted.');
  }
  if (authMode === 'none' && action === 'replace') {
    fail('A provider without authentication cannot store a credential.');
  }
  return {
    connection: {
      id,
      label: text(provider.label ?? previous?.label ?? preset?.label ?? id,
        `providers[${position}].label`, 120),
      providerId,
      protocol,
      apiBase,
      authMode,
      apiKeyAction: authMode === 'none' ? 'clear' : action,
      ...(action === 'replace'
        ? { apiKey: opaqueSecret(provider.apiKey, `providers[${position}].apiKey`) }
        : {}),
    },
    previous,
    preset,
  };
}

function registryModel(raw, connection, preset, existingModels, occupied, idFactory, label) {
  object(raw, label);
  onlyKeys(raw, new Set([
    'id', 'displayName', 'actualModel', 'requestProfile', 'efforts', 'defaultEffort', 'enabled',
    'reasoningMapping',
  ]), label);
  const id = resolveExistingId(raw.id, existingModels, `${label}.id`) ||
    uniqueGeneratedId('model', occupied, idFactory);
  const previous = existingModels.get(id.toLowerCase());
  const efforts = normalizedEfforts(raw.efforts ?? previous?.efforts, `${label}.efforts`);
  const defaultEffort = String(raw.defaultEffort || previous?.defaultEffort || efforts[0])
    .trim().toLowerCase();
  if (!efforts.includes(defaultEffort)) fail(`${label}.defaultEffort is invalid.`);
  const configuredActualModel = modelValue(
    raw.actualModel ?? previous?.actualModel,
    `${label}.actualModel`,
  );
  const provider = resolveModelProvider({
    providerId: connection.providerId,
    apiBase: connection.apiBase,
    protocol: connection.providerId === 'custom' ? connection.protocol : undefined,
    authMode: connection.providerId === 'custom' ? connection.authMode : undefined,
  });
  const actualModel = normalizeProviderModelId(provider, configuredActualModel);
  const reasoning = resolveModelReasoningPolicy(
    provider,
    actualModel,
    raw.reasoningMapping ?? previous?.reasoningMapping,
  );
  return {
    id,
    displayName: text(
      raw.displayName ?? previous?.displayName ?? previous?.label ?? raw.actualModel,
      `${label}.displayName`,
      120,
    ),
    shortLabel: text(
      raw.displayName ?? previous?.shortLabel ?? previous?.label ?? raw.actualModel,
      `${label}.displayName`,
      120,
    ),
    connectionId: connection.id,
    actualModel,
    requestProfile: normalizedProfile(
      raw.requestProfile,
      previous?.requestProfile || preset?.requestProfile,
      connection.protocol,
    ),
    efforts,
    defaultEffort,
    reasoningMapping: structuredClone(reasoning.reasoningMapping),
    enabled: normalizedBoolean(raw.enabled, previous ? previous.enabled !== false : true),
    description: '',
  };
}

export function buildProviderConfigPatch(input, currentSnapshot, options = {}) {
  object(input, 'Provider configuration request');
  object(currentSnapshot, 'Current runtime configuration');
  onlyKeys(input, new Set(['schemaVersion', 'expectedRevision', 'providers', 'defaultModelId']),
    'Provider configuration request');
  if (input.schemaVersion !== SIMPLIFIED_PROVIDER_SCHEMA_VERSION) {
    fail('The provider configuration schema is unsupported.', 'PROVIDER_CONFIG_CLIENT_UPGRADE_REQUIRED', 409);
  }
  assertProviderConfigRevision(input.expectedRevision, currentSnapshot.revision);
  if (!Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > MAX_CONNECTIONS) {
    fail(`providers must contain 1-${MAX_CONNECTIONS} entries.`);
  }
  const currentConnections = new Map((currentSnapshot.connections || [])
    .map((entry) => [String(entry.id || '').toLowerCase(), entry]));
  const currentModels = new Map((currentSnapshot.models || [])
    .map((entry) => [String(entry.id || '').toLowerCase(), entry]));
  const occupiedConnections = new Set(currentConnections.keys());
  const occupiedModels = new Set(currentModels.keys());
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : defaultIdFactory;
  const presetResolver = typeof options.presetResolver === 'function' ? options.presetResolver : null;
  const assignments = { providers: [], models: [] };
  const connections = [];
  const models = [];
  const includedConnections = new Set();
  const includedModels = new Set();
  for (const [providerIndex, rawProvider] of input.providers.entries()) {
    const value = registryConnection(
      rawProvider, currentConnections, occupiedConnections, idFactory, presetResolver, providerIndex,
    );
    const normalizedConnectionId = value.connection.id.toLowerCase();
    if (includedConnections.has(normalizedConnectionId)) fail('A provider internal ID is duplicated.');
    includedConnections.add(normalizedConnectionId);
    connections.push(value.connection);
    if (!rawProvider.id) assignments.providers.push({ index: providerIndex, id: value.connection.id });
    if (!Array.isArray(rawProvider.models) || rawProvider.models.length < 1) {
      fail(`providers[${providerIndex}].models must contain at least one model.`);
    }
    for (const [modelIndex, rawModel] of rawProvider.models.entries()) {
      if (models.length >= MAX_MODELS) fail(`At most ${MAX_MODELS} models may be configured.`);
      const model = registryModel(
        rawModel,
        value.connection,
        value.preset,
        currentModels,
        occupiedModels,
        idFactory,
        `providers[${providerIndex}].models[${modelIndex}]`,
      );
      const normalizedModelId = model.id.toLowerCase();
      if (includedModels.has(normalizedModelId)) fail('A model internal ID is duplicated.');
      includedModels.add(normalizedModelId);
      models.push(model);
      if (!rawModel.id) assignments.models.push({ providerIndex, modelIndex, id: model.id });
    }
  }
  const enabled = models.filter((model) => model.enabled);
  if (enabled.length < 1) fail('At least one model must be enabled.', 'NO_ENABLED_MODEL');
  if (enabled.length > MAX_SIMPLIFIED_ENABLED_MODELS) {
    fail(`At most ${MAX_SIMPLIFIED_ENABLED_MODELS} models may be enabled.`, 'TOO_MANY_ENABLED_MODELS');
  }
  let defaultModelId = String(input.defaultModelId || '').trim();
  if (defaultModelId) {
    defaultModelId = stableId(defaultModelId, 'defaultModelId');
    if (!enabled.some((model) => model.id === defaultModelId)) {
      fail('defaultModelId must identify an enabled submitted model.', 'INVALID_DEFAULT_MODEL');
    }
  } else if (enabled.some((model) => model.id === currentSnapshot.defaultModelId)) {
    defaultModelId = currentSnapshot.defaultModelId;
  } else {
    defaultModelId = enabled[0].id;
  }
  const patch = {
    schemaVersion: 2,
    expectedRevision: input.expectedRevision,
    connections,
    models,
    defaultModelId,
  };
  return {
    patch,
    idAssignments: assignments,
    candidateDigest: providerCandidateDigest(patch),
  };
}

export function assertProviderConfigRevision(expectedRevision, currentRevision) {
  const expected = String(expectedRevision || '').trim();
  const current = String(currentRevision || '').trim();
  if (!expected || !REVISION_PATTERN.test(expected)) {
    fail('expectedRevision is required.', 'PROVIDER_CONFIG_REVISION_REQUIRED');
  }
  if (!current || expected !== current) {
    fail('Provider configuration changed; reload before saving.',
      'PROVIDER_CONFIG_REVISION_CONFLICT', 409);
  }
  return current;
}

function safeEqual(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function validationBinding({ adminId, baseRevision, candidateDigest }) {
  const admin = text(adminId, 'adminId', 256);
  const revision = text(baseRevision, 'baseRevision', 160);
  const digest = String(candidateDigest || '').trim().toLowerCase();
  if (!REVISION_PATTERN.test(revision)) fail('baseRevision is invalid.');
  if (!DIGEST_PATTERN.test(digest)) fail('candidateDigest is invalid.');
  return {
    adminHash: sha256(admin),
    revisionHash: sha256(revision),
    candidateDigest: digest,
  };
}

export class ValidationCredentialStore {
  #entries = new Map();

  #delete(token) {
    const entry = this.#entries.get(token);
    if (entry?.expiryTimer) clearTimeout(entry.expiryTimer);
    return this.#entries.delete(token);
  }

  constructor(options = {}) {
    this.ttlMs = Number.isSafeInteger(options.ttlMs)
      ? Math.min(VALIDATION_CREDENTIAL_TTL_MS, Math.max(1_000, options.ttlMs))
      : VALIDATION_CREDENTIAL_TTL_MS;
    this.maximum = Number.isSafeInteger(options.maximum)
      ? Math.min(MAX_VALIDATION_CREDENTIALS, Math.max(1, options.maximum))
      : MAX_VALIDATION_CREDENTIALS;
    this.clock = typeof options.clock === 'function' ? options.clock : Date.now;
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  }

  get size() {
    this.cleanup();
    return this.#entries.size;
  }

  issue(input = {}) {
    object(input, 'Validation credential');
    if (!plainObject(input.candidate)) fail('candidate must be an object.');
    const candidateDigest = providerCandidateDigest(input.candidate);
    if (
      input.candidateDigest !== undefined &&
      !safeEqual(String(input.candidateDigest).toLowerCase(), candidateDigest)
    ) fail('candidateDigest does not match the staged candidate.');
    const binding = validationBinding({ ...input, candidateDigest });
    this.cleanup();
    while (this.#entries.size >= this.maximum) {
      this.#delete(this.#entries.keys().next().value);
    }
    const token = this.randomBytes(32).toString('base64url');
    const expiresAtMs = this.clock() + this.ttlMs;
    const expiryTimer = setTimeout(() => this.#entries.delete(token), this.ttlMs);
    expiryTimer.unref?.();
    this.#entries.set(token, {
      ...binding,
      baseRevision: String(input.baseRevision).trim(),
      expiresAtMs,
      expiryTimer,
      candidate: structuredClone(input.candidate),
    });
    return Object.freeze({ token, expiresAt: new Date(expiresAtMs).toISOString() });
  }

  claim(input = {}) {
    object(input, 'Validation credential claim');
    const token = text(input.token, 'token', 256);
    const entry = this.#entries.get(token);
    if (!entry) fail('The validation credential is invalid or expired.',
      'VALIDATION_CREDENTIAL_INVALID', 409);
    this.#delete(token);
    if (entry.expiresAtMs <= this.clock()) {
      fail('The validation credential is invalid or expired.', 'VALIDATION_CREDENTIAL_INVALID', 409);
    }
    assertProviderConfigRevision(entry.baseRevision, input.currentRevision);
    const binding = validationBinding({
      ...input,
      baseRevision: input.baseRevision || entry.baseRevision,
      candidateDigest: input.candidateDigest || entry.candidateDigest,
    });
    if (
      !safeEqual(entry.adminHash, binding.adminHash) ||
      !safeEqual(entry.revisionHash, binding.revisionHash) ||
      !safeEqual(entry.candidateDigest, binding.candidateDigest)
    ) {
      fail('The validation credential does not match this configuration.',
        'VALIDATION_CREDENTIAL_MISMATCH', 409);
    }
    return structuredClone(entry.candidate);
  }

  revoke(token) {
    return this.#delete(String(token || ''));
  }

  cleanup() {
    const now = this.clock();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAtMs <= now) this.#delete(token);
    }
  }
}

/**
 * Holds an exact, secret-bearing candidate between card-level checks and the
 * final all-provider validation. A stage can never be used by the commit
 * endpoint; it only prevents already checked connections from being billed a
 * second time. Entries are process-local, administrator/revision-bound, and
 * removed automatically after the same ten-minute window as commit receipts.
 */
export class ProviderValidationStageStore {
  #entries = new Map();

  constructor(options = {}) {
    this.ttlMs = Number.isSafeInteger(options.ttlMs)
      ? Math.min(VALIDATION_CREDENTIAL_TTL_MS, Math.max(1_000, options.ttlMs))
      : VALIDATION_CREDENTIAL_TTL_MS;
    this.maximum = Number.isSafeInteger(options.maximum)
      ? Math.min(MAX_VALIDATION_CREDENTIALS, Math.max(1, options.maximum))
      : MAX_VALIDATION_CREDENTIALS;
    this.clock = typeof options.clock === 'function' ? options.clock : Date.now;
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  }

  #delete(token) {
    const entry = this.#entries.get(token);
    if (entry?.expiryTimer) clearTimeout(entry.expiryTimer);
    return this.#entries.delete(token);
  }

  #entry(input = {}) {
    object(input, 'Provider validation stage');
    const token = text(input.token, 'token', 256);
    const entry = this.#entries.get(token);
    if (!entry || entry.expiresAtMs <= this.clock()) {
      this.#delete(token);
      fail('The provider validation stage is invalid or expired.',
        'PROVIDER_VALIDATION_STAGE_INVALID', 409);
    }
    assertProviderConfigRevision(entry.baseRevision, input.currentRevision);
    const binding = validationBinding({
      adminId: input.adminId,
      baseRevision: entry.baseRevision,
      candidateDigest: entry.candidateDigest,
    });
    if (
      !safeEqual(entry.adminHash, binding.adminHash) ||
      !safeEqual(entry.revisionHash, binding.revisionHash)
    ) {
      fail('The provider validation stage does not match this administrator.',
        'PROVIDER_VALIDATION_STAGE_MISMATCH', 409);
    }
    return { token, entry };
  }

  issue(input = {}) {
    object(input, 'Provider validation stage');
    if (!plainObject(input.candidate)) fail('candidate must be an object.');
    const connectionId = stableId(input.connectionId, 'connectionId');
    const candidateDigest = providerCandidateDigest(input.candidate);
    const binding = validationBinding({ ...input, candidateDigest });
    this.cleanup();
    while (this.#entries.size >= this.maximum) this.#delete(this.#entries.keys().next().value);
    const token = this.randomBytes(32).toString('base64url');
    const expiresAtMs = this.clock() + this.ttlMs;
    const expiryTimer = setTimeout(() => this.#entries.delete(token), this.ttlMs);
    expiryTimer.unref?.();
    this.#entries.set(token, {
      ...binding,
      baseRevision: String(input.baseRevision).trim(),
      candidateDigest,
      candidate: structuredClone(input.candidate),
      connectionIds: new Set([connectionId]),
      expiresAtMs,
      expiryTimer,
    });
    return Object.freeze({ token, expiresAt: new Date(expiresAtMs).toISOString() });
  }

  add(input = {}) {
    const { token, entry } = this.#entry(input);
    entry.connectionIds.add(stableId(input.connectionId, 'connectionId'));
    return Object.freeze({ token, expiresAt: new Date(entry.expiresAtMs).toISOString() });
  }

  resume(input = {}) {
    const { entry } = this.#entry(input);
    return {
      candidate: structuredClone(entry.candidate),
      candidateDigest: entry.candidateDigest,
      connectionIds: [...entry.connectionIds],
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
    };
  }

  revoke(token) {
    return this.#delete(String(token || ''));
  }

  cleanup() {
    const now = this.clock();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAtMs <= now) this.#delete(token);
    }
  }
}
