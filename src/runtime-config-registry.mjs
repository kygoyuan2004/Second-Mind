import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { domainToASCII } from 'node:url';
import { markPublicMessage } from './public-errors.mjs';

import {
  UNIVERSAL_REASONING_EFFORTS,
  identifyModelProvider,
  legacyV2ProviderFields,
  resolveModelReasoningPolicy,
  resolveModelProvider,
  universalReasoningPolicy,
} from './model-provider-registry.mjs';

const REGISTRY_VERSION = 1;
const DYNAMIC_REGISTRY_VERSION = 2;
const MAX_PRIVATE_JSON_BYTES = 1024 * 1024;
const BAILIAN_WEB_SEARCH_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL_VALUE_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,240}$/u;
const MAX_MODEL_CONNECTIONS = 16;
const MAX_DYNAMIC_MODELS = 32;
const MAX_ENABLED_MODELS = 3;
const EFFORTS = new Set(['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PROVIDERS = new Set(['disabled', 'dashscope', 'openai-compatible']);
const MODEL_PROTOCOLS = new Set(['anthropic-messages', 'openai-chat-completions']);
const MODEL_AUTH_MODES = new Set(['x-api-key', 'bearer', 'none']);
const MODEL_REQUEST_PROFILES = new Set([
  'default',
  'anthropic-standard',
  'openai-standard',
  'bailian-openai',
  'deepseek-openai',
  'glm-openai',
  'kimi-openai',
]);
const MODEL_PROVIDER_IDS = new Set(['bailian', 'deepseek', 'glm', 'kimi', 'custom']);
const WEB_SEARCH_PROVIDERS = new Set(['bailian-mcp', 'tavily-rest']);
const SECRET_ACTIONS = new Set(['keep', 'replace', 'clear']);
const LEGACY_DIRECT_MODEL_ALIASES = Object.freeze(new Map([
  ['qwen3.8-max-0902[1M]', 'qwen3.8-max-0902'],
  ['kimi-k3[1M]', 'kimi-k3'],
]));
const MODEL_SLOTS = Object.freeze([
  Object.freeze({
    id: 'qwen',
    actualField: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    nameField: 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    fallbackLabel: 'Qwen',
    defaultEfforts: Object.freeze(['low', 'medium', 'xhigh']),
    defaultEffort: 'xhigh',
  }),
  Object.freeze({
    id: 'kimi',
    actualField: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    nameField: 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
    fallbackLabel: 'Kimi',
    defaultEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    defaultEffort: 'medium',
  }),
  Object.freeze({
    id: 'deepseek',
    actualField: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    nameField: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
    fallbackLabel: 'DeepSeek',
    defaultEfforts: Object.freeze(['high', 'max']),
    defaultEffort: 'high',
  }),
]);
const MODEL_SLOT_IDS = new Set(MODEL_SLOTS.map((slot) => slot.id));

export class RuntimeConfigError extends Error {
  constructor(message, code = 'RUNTIME_CONFIG_ERROR', status = 500, options = {}) {
    super(message, options);
    this.name = 'RuntimeConfigError';
    this.code = code;
    this.status = status;
    markPublicMessage(this);
  }
}

function fail(message, code, status = 500, options = {}) {
  throw new RuntimeConfigError(message, code, status, options);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label, code = 'INVALID_RUNTIME_CONFIG') {
  if (!plainObject(value)) fail(`${label} must be an object.`, code, 400);
  return value;
}

function rejectUnknownKeys(value, allowed, label, code = 'INVALID_RUNTIME_CONFIG') {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains an unsupported field.`, code, 400);
  }
}

function boundedText(value, label, maximum, { required = false } = {}) {
  if (typeof value !== 'string') {
    if (!required && value === undefined) return undefined;
    fail(`${label} must be text.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  const output = value.trim();
  if ((required && !output) || output.length > maximum || /[\u0000-\u001f\u007f]/u.test(output)) {
    fail(`${label} is invalid.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  return output;
}

function modelValue(value, label) {
  const output = boundedText(value, label, 240, { required: true });
  if (!MODEL_VALUE_PATTERN.test(output)) {
    fail(`${label} must be a provider model identifier without whitespace.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  return output;
}

function displayName(value, label, fallback = '') {
  if (value === undefined) return fallback;
  return boundedText(value, label, 120, { required: true });
}

function normalizeBranding(value, defaults = {}) {
  const input = value === undefined ? {} : assertObject(value, 'branding');
  rejectUnknownKeys(input, new Set(['appName', 'vaultLabel']), 'branding');
  return {
    appName: displayName(input.appName, 'branding.appName', defaults.appName || 'Second Mind'),
    vaultLabel: displayName(input.vaultLabel, 'branding.vaultLabel', defaults.vaultLabel || '知识库'),
  };
}

function opaqueSecret(value, label) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (
    output.length < 8 || output.length > 16_384 ||
    /[\s\u0000-\u001f\u007f]/u.test(output)
  ) {
    fail(`${label} must be an opaque 8-16384 character credential without whitespace.`,
      'INVALID_RUNTIME_CONFIG', 400);
  }
  return output;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}.`,
      'INVALID_RUNTIME_CONFIG', 400);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') {
    fail(`${label} must be true or false.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digestJson(value) {
  return sha256(JSON.stringify(value));
}

function safeClone(value) {
  return structuredClone(value);
}

function safeRemoteApiBase(value, label, code) {
  const raw = boundedText(value, label, 2_048, { required: true });
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${label} must be a valid HTTPS URL.`, code, 400);
  }
  const rawHostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const hostname = domainToASCII(rawHostname).toLowerCase().replace(/\.$/u, '');
  if (
    url.protocol !== 'https:' || url.username || url.password ||
    !hostname || isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname.endsWith('.internal') ||
    (url.port && url.port !== '443') || url.search || url.hash
  ) {
    fail(
      `${label} must use HTTPS on a public hostname without credentials, query, fragment, or a nonstandard port.`,
      code,
      400,
    );
  }
  url.hostname = hostname;
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.href.replace(/\/$/u, '');
}

function safeEmbeddingUrl(value) {
  return safeRemoteApiBase(value, 'embedding.apiBase', 'INVALID_EMBEDDING_URL');
}

function safeModelApiBase(value, label = 'connection.apiBase') {
  return safeRemoteApiBase(value, label, 'INVALID_MODEL_PROVIDER_URL');
}

function normalizeEfforts(input, slot) {
  const source = input === undefined ? slot.defaultEfforts : input;
  if (!Array.isArray(source) || source.length < 1 || source.length > EFFORTS.size) {
    fail(`models.${slot.id}.efforts is invalid.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  const efforts = [...new Set(source.map((entry) => String(entry || '').trim().toLowerCase()))];
  if (!efforts.length || efforts.some((entry) => !EFFORTS.has(entry))) {
    fail(`models.${slot.id}.efforts is invalid.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  return efforts;
}

function normalizeDefaultModels(modelCatalog = []) {
  if (!Array.isArray(modelCatalog) || modelCatalog.length > MAX_DYNAMIC_MODELS) {
    fail('modelCatalog defaults must be an array.', 'INVALID_RUNTIME_CONFIG', 500);
  }
  const ids = new Set();
  return modelCatalog.map((input, position) => {
    if (!plainObject(input)) {
      fail(`modelCatalog[${position}] must be an object.`, 'INVALID_RUNTIME_CONFIG', 500);
    }
    const id = String(input.id || '').trim();
    const normalizedId = id.toLowerCase();
    if (!MODEL_ID_PATTERN.test(id) || ids.has(normalizedId)) {
      fail(`modelCatalog[${position}].id is invalid or duplicated.`,
        'INVALID_RUNTIME_CONFIG', 500);
    }
    ids.add(normalizedId);
    const knownSlot = MODEL_SLOTS.find((entry) => entry.id === id);
    const slot = knownSlot || {
      id,
      fallbackLabel: id,
      defaultEfforts: Object.freeze(['default']),
      defaultEffort: 'default',
    };
    const actualModel = input.actualModel === undefined
      ? ''
      : modelValue(input.actualModel, `models.${slot.id}.actualModel`);
    const efforts = normalizeEfforts(input.efforts, slot);
    const defaultEffort = String(input.defaultEffort || slot.defaultEffort).trim().toLowerCase();
    if (!efforts.includes(defaultEffort)) {
      fail(`models.${slot.id}.defaultEffort is invalid.`, 'INVALID_RUNTIME_CONFIG', 500);
    }
    return {
      id: slot.id,
      label: displayName(input.label, `models.${slot.id}.label`, slot.fallbackLabel),
      shortLabel: displayName(
        input.shortLabel,
        `models.${slot.id}.shortLabel`,
        input.label || slot.fallbackLabel,
      ),
      actualModel,
      provider: boundedText(input.provider, `models.${slot.id}.provider`, 80) || 'anthropic',
      efforts,
      defaultEffort,
      available: input.available !== false,
      capabilityVerified: input.capabilityVerified !== false,
      description: displayName(input.description, `models.${slot.id}.description`, ''),
    };
  });
}

function extractClaudeModelOverrides(settings) {
  assertObject(settings, 'Claude settings');
  const env = settings.env === undefined ? {} : assertObject(settings.env, 'Claude settings.env');
  const models = {};
  for (const slot of MODEL_SLOTS) {
    const hasActual = Object.hasOwn(env, slot.actualField);
    const hasName = Object.hasOwn(env, slot.nameField);
    if (!hasActual && !hasName) continue;
    if (!hasActual) {
      fail(`${slot.actualField} is required when its display name is set.`,
        'INVALID_CLAUDE_SETTINGS', 500);
    }
    const actualModel = modelValue(env[slot.actualField], slot.actualField);
    const label = hasName
      ? displayName(env[slot.nameField], slot.nameField)
      : actualModel;
    models[slot.id] = { actualModel, displayName: label };
  }
  return models;
}

function normalizeManagedModel(value, id) {
  const slot = MODEL_SLOTS.find((entry) => entry.id === id);
  assertObject(value, `models.${id}`);
  rejectUnknownKeys(
    value,
    new Set(['actualModel', 'displayName', 'efforts', 'defaultEffort']),
    `models.${id}`,
  );
  if (!Object.hasOwn(value, 'actualModel')) {
    fail(`models.${id}.actualModel is required.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  const output = {
    actualModel: modelValue(value.actualModel, `models.${id}.actualModel`),
    ...(Object.hasOwn(value, 'displayName')
      ? { displayName: displayName(value.displayName, `models.${id}.displayName`) }
      : {}),
  };
  if (Object.hasOwn(value, 'efforts')) output.efforts = normalizeEfforts(value.efforts, slot);
  if (Object.hasOwn(value, 'defaultEffort')) {
    output.defaultEffort = String(value.defaultEffort || '').trim().toLowerCase();
    const efforts = output.efforts || slot.defaultEfforts;
    if (!efforts.includes(output.defaultEffort)) {
      fail(`models.${id}.defaultEffort must occur in efforts.`,
        'INVALID_RUNTIME_CONFIG', 400);
    }
  }
  return output;
}

function normalizeManagedModels(value) {
  if (value === undefined) return {};
  assertObject(value, 'models');
  const output = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!MODEL_SLOT_IDS.has(id)) {
      fail('models contains an unsupported stable slot.', 'INVALID_RUNTIME_CONFIG', 400);
    }
    output[id] = normalizeManagedModel(entry, id);
  }
  return output;
}

function normalizeManagedEmbedding(value) {
  if (value === undefined) return {};
  assertObject(value, 'embedding');
  rejectUnknownKeys(
    value,
    new Set(['provider', 'apiBase', 'apiKey', 'model', 'dimensions']),
    'embedding',
  );
  const output = {};
  if (Object.hasOwn(value, 'provider')) {
    const provider = String(value.provider || '').trim().toLowerCase();
    if (!PROVIDERS.has(provider)) {
      fail('embedding.provider is unsupported.', 'INVALID_RUNTIME_CONFIG', 400);
    }
    output.provider = provider;
  }
  if (Object.hasOwn(value, 'apiBase')) output.apiBase = safeEmbeddingUrl(value.apiBase);
  if (Object.hasOwn(value, 'apiKey')) {
    output.apiKey = value.apiKey === null ? null : opaqueSecret(value.apiKey, 'embedding.apiKey');
  }
  if (Object.hasOwn(value, 'model')) output.model = modelValue(value.model, 'embedding.model');
  if (Object.hasOwn(value, 'dimensions')) {
    output.dimensions = integer(value.dimensions, 'embedding.dimensions', 8, 32_768);
  }
  return output;
}

function normalizeManagedWebSearch(value) {
  if (value === undefined) return {};
  assertObject(value, 'webSearch');
  rejectUnknownKeys(value, new Set(['enabled', 'apiKey']), 'webSearch');
  const output = {};
  if (Object.hasOwn(value, 'enabled')) output.enabled = boolean(value.enabled, 'webSearch.enabled');
  if (Object.hasOwn(value, 'apiKey')) {
    output.apiKey = value.apiKey === null ? null : opaqueSecret(value.apiKey, 'webSearch.apiKey');
  }
  return output;
}

function normalizeDynamicEfforts(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > EFFORTS.size) {
    fail(`${label} is invalid.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  const efforts = [...new Set(value.map((entry) => String(entry || '').trim().toLowerCase()))];
  if (!efforts.length || efforts.some((entry) => !EFFORTS.has(entry))) {
    fail(`${label} is invalid.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  return efforts;
}

function normalizeManagedConnection(value, position) {
  assertObject(value, `connections[${position}]`);
  rejectUnknownKeys(
    value,
    new Set(['id', 'label', 'providerId', 'protocol', 'apiBase', 'authMode', 'apiKey']),
    `connections[${position}]`,
  );
  const id = boundedText(value.id, `connections[${position}].id`, 64, { required: true });
  if (!MODEL_ID_PATTERN.test(id)) {
    fail(`connections[${position}].id is invalid.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  const protocol = String(value.protocol || '').trim().toLowerCase();
  if (!MODEL_PROTOCOLS.has(protocol)) {
    fail(`connections[${position}].protocol is unsupported.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  const authMode = String(value.authMode || (
    protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'
  )).trim().toLowerCase();
  if (!MODEL_AUTH_MODES.has(authMode)) {
    fail(`connections[${position}].authMode is unsupported.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  const apiKey = value.apiKey === null || value.apiKey === undefined || value.apiKey === ''
    ? ''
    : opaqueSecret(value.apiKey, `connections[${position}].apiKey`);
  if (authMode === 'none' && apiKey) {
    fail(`connections[${position}] cannot store a credential with authMode none.`,
      'INVALID_RUNTIME_CONFIG', 400);
  }
  const apiBase = safeModelApiBase(value.apiBase, `connections[${position}].apiBase`);
  const requestedProviderId = String(value.providerId || '').trim().toLowerCase();
  if (requestedProviderId && !MODEL_PROVIDER_IDS.has(requestedProviderId)) {
    fail(`connections[${position}].providerId is unsupported.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  return {
    id,
    label: displayName(value.label, `connections[${position}].label`, id),
    // Persist the selected adapter. Hostname inference is only a compatibility
    // fallback for older v2 files; a compatible proxy must not silently turn
    // an explicitly selected official provider into Custom after a reload.
    providerId: requestedProviderId || identifyModelProvider({ apiBase }),
    protocol,
    apiBase,
    authMode,
    apiKey,
  };
}

function normalizeManagedConnections(value) {
  if (!Array.isArray(value) || value.length > MAX_MODEL_CONNECTIONS) {
    fail(`connections must contain 0-${MAX_MODEL_CONNECTIONS} entries.`,
      'INVALID_RUNTIME_CONFIG', 400);
  }
  const ids = new Set();
  return value.map((entry, position) => {
    const connection = normalizeManagedConnection(entry, position);
    const key = connection.id.toLowerCase();
    if (ids.has(key)) fail('Connection IDs must be unique.', 'INVALID_RUNTIME_CONFIG', 400);
    ids.add(key);
    return connection;
  });
}

function normalizeDynamicModel(value, position, connectionsById) {
  assertObject(value, `models[${position}]`);
  rejectUnknownKeys(
    value,
    new Set([
      'id', 'displayName', 'shortLabel', 'connectionId', 'actualModel', 'requestProfile',
      'efforts', 'defaultEffort', 'enabled', 'description', 'reasoningMapping',
    ]),
    `models[${position}]`,
  );
  const id = boundedText(value.id, `models[${position}].id`, 64, { required: true });
  if (!MODEL_ID_PATTERN.test(id)) {
    fail(`models[${position}].id is invalid.`, 'INVALID_RUNTIME_CONFIG', 400);
  }
  const requestedConnectionId = boundedText(
    value.connectionId,
    `models[${position}].connectionId`,
    64,
    { required: true },
  );
  const connection = connectionsById.get(requestedConnectionId.toLowerCase());
  const connectionId = connection?.id;
  if (!connection) {
    fail(`models[${position}] references an unknown connection.`,
      'INVALID_RUNTIME_CONFIG', 400);
  }
  const requestProfile = String(value.requestProfile || '').trim().toLowerCase();
  if (!MODEL_REQUEST_PROFILES.has(requestProfile)) {
    fail(`models[${position}].requestProfile is unsupported.`,
      'INVALID_RUNTIME_CONFIG', 400);
  }
  const efforts = normalizeDynamicEfforts(value.efforts, `models[${position}].efforts`);
  const defaultEffort = String(value.defaultEffort || '').trim().toLowerCase();
  if (!efforts.includes(defaultEffort)) {
    fail(`models[${position}].defaultEffort must occur in efforts.`,
      'INVALID_RUNTIME_CONFIG', 400);
  }
  const actualModel = modelValue(value.actualModel, `models[${position}].actualModel`);
  let reasoningMapping;
  try {
    const adapter = resolveModelProvider({
      providerId: connection.providerId || identifyModelProvider(connection),
      apiBase: connection.apiBase,
      protocol: connection.providerId === 'custom' ? connection.protocol : undefined,
      authMode: connection.providerId === 'custom' ? connection.authMode : undefined,
    });
    reasoningMapping = resolveModelReasoningPolicy(
      adapter,
      actualModel,
      value.reasoningMapping,
    ).reasoningMapping;
  } catch (cause) {
    fail(`models[${position}].reasoningMapping is invalid.`,
      'INVALID_RUNTIME_CONFIG', 400, { cause });
  }
  return {
    id,
    displayName: displayName(value.displayName, `models[${position}].displayName`, id),
    shortLabel: displayName(
      value.shortLabel,
      `models[${position}].shortLabel`,
      value.displayName || id,
    ),
    connectionId,
    actualModel,
    requestProfile,
    efforts,
    defaultEffort,
    enabled: value.enabled !== false,
    description: boundedText(value.description, `models[${position}].description`, 500) || '',
    reasoningMapping,
  };
}

function normalizeDynamicModels(value, connections) {
  if (!Array.isArray(value) || value.length > MAX_DYNAMIC_MODELS) {
    fail(`models must contain 0-${MAX_DYNAMIC_MODELS} entries.`,
      'INVALID_RUNTIME_CONFIG', 400);
  }
  const connectionsById = new Map(connections.map((entry) => [entry.id.toLowerCase(), entry]));
  const ids = new Set();
  const models = value.map((entry, position) => {
    const model = normalizeDynamicModel(entry, position, connectionsById);
    const key = model.id.toLowerCase();
    if (ids.has(key)) fail('Model IDs must be unique.', 'INVALID_RUNTIME_CONFIG', 400);
    ids.add(key);
    return model;
  });
  if (models.length && !models.some((model) => model.enabled)) {
    fail('At least one model must be enabled.', 'INVALID_RUNTIME_CONFIG', 400);
  }
  if (models.filter((model) => model.enabled).length > MAX_ENABLED_MODELS) {
    fail(`At most ${MAX_ENABLED_MODELS} models may be enabled.`,
      'TOO_MANY_ENABLED_MODELS', 400);
  }
  return models;
}

function normalizeManagedWebSearchProvider(value, id) {
  const input = value === undefined ? {} : assertObject(value, `webSearch.providers.${id}`);
  rejectUnknownKeys(
    input,
    new Set(['apiKey', 'extractFallbackEnabled']),
    `webSearch.providers.${id}`,
  );
  return {
    apiKey: input.apiKey === null || input.apiKey === undefined || input.apiKey === ''
      ? ''
      : opaqueSecret(input.apiKey, `webSearch.providers.${id}.apiKey`),
    extractFallbackEnabled: input.extractFallbackEnabled === true,
  };
}

function normalizeManagedWebSearchV2(value) {
  const input = value === undefined ? {} : assertObject(value, 'webSearch');
  rejectUnknownKeys(input, new Set(['enabled', 'provider', 'providers']), 'webSearch');
  const provider = String(input.provider || 'bailian-mcp').trim().toLowerCase();
  if (!WEB_SEARCH_PROVIDERS.has(provider)) {
    fail('webSearch.provider is unsupported.', 'INVALID_RUNTIME_CONFIG', 400);
  }
  const providers = input.providers === undefined
    ? {}
    : assertObject(input.providers, 'webSearch.providers');
  rejectUnknownKeys(providers, WEB_SEARCH_PROVIDERS, 'webSearch.providers');
  return {
    enabled: input.enabled === true,
    provider,
    providers: Object.fromEntries([...WEB_SEARCH_PROVIDERS].map((id) => [
      id,
      normalizeManagedWebSearchProvider(providers[id], id),
    ])),
  };
}

function normalizeManagedDocumentV2(value) {
  assertObject(value, 'Managed runtime configuration');
  rejectUnknownKeys(
    value,
    new Set([
      'version', 'revision', 'updatedAt', 'connections', 'models', 'defaultModelId',
      'embedding', 'webSearch', 'branding',
    ]),
    'Managed runtime configuration',
  );
  const revision = boundedText(value.revision, 'revision', 128, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(revision)) {
    fail('Managed runtime configuration revision is invalid.', 'INVALID_RUNTIME_CONFIG', 400);
  }
  const explicitProviderConnections = new Set((Array.isArray(value.connections) ? value.connections : [])
    .filter((entry) => entry && Object.hasOwn(entry, 'providerId'))
    .map((entry) => String(entry.id || '').toLowerCase()));
  const connections = normalizeManagedConnections(value.connections);
  const models = normalizeDynamicModels(value.models, connections);
  const connectionById = new Map(connections.map((entry) => [entry.id, entry]));
  const registeredByConnectionId = new Map(connections.map((connection) => {
    let registered;
    try {
      registered = legacyV2ProviderFields({
        providerId: connection.providerId,
        apiBase: connection.apiBase,
        protocol: connection.protocol,
        authMode: connection.authMode,
      });
    } catch (cause) {
      fail(`connections.${connection.id} conflicts with its registered provider.`,
        'INVALID_RUNTIME_CONFIG', 400, { cause });
    }
    return [connection.id, registered];
  }));
  for (const model of models) {
    const connection = connectionById.get(model.connectionId);
    const connectionRegistration = registeredByConnectionId.get(model.connectionId);
    const registered = legacyV2ProviderFields({
      providerId: connection.providerId,
      apiBase: connection.apiBase,
      protocol: connection.protocol,
      authMode: connection.authMode,
      actualModel: model.actualModel,
    });
    // Claude Code model aliases are not valid direct DashScope model IDs. Only
    // repair the two exact aliases imported by older 8788 launchers, and only
    // on the official DashScope Anthropic gateway. Arbitrary Custom Provider
    // identifiers (including identifiers containing brackets) remain intact.
    let connectionUrl;
    try { connectionUrl = new URL(connection.apiBase); } catch {}
    const isImportedDashScopeAnthropic = connection.protocol === 'anthropic-messages' &&
      connectionUrl?.hostname === 'dashscope.aliyuncs.com' &&
      /^\/apps\/anthropic(?:\/|$)/u.test(connectionUrl.pathname);
    const legacyReplacement = LEGACY_DIRECT_MODEL_ALIASES.get(model.actualModel);
    if (isImportedDashScopeAnthropic && legacyReplacement) model.actualModel = legacyReplacement;
    const expectedEfforts = JSON.stringify(registered.efforts);
    let submittedEfforts = JSON.stringify(model.efforts);
    // Runtime/public snapshots expose the five stable application tiers. The
    // private v2 document retains the provider-native vocabulary so older
    // files remain readable and vendor fields cannot be hand-wired. Updates
    // built from a public snapshot are therefore canonicalized back to the
    // registry-owned native policy before the strict comparison below.
    if (submittedEfforts === JSON.stringify(UNIVERSAL_REASONING_EFFORTS)) {
      model.efforts = [...registered.efforts];
      model.defaultEffort = registered.defaultEffort;
      submittedEfforts = expectedEfforts;
    }
    const providerPolicyMismatch = model.requestProfile !== registered.requestProfile ||
      submittedEfforts !== expectedEfforts || model.defaultEffort !== registered.defaultEffort;
    if (providerPolicyMismatch) {
      const exactKimiK3RegistryUpgrade = connection.providerId === 'kimi' &&
        connection.protocol === 'openai-chat-completions' &&
        /^kimi-k3(?:-|$)/u.test(model.actualModel.toLowerCase()) &&
        model.requestProfile === 'default' && submittedEfforts === JSON.stringify(['default']) &&
        model.defaultEffort === 'default';
      // Files written before providerId existed are upgraded fail-safe to the
      // registry-owned profile. Once an adapter identity is persisted, neither
      // the compatibility API nor a hand edit may cross-wire vendor fields.
      if (explicitProviderConnections.has(connection.id.toLowerCase()) && !exactKimiK3RegistryUpgrade) {
        fail(`models.${model.id} has request settings that conflict with its registered provider.`,
          'INVALID_RUNTIME_CONFIG', 400);
      }
      model.requestProfile = registered.requestProfile;
      model.efforts = [...registered.efforts];
      model.defaultEffort = registered.defaultEffort;
    }
    // Keep the earlier connection-level registration live so a future change
    // cannot accidentally remove protocol/auth validation as dead code.
    if (!connectionRegistration) {
      fail(`models.${model.id} has no registered provider.`, 'INVALID_RUNTIME_CONFIG', 400);
    }
    const anthropicProfile = model.requestProfile === 'anthropic-standard';
    const openAiSpecificProfile = [
      'openai-standard', 'bailian-openai', 'deepseek-openai', 'glm-openai', 'kimi-openai',
    ].includes(model.requestProfile);
    if (
      (anthropicProfile && connection.protocol !== 'anthropic-messages') ||
      (openAiSpecificProfile && connection.protocol !== 'openai-chat-completions')
    ) {
      fail(`models.${model.id}.requestProfile does not match its connection protocol.`,
        'INVALID_RUNTIME_CONFIG', 400);
    }
    if (model.enabled && connection.authMode !== 'none' && !connection.apiKey) {
      fail(`models.${model.id} uses a connection without a credential.`,
        'INVALID_RUNTIME_CONFIG', 400);
    }
  }
  const defaultModelId = boundedText(
    value.defaultModelId ?? '',
    'defaultModelId',
    64,
  ) || '';
  if (models.length && !models.some((model) => model.id === defaultModelId && model.enabled)) {
    fail('defaultModelId must reference an enabled model.', 'INVALID_RUNTIME_CONFIG', 400);
  }
  if (!models.length && defaultModelId) {
    fail('defaultModelId must be empty when no model is configured.',
      'INVALID_RUNTIME_CONFIG', 400);
  }
  return {
    version: DYNAMIC_REGISTRY_VERSION,
    revision,
    updatedAt: boundedText(value.updatedAt, 'updatedAt', 80, { required: true }),
    connections,
    models,
    defaultModelId,
    branding: value.branding === undefined ? {} : normalizeBranding(value.branding),
    embedding: normalizeManagedEmbedding(value.embedding),
    webSearch: normalizeManagedWebSearchV2(value.webSearch),
  };
}

function normalizeManagedDocument(value) {
  assertObject(value, 'Managed runtime configuration');
  if (value.version === DYNAMIC_REGISTRY_VERSION) return normalizeManagedDocumentV2(value);
  rejectUnknownKeys(
    value,
    new Set(['version', 'revision', 'updatedAt', 'models', 'embedding', 'webSearch']),
    'Managed runtime configuration',
  );
  if (value.version !== REGISTRY_VERSION) {
    fail('Managed runtime configuration has an unsupported version.',
      'INVALID_RUNTIME_CONFIG', 400);
  }
  const revision = boundedText(value.revision, 'revision', 128, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(revision)) {
    fail('Managed runtime configuration revision is invalid.', 'INVALID_RUNTIME_CONFIG', 400);
  }
  return {
    version: REGISTRY_VERSION,
    revision,
    updatedAt: boundedText(value.updatedAt, 'updatedAt', 80, { required: true }),
    models: normalizeManagedModels(value.models),
    embedding: normalizeManagedEmbedding(value.embedding),
    webSearch: normalizeManagedWebSearch(value.webSearch),
  };
}

function normalizeEmbeddingDefaults(value = {}) {
  const source = plainObject(value) ? value : {};
  const provider = String(source.provider || 'disabled').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
    fail('Default embedding provider is unsupported.', 'INVALID_RUNTIME_CONFIG', 500);
  }
  const output = {
    provider,
    apiBase: '',
    apiKey: String(source.apiKey || '').trim(),
    model: String(source.model || '').trim(),
    dimensions: Number.isSafeInteger(source.dimensions) ? source.dimensions : 1_024,
  };
  if (provider !== 'disabled' && source.apiBase) output.apiBase = safeEmbeddingUrl(source.apiBase);
  if (output.apiKey) opaqueSecret(output.apiKey, 'embedding.apiKey');
  if (output.model) output.model = modelValue(output.model, 'embedding.model');
  integer(output.dimensions, 'embedding.dimensions', 8, 32_768);
  return output;
}

function normalizeWebSearchDefaults(value = {}) {
  const source = plainObject(value) ? value : {};
  const apiKey = String(source.apiKey || '').trim();
  if (apiKey) opaqueSecret(apiKey, 'webSearch.apiKey');
  return {
    provider: 'bailian-mcp',
    endpoint: BAILIAN_WEB_SEARCH_ENDPOINT,
    enabled: source.enabled === true,
    apiKey,
  };
}

function resolveModels(defaults, settingsModels, managedModels) {
  const models = defaults.map((entry) => ({ ...entry, efforts: [...entry.efforts] }));
  for (const model of models) {
    const settings = settingsModels[model.id];
    const managed = managedModels[model.id];
    const selected = managed || settings;
    if (selected) {
      model.actualModel = selected.actualModel;
      model.label = selected.displayName || model.label || selected.actualModel;
      model.shortLabel = selected.displayName || model.shortLabel || model.label;
    }
    if (managed?.efforts) model.efforts = [...managed.efforts];
    if (managed?.defaultEffort) model.defaultEffort = managed.defaultEffort;
    if (!model.efforts.includes(model.defaultEffort)) {
      fail(`The configured default effort for ${model.id} is unsupported.`,
        'INVALID_MODEL_CATALOG', 500);
    }
    const effortPolicy = universalReasoningPolicy({
      efforts: model.efforts,
      defaultEffort: model.defaultEffort,
    });
    model.efforts = [...effortPolicy.efforts];
    model.defaultEffort = effortPolicy.defaultEffort;
    model.effortMapping = { ...effortPolicy.effortMapping };
    model.configurationSource = managed ? 'managed' : settings ? 'settings' : 'default';
    model.inherited = !managed;
    if (!model.actualModel) {
      fail(`No actual model is configured for the ${model.id} slot.`,
        'INCOMPLETE_MODEL_CATALOG', 500);
    }
  }
  const actualModels = new Set();
  for (const model of models) {
    const key = model.actualModel.toLowerCase();
    if (actualModels.has(key)) {
      fail('Actual model identifiers must be unique across stable slots.',
        'INVALID_MODEL_CATALOG', 500);
    }
    actualModels.add(key);
  }
  return models;
}

function normalizeLlmDefaults(value = {}) {
  const source = plainObject(value) ? value : {};
  const protocol = String(source.protocol || (
    String(source.provider || '').toLowerCase() === 'anthropic'
      ? 'anthropic-messages'
      : 'openai-chat-completions'
  )).trim().toLowerCase();
  if (!MODEL_PROTOCOLS.has(protocol)) {
    fail('Default model protocol is unsupported.', 'INVALID_RUNTIME_CONFIG', 500);
  }
  const apiBase = source.apiBase
    ? safeModelApiBase(source.apiBase, 'llm.apiBase')
    : 'https://provider.invalid';
  const apiKey = String(source.apiKey || '').trim();
  if (apiKey) opaqueSecret(apiKey, 'llm.apiKey');
  const authMode = String(source.authMode || (
    protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'
  )).trim().toLowerCase();
  if (!MODEL_AUTH_MODES.has(authMode)) {
    fail('Default model authentication mode is unsupported.', 'INVALID_RUNTIME_CONFIG', 500);
  }
  return {
    id: 'default-provider',
    label: String(source.providerLabel || source.provider || 'Imported provider').slice(0, 120),
    protocol,
    apiBase,
    authMode,
    apiKey,
    temperature: Number.isFinite(source.temperature) ? source.temperature : null,
    maxOutputTokens: Math.max(1, Number(source.maxOutputTokens) || 131_072),
    timeoutMs: Math.max(1_000, Number(source.timeoutMs) || 600_000),
  };
}

function dynamicDefaultsFromLegacy(models, llm) {
  const requestProfile = llm.protocol === 'anthropic-messages'
    ? 'anthropic-standard'
    : 'openai-standard';
  return {
    connections: models.length ? [{
      id: llm.id,
      label: llm.label,
      protocol: llm.protocol,
      apiBase: llm.apiBase,
      authMode: llm.authMode,
      apiKey: llm.apiKey,
    }] : [],
    models: models.map((model) => ({
      id: model.id,
      displayName: model.label,
      shortLabel: model.shortLabel,
      connectionId: llm.id,
      actualModel: model.actualModel,
      requestProfile,
      efforts: [...model.efforts],
      defaultEffort: model.defaultEffort,
      enabled: model.available !== false,
      description: model.description || '',
    })),
    defaultModelId: models.find((model) => model.available !== false)?.id || models[0]?.id || '',
  };
}

function connectionBindingRevision(connection, model) {
  let effortMapping = model.effortMapping || null;
  try {
    const adapter = resolveModelProvider({
      providerId: connection.providerId || identifyModelProvider(connection),
      apiBase: connection.apiBase,
      protocol: connection.protocol,
      authMode: connection.authMode,
    });
    effortMapping = resolveModelReasoningPolicy(
      adapter,
      model.actualModel,
      model.reasoningMapping,
    ).effortMapping;
  } catch {
    effortMapping = universalReasoningPolicy({
      efforts: model.efforts,
      defaultEffort: model.defaultEffort,
    }).effortMapping;
  }
  return digestJson({
    connectionId: connection.id,
    providerId: connection.providerId,
    protocol: connection.protocol,
    apiBase: connection.apiBase,
    authMode: connection.authMode,
    requestProfile: model.requestProfile,
    actualModel: model.actualModel,
    effortMapping,
    reasoningMapping: model.reasoningMapping || { mode: 'auto' },
  });
}

function resolveDynamicModels(managed) {
  const connections = new Map(managed.connections.map((entry) => [entry.id, entry]));
  return managed.models.map((model) => {
    const connection = connections.get(model.connectionId);
    let effortPolicy;
    try {
      const adapter = resolveModelProvider({
        providerId: connection.providerId || identifyModelProvider(connection),
        apiBase: connection.apiBase,
        protocol: connection.protocol,
        authMode: connection.authMode,
      });
      effortPolicy = resolveModelReasoningPolicy(
        adapter,
        model.actualModel,
        model.reasoningMapping,
      );
    } catch {
      effortPolicy = universalReasoningPolicy({
        efforts: model.efforts,
        defaultEffort: model.defaultEffort,
      });
    }
    const available = model.enabled === true && Boolean(
      connection && connection.apiBase && (connection.authMode === 'none' || connection.apiKey)
    );
    return {
      id: model.id,
      label: model.displayName,
      shortLabel: model.shortLabel || model.displayName,
      actualModel: model.actualModel,
      provider: model.connectionId,
      connectionId: model.connectionId,
      requestProfile: model.requestProfile,
      efforts: [...effortPolicy.efforts],
      defaultEffort: effortPolicy.defaultEffort,
      effortMapping: { ...effortPolicy.effortMapping },
      automaticEffortMapping: {
        ...(effortPolicy.automaticEffortMapping || effortPolicy.effortMapping),
      },
      nativeEfforts: [...(effortPolicy.nativeEfforts || [])],
      reasoningMapping: structuredClone(
        effortPolicy.reasoningMapping || { mode: 'auto' },
      ),
      available,
      enabled: model.enabled === true,
      capabilityVerified: available,
      bindingRevision: connectionBindingRevision(connection, model),
      description: model.description || '',
      configurationSource: 'managed',
      inherited: false,
    };
  });
}

function resolveDynamicWebSearch(managed) {
  const providerConfigs = {
    'bailian-mcp': {
      provider: 'bailian-mcp',
      endpoint: BAILIAN_WEB_SEARCH_ENDPOINT,
      apiKey: managed.providers['bailian-mcp'].apiKey || '',
      extractFallbackEnabled: managed.providers['bailian-mcp'].extractFallbackEnabled === true,
    },
    'tavily-rest': {
      provider: 'tavily-rest',
      endpoint: TAVILY_SEARCH_ENDPOINT,
      extractEndpoint: TAVILY_EXTRACT_ENDPOINT,
      apiKey: managed.providers['tavily-rest'].apiKey || '',
      extractFallbackEnabled: managed.providers['tavily-rest'].extractFallbackEnabled === true,
    },
  };
  const active = providerConfigs[managed.provider];
  return {
    enabled: managed.enabled === true,
    provider: managed.provider,
    endpoint: active.endpoint,
    extractEndpoint: active.extractEndpoint || '',
    apiKey: active.apiKey,
    extractFallbackEnabled: active.extractFallbackEnabled,
    providerConfigs,
    bindingRevision: digestJson({
      provider: managed.provider,
      extractFallbackEnabled: active.extractFallbackEnabled,
    }),
  };
}

function snapshotFromDynamicManaged(managed, defaults) {
  const connections = managed.connections.map((entry) => ({ ...entry }));
  const models = resolveDynamicModels(managed);
  const embedding = resolveEmbedding(defaults.embedding, managed.embedding);
  const webSearch = resolveDynamicWebSearch(managed.webSearch);
  const branding = normalizeBranding(managed.branding, defaults.branding);
  const catalogDescriptor = {
    defaultModelId: managed.defaultModelId,
    connections: connections.map(({ apiKey: _secret, ...connection }) => connection),
    models: models.map(({ configurationSource, inherited, ...model }) => model),
  };
  const modelCatalogRevision = digestJson(catalogDescriptor);
  return {
    version: DYNAMIC_REGISTRY_VERSION,
    revision: digestJson({
      version: DYNAMIC_REGISTRY_VERSION,
      managedRevision: managed.revision,
      modelCatalogRevision,
      embedding: {
        provider: embedding.provider,
        apiBase: embedding.apiBase,
        model: embedding.model,
        dimensions: embedding.dimensions,
        apiKeyConfigured: Boolean(embedding.apiKey),
      },
      webSearch: {
        provider: webSearch.provider,
        enabled: webSearch.enabled,
        bindingRevision: webSearch.bindingRevision,
        providerCredentials: Object.fromEntries(Object.entries(webSearch.providerConfigs)
          .map(([id, entry]) => [id, Boolean(entry.apiKey)])),
      },
      branding,
    }),
    modelCatalogRevision,
    stale: false,
    defaultModelId: managed.defaultModelId,
    connections,
    models,
    embedding,
    webSearch,
    branding,
  };
}

function resolveEmbedding(defaults, managed) {
  const managedProvider = Object.hasOwn(managed, 'provider') ? managed.provider : defaults.provider;
  const managedApiBase = Object.hasOwn(managed, 'apiBase') ? managed.apiBase : defaults.apiBase;
  const transportDiffersFromDefault = managedProvider !== defaults.provider ||
    managedApiBase !== defaults.apiBase;
  if (
    managedProvider !== 'disabled' && transportDiffersFromDefault &&
    !Object.hasOwn(managed, 'apiKey')
  ) {
    fail(
      'A managed Embedding provider or API Base must carry an explicitly replaced or cleared credential.',
      'EMBEDDING_CREDENTIAL_REPLACEMENT_REQUIRED',
      400,
    );
  }
  const resolved = { ...defaults };
  for (const key of ['provider', 'apiBase', 'apiKey', 'model', 'dimensions']) {
    if (Object.hasOwn(managed, key)) resolved[key] = managed[key] ?? '';
  }
  if (resolved.apiBase) resolved.apiBase = safeEmbeddingUrl(resolved.apiBase);
  if (resolved.model) resolved.model = modelValue(resolved.model, 'embedding.model');
  if (resolved.apiKey) opaqueSecret(resolved.apiKey, 'embedding.apiKey');
  integer(resolved.dimensions, 'embedding.dimensions', 8, 32_768);
  return resolved;
}

function assertEmbeddingUpdateCredentialBoundary(current, next, patch) {
  if (!patch || patch.inherit === true || next.provider === 'disabled') return;
  const transportChanged = current.provider !== next.provider || current.apiBase !== next.apiBase;
  if (!transportChanged) return;
  const action = String(patch.apiKeyAction || '').trim().toLowerCase();
  if (!['replace', 'clear'].includes(action)) {
    fail(
      'Changing the Embedding provider or API Base requires replacing or clearing its credential in the same update.',
      'EMBEDDING_CREDENTIAL_REPLACEMENT_REQUIRED',
      400,
    );
  }
}

function resolveWebSearch(defaults, managed) {
  return {
    provider: 'bailian-mcp',
    endpoint: BAILIAN_WEB_SEARCH_ENDPOINT,
    enabled: Object.hasOwn(managed, 'enabled') ? managed.enabled : defaults.enabled,
    apiKey: Object.hasOwn(managed, 'apiKey') ? managed.apiKey ?? '' : defaults.apiKey,
  };
}

function publicSnapshot(value) {
  const base = {
    version: REGISTRY_VERSION,
    revision: value.revision,
    modelCatalogRevision: value.modelCatalogRevision,
    stale: value.stale === true,
    ...(value.staleCode ? { staleCode: value.staleCode } : {}),
    recovered: value.recovered === true,
    ...(value.recoveryCode ? { recoveryCode: value.recoveryCode } : {}),
    models: value.models.map((model) => ({
      ...model,
      efforts: [...model.efforts],
      ...(model.effortMapping ? { effortMapping: { ...model.effortMapping } } : {}),
    })),
    embedding: {
      provider: value.embedding.provider,
      apiBase: value.embedding.apiBase || '',
      model: value.embedding.model || '',
      dimensions: value.embedding.dimensions,
      enabled: value.embedding.provider !== 'disabled',
      configured: value.embedding.provider !== 'disabled' && Boolean(
        value.embedding.apiBase && value.embedding.model && value.embedding.apiKey
      ),
      apiKeyConfigured: Boolean(value.embedding.apiKey),
    },
    branding: {
      appName: String(value.branding?.appName || 'Second Mind'),
      vaultLabel: String(value.branding?.vaultLabel || '知识库'),
    },
  };
  if (value.version === DYNAMIC_REGISTRY_VERSION) {
    return {
      ...base,
      version: DYNAMIC_REGISTRY_VERSION,
      schemaVersion: DYNAMIC_REGISTRY_VERSION,
      source: 'managed',
      defaultModelId: value.defaultModelId,
      connections: value.connections.map((connection) => ({
        id: connection.id,
        label: connection.label,
        protocol: connection.protocol,
        apiBase: connection.apiBase,
        authMode: connection.authMode,
        apiKeyConfigured: connection.authMode === 'none' || Boolean(connection.apiKey),
      })),
      webSearch: {
        provider: value.webSearch.provider,
        enabled: value.webSearch.enabled,
        configured: value.webSearch.enabled && Boolean(value.webSearch.apiKey),
        apiKeyConfigured: Boolean(value.webSearch.apiKey),
        extractFallbackEnabled: value.webSearch.extractFallbackEnabled === true,
        bindingRevision: value.webSearch.bindingRevision,
        providers: Object.entries(value.webSearch.providerConfigs).map(([id, config]) => ({
          id,
          label: id === 'bailian-mcp' ? '百炼 WebSearch' : 'Tavily',
          apiKeyConfigured: Boolean(config.apiKey),
          extractFallbackEnabled: config.extractFallbackEnabled === true,
        })),
      },
    };
  }
  return {
    ...base,
    webSearch: {
      provider: 'bailian-mcp',
      enabled: value.webSearch.enabled,
      configured: value.webSearch.enabled && Boolean(value.webSearch.apiKey),
      apiKeyConfigured: Boolean(value.webSearch.apiKey),
    },
  };
}

function assertPrivateStat(stat, label) {
  if (
    !stat.isFile() || Number(stat.nlink) !== 1 || (Number(stat.mode) & 0o777) !== 0o600 ||
    (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid())
  ) {
    fail(`${label} must be an owner-controlled 0600 regular file with one hard link.`,
      'UNSAFE_RUNTIME_CONFIG_FILE', 500);
  }
  if (Number(stat.size) < 1 || Number(stat.size) > MAX_PRIVATE_JSON_BYTES) {
    fail(`${label} is outside the permitted size bound.`,
      'UNSAFE_RUNTIME_CONFIG_FILE', 500);
  }
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readPrivateJson(filename, label, { optional = false } = {}) {
  if (!filename) return null;
  if (!path.isAbsolute(filename)) {
    fail(`${label} path must be absolute.`, 'UNSAFE_RUNTIME_CONFIG_PATH', 500);
  }
  const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await fsp.open(filename, flags);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    fail(`${label} could not be opened safely.`, 'RUNTIME_CONFIG_FILE_UNAVAILABLE', 500, {
      cause: error,
    });
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateStat(before, label);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameStat(before, after)) {
      fail(`${label} changed while it was being read.`, 'RUNTIME_CONFIG_FILE_CHANGED', 500);
    }
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      fail(`${label} is not valid JSON.`, 'INVALID_RUNTIME_CONFIG_JSON', 500, { cause: error });
    }
    return {
      value,
      semanticDigest: sha256(bytes),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function ensureSafeParent(filename) {
  const directory = path.dirname(filename);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const [resolved, real] = await Promise.all([Promise.resolve(path.resolve(directory)), fsp.realpath(directory)]);
  if (resolved !== real) {
    fail('Managed runtime configuration directory must not traverse symbolic links.',
      'UNSAFE_RUNTIME_CONFIG_PATH', 500);
  }
  const stat = await fsp.stat(directory);
  if (
    !stat.isDirectory() || (Number(stat.mode) & 0o022) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    fail('Managed runtime configuration directory must be owner-controlled and not writable by group or other users.',
      'UNSAFE_RUNTIME_CONFIG_PATH', 500);
  }
  return directory;
}

async function verifyExistingTarget(filename) {
  let handle;
  try {
    handle = await fsp.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    fail('Managed runtime configuration target could not be verified safely.',
      'UNSAFE_RUNTIME_CONFIG_FILE', 500, { cause: error });
  }
  try {
    assertPrivateStat(await handle.stat({ bigint: true }), 'Managed runtime configuration');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function atomicPrivateJson(filename, value, options = {}) {
  if (!path.isAbsolute(filename)) {
    fail('Managed runtime configuration path must be absolute.',
      'UNSAFE_RUNTIME_CONFIG_PATH', 500);
  }
  const directory = await ensureSafeParent(filename);
  const temporary = path.join(directory, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
    fsConstants.O_NOFOLLOW;
  let handle;
  let directoryHandle;
  let committed = false;
  try {
    handle = await fsp.open(temporary, flags, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await verifyExistingTarget(filename);
    // Open the directory before the rename so every fallible preparation step
    // occurs before the linearization point.
    directoryHandle = await fsp.open(directory, fsConstants.O_RDONLY);
    await fsp.rename(temporary, filename);
    committed = true;
    try {
      const syncDirectory = typeof options.syncDirectory === 'function'
        ? options.syncDirectory
        : (target) => target.sync();
      await syncDirectory(directoryHandle);
    } catch {
      // The rename is already visible and cannot be reported as a failed
      // commit: callers could otherwise delete an index slot now referenced
      // by this file. A later restart safely observes either the old or new
      // directory entry if the host loses power before metadata is durable.
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!committed) await fsp.unlink(temporary).catch(() => {});
    if (error instanceof RuntimeConfigError) throw error;
    fail('Managed runtime configuration could not be written atomically.',
      'RUNTIME_CONFIG_WRITE_FAILED', 500, { cause: error });
  } finally {
    await directoryHandle?.close().catch(() => {});
  }
}

function applyModelPatch(models, patch) {
  if (patch === undefined) return models;
  assertObject(patch, 'models', 'INVALID_RUNTIME_CONFIG_UPDATE');
  const next = safeClone(models);
  for (const [id, value] of Object.entries(patch)) {
    if (!MODEL_SLOT_IDS.has(id)) {
      fail('models contains an unsupported stable slot.',
        'INVALID_RUNTIME_CONFIG_UPDATE', 400);
    }
    assertObject(value, `models.${id}`, 'INVALID_RUNTIME_CONFIG_UPDATE');
    rejectUnknownKeys(
      value,
      new Set(['actualModel', 'displayName', 'efforts', 'defaultEffort', 'inherit']),
      `models.${id}`,
      'INVALID_RUNTIME_CONFIG_UPDATE',
    );
    if (value.inherit === true) {
      if (Object.keys(value).some((key) => key !== 'inherit')) {
        fail(`models.${id}.inherit cannot be combined with model values.`,
          'INVALID_RUNTIME_CONFIG_UPDATE', 400);
      }
      delete next[id];
      continue;
    }
    next[id] = normalizeManagedModel(value, id);
  }
  return next;
}

function applySecretAction(target, patch, label) {
  if (!Object.hasOwn(patch, 'apiKeyAction')) {
    if (Object.hasOwn(patch, 'apiKey')) {
      fail(`${label}.apiKeyAction is required when supplying a credential.`,
        'INVALID_RUNTIME_CONFIG_UPDATE', 400);
    }
    return;
  }
  const action = String(patch.apiKeyAction || '').trim().toLowerCase();
  if (!SECRET_ACTIONS.has(action)) {
    fail(`${label}.apiKeyAction is unsupported.`, 'INVALID_RUNTIME_CONFIG_UPDATE', 400);
  }
  if (action === 'replace') {
    target.apiKey = opaqueSecret(patch.apiKey, `${label}.apiKey`);
  } else if (action === 'clear') {
    if (Object.hasOwn(patch, 'apiKey')) {
      fail(`${label}.apiKey must be omitted when clearing a credential.`,
        'INVALID_RUNTIME_CONFIG_UPDATE', 400);
    }
    target.apiKey = null;
  } else if (Object.hasOwn(patch, 'apiKey')) {
    fail(`${label}.apiKey must be omitted when keeping a credential.`,
      'INVALID_RUNTIME_CONFIG_UPDATE', 400);
  }
}

function applyEmbeddingPatch(embedding, patch) {
  if (patch === undefined) return embedding;
  assertObject(patch, 'embedding', 'INVALID_RUNTIME_CONFIG_UPDATE');
  rejectUnknownKeys(
    patch,
    new Set(['provider', 'apiBase', 'model', 'dimensions', 'apiKeyAction', 'apiKey', 'inherit']),
    'embedding',
    'INVALID_RUNTIME_CONFIG_UPDATE',
  );
  if (patch.inherit === true) {
    if (Object.keys(patch).some((key) => key !== 'inherit')) {
      fail('embedding.inherit cannot be combined with configuration values.',
        'INVALID_RUNTIME_CONFIG_UPDATE', 400);
    }
    return {};
  }
  const next = safeClone(embedding);
  if (Object.hasOwn(patch, 'provider')) {
    const provider = String(patch.provider || '').trim().toLowerCase();
    if (!PROVIDERS.has(provider)) {
      fail('embedding.provider is unsupported.', 'INVALID_RUNTIME_CONFIG_UPDATE', 400);
    }
    next.provider = provider;
  }
  if (Object.hasOwn(patch, 'apiBase')) next.apiBase = safeEmbeddingUrl(patch.apiBase);
  if (Object.hasOwn(patch, 'model')) next.model = modelValue(patch.model, 'embedding.model');
  if (Object.hasOwn(patch, 'dimensions')) {
    next.dimensions = integer(patch.dimensions, 'embedding.dimensions', 8, 32_768);
  }
  applySecretAction(next, patch, 'embedding');
  return next;
}

function applyWebSearchPatch(webSearch, patch) {
  if (patch === undefined) return webSearch;
  assertObject(patch, 'webSearch', 'INVALID_RUNTIME_CONFIG_UPDATE');
  rejectUnknownKeys(
    patch,
    new Set(['enabled', 'apiKeyAction', 'apiKey', 'inherit']),
    'webSearch',
    'INVALID_RUNTIME_CONFIG_UPDATE',
  );
  if (patch.inherit === true) {
    if (Object.keys(patch).some((key) => key !== 'inherit')) {
      fail('webSearch.inherit cannot be combined with configuration values.',
        'INVALID_RUNTIME_CONFIG_UPDATE', 400);
    }
    return {};
  }
  const next = safeClone(webSearch);
  if (Object.hasOwn(patch, 'enabled')) next.enabled = boolean(patch.enabled, 'webSearch.enabled');
  applySecretAction(next, patch, 'webSearch');
  return next;
}

function managedDocumentFromPatch(current, patch) {
  assertObject(patch, 'Runtime configuration update', 'INVALID_RUNTIME_CONFIG_UPDATE');
  rejectUnknownKeys(
    patch,
    new Set(['expectedRevision', 'models', 'embedding', 'webSearch']),
    'Runtime configuration update',
    'INVALID_RUNTIME_CONFIG_UPDATE',
  );
  return {
    version: REGISTRY_VERSION,
    revision: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
    models: applyModelPatch(current.models, patch.models),
    embedding: applyEmbeddingPatch(current.embedding, patch.embedding),
    webSearch: applyWebSearchPatch(current.webSearch, patch.webSearch),
  };
}

function applyDynamicConnectionInput(currentConnections, input) {
  if (!Array.isArray(input) || input.length > MAX_MODEL_CONNECTIONS) {
    fail(`connections must contain 0-${MAX_MODEL_CONNECTIONS} entries.`,
      'INVALID_RUNTIME_CONFIG_UPDATE', 400);
  }
  const currentById = new Map(currentConnections.map((entry) => [entry.id, entry]));
  return input.map((raw, position) => {
    assertObject(raw, `connections[${position}]`, 'INVALID_RUNTIME_CONFIG_UPDATE');
    rejectUnknownKeys(
      raw,
      new Set([
        'id', 'label', 'providerId', 'protocol', 'apiBase', 'authMode', 'apiKeyAction', 'apiKey',
      ]),
      `connections[${position}]`,
      'INVALID_RUNTIME_CONFIG_UPDATE',
    );
    const id = boundedText(raw.id, `connections[${position}].id`, 64, { required: true });
    const previous = currentById.get(id);
    const candidate = normalizeManagedConnection({
      id,
      label: raw.label,
      providerId: raw.providerId ?? previous?.providerId,
      protocol: raw.protocol,
      apiBase: raw.apiBase,
      authMode: raw.authMode,
      apiKey: null,
    }, position);
    const action = String(raw.apiKeyAction || 'keep').trim().toLowerCase();
    if (!SECRET_ACTIONS.has(action)) {
      fail(`connections[${position}].apiKeyAction is unsupported.`,
        'INVALID_RUNTIME_CONFIG_UPDATE', 400);
    }
    const transportChanged = Boolean(previous && (
      previous.providerId !== candidate.providerId ||
      previous.protocol !== candidate.protocol || previous.apiBase !== candidate.apiBase ||
      previous.authMode !== candidate.authMode
    ));
    if (transportChanged && action === 'keep') {
      fail('Changing a model connection destination or protocol requires replacing or clearing its credential.',
        'MODEL_CREDENTIAL_REPLACEMENT_REQUIRED', 400);
    }
    if (action === 'replace') {
      candidate.apiKey = opaqueSecret(raw.apiKey, `connections[${position}].apiKey`);
    } else if (action === 'clear' || candidate.authMode === 'none') {
      if (Object.hasOwn(raw, 'apiKey')) {
        fail(`connections[${position}].apiKey must be omitted when clearing a credential.`,
          'INVALID_RUNTIME_CONFIG_UPDATE', 400);
      }
      candidate.apiKey = '';
    } else {
      if (Object.hasOwn(raw, 'apiKey')) {
        fail(`connections[${position}].apiKey must be omitted when keeping a credential.`,
          'INVALID_RUNTIME_CONFIG_UPDATE', 400);
      }
      candidate.apiKey = previous?.apiKey || '';
    }
    return candidate;
  });
}

function applyDynamicWebProvider(current, raw, id) {
  const input = raw === undefined ? {} : assertObject(
    raw,
    `webSearch.providers.${id}`,
    'INVALID_RUNTIME_CONFIG_UPDATE',
  );
  rejectUnknownKeys(
    input,
    new Set(['apiKeyAction', 'apiKey', 'extractFallbackEnabled']),
    `webSearch.providers.${id}`,
    'INVALID_RUNTIME_CONFIG_UPDATE',
  );
  const output = {
    apiKey: current?.apiKey || '',
    extractFallbackEnabled: Object.hasOwn(input, 'extractFallbackEnabled')
      ? boolean(input.extractFallbackEnabled, `webSearch.providers.${id}.extractFallbackEnabled`)
      : current?.extractFallbackEnabled === true,
  };
  const action = String(input.apiKeyAction || 'keep').trim().toLowerCase();
  if (!SECRET_ACTIONS.has(action)) {
    fail(`webSearch.providers.${id}.apiKeyAction is unsupported.`,
      'INVALID_RUNTIME_CONFIG_UPDATE', 400);
  }
  if (action === 'replace') output.apiKey = opaqueSecret(input.apiKey, `webSearch.providers.${id}.apiKey`);
  else if (action === 'clear') {
    if (Object.hasOwn(input, 'apiKey')) {
      fail(`webSearch.providers.${id}.apiKey must be omitted when clearing a credential.`,
        'INVALID_RUNTIME_CONFIG_UPDATE', 400);
    }
    output.apiKey = '';
  } else if (Object.hasOwn(input, 'apiKey')) {
    fail(`webSearch.providers.${id}.apiKey must be omitted when keeping a credential.`,
      'INVALID_RUNTIME_CONFIG_UPDATE', 400);
  }
  return output;
}

function managedDocumentV2FromPatch(current, patch) {
  assertObject(patch, 'Runtime configuration update', 'INVALID_RUNTIME_CONFIG_UPDATE');
  rejectUnknownKeys(
    patch,
    new Set([
      'schemaVersion', 'expectedRevision', 'connections', 'models', 'defaultModelId',
      'embedding', 'webSearch', 'branding',
    ]),
    'Runtime configuration update',
    'INVALID_RUNTIME_CONFIG_UPDATE',
  );
  if (Object.hasOwn(patch, 'schemaVersion') && patch.schemaVersion !== DYNAMIC_REGISTRY_VERSION) {
    fail('The runtime configuration client schema is unsupported.',
      'RUNTIME_CONFIG_CLIENT_UPGRADE_REQUIRED', 409);
  }
  const connections = patch.connections === undefined
    ? safeClone(current.connections)
    : applyDynamicConnectionInput(current.connections, patch.connections);
  const models = patch.models === undefined
    ? safeClone(current.models)
    : normalizeDynamicModels(patch.models, connections);
  const defaultModelId = patch.defaultModelId === undefined
    ? current.defaultModelId
    : boundedText(patch.defaultModelId, 'defaultModelId', 64) || '';
  let webSearch = safeClone(current.webSearch);
  if (patch.webSearch !== undefined) {
    const input = assertObject(patch.webSearch, 'webSearch', 'INVALID_RUNTIME_CONFIG_UPDATE');
    rejectUnknownKeys(
      input,
      new Set(['enabled', 'provider', 'providers']),
      'webSearch',
      'INVALID_RUNTIME_CONFIG_UPDATE',
    );
    const provider = Object.hasOwn(input, 'provider')
      ? String(input.provider || '').trim().toLowerCase()
      : webSearch.provider;
    if (!WEB_SEARCH_PROVIDERS.has(provider)) {
      fail('webSearch.provider is unsupported.', 'INVALID_RUNTIME_CONFIG_UPDATE', 400);
    }
    const providerInputs = input.providers === undefined
      ? {}
      : assertObject(input.providers, 'webSearch.providers', 'INVALID_RUNTIME_CONFIG_UPDATE');
    rejectUnknownKeys(providerInputs, WEB_SEARCH_PROVIDERS, 'webSearch.providers',
      'INVALID_RUNTIME_CONFIG_UPDATE');
    webSearch = {
      enabled: Object.hasOwn(input, 'enabled')
        ? boolean(input.enabled, 'webSearch.enabled')
        : webSearch.enabled,
      provider,
      providers: Object.fromEntries([...WEB_SEARCH_PROVIDERS].map((id) => [
        id,
        applyDynamicWebProvider(webSearch.providers[id], providerInputs[id], id),
      ])),
    };
  }
  const document = {
    version: DYNAMIC_REGISTRY_VERSION,
    revision: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
    connections,
    models,
    defaultModelId,
    branding: patch.branding === undefined
      ? safeClone(current.branding || {})
      : normalizeBranding(patch.branding, current.branding),
    embedding: applyEmbeddingPatch(current.embedding, patch.embedding),
    webSearch,
  };
  return normalizeManagedDocumentV2(document);
}

export class RuntimeConfigRegistry {
  constructor(options = {}) {
    if (!plainObject(options)) {
      fail('RuntimeConfigRegistry options must be an object.', 'INVALID_RUNTIME_CONFIG', 500);
    }
    this.settingsFile = options.settingsFile ? path.resolve(options.settingsFile) : '';
    this.managedFile = options.managedFile ? path.resolve(options.managedFile) : '';
    if (!this.managedFile) {
      fail('RuntimeConfigRegistry requires an absolute managedFile.',
        'UNSAFE_RUNTIME_CONFIG_PATH', 500);
    }
    const configuredBackupFile = options.backupFile || options.lastKnownGoodFile;
    this.backupFile = configuredBackupFile
      ? path.resolve(configuredBackupFile)
      : `${this.managedFile}.last-good`;
    this.lastKnownGoodFile = this.backupFile;
    if (this.backupFile === this.managedFile || this.backupFile === this.settingsFile) {
      fail('RuntimeConfigRegistry backupFile must be separate from its source files.',
        'UNSAFE_RUNTIME_CONFIG_PATH', 500);
    }
    const defaults = plainObject(options.defaults) ? options.defaults : {};
    const defaultModels = normalizeDefaultModels(options.modelCatalog ?? defaults.models ?? []);
    this.llmDefaults = normalizeLlmDefaults(
      defaultModels.length ? options.llm ?? defaults.llm : {},
    );
    this.defaults = {
      models: defaultModels,
      embedding: normalizeEmbeddingDefaults(options.embedding ?? defaults.embedding),
      webSearch: normalizeWebSearchDefaults(options.webSearch ?? defaults.webSearch),
      branding: normalizeBranding(options.branding ?? defaults.branding),
    };
    this.dynamicDefaults = dynamicDefaultsFromLegacy(this.defaults.models, this.llmDefaults);
    this.current = null;
    this.managedDocument = null;
    this.managedSemanticDigest = '';
    this.backupRevision = '';
    this.settingsSeen = false;
    this.managedSeen = false;
    this.operationChain = Promise.resolve();
    this.ready = this.#enqueue(() => this.#refreshOnce());
  }

  #enqueue(callback) {
    const operation = this.operationChain.then(callback, callback);
    this.operationChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #acceptCandidate(candidate) {
    if (
      candidate.managedRead && !candidate.recovered &&
      candidate.managed.revision !== this.backupRevision
    ) {
      await atomicPrivateJson(this.backupFile, candidate.managed);
      this.backupRevision = candidate.managed.revision;
    } else if (candidate.recovered) {
      this.backupRevision = candidate.managed.revision;
    }
    this.current = candidate.snapshot;
    this.managedDocument = candidate.managed;
    this.managedSemanticDigest = candidate.managedRead ? digestJson(candidate.managed) : '';
    this.settingsSeen ||= Boolean(candidate.settingsRead);
    this.managedSeen ||= Boolean(candidate.managedRead);
  }

  async #loadCandidate() {
    let managedRead = null;
    let primaryError = null;
    let recoveryCode = '';
    try {
      managedRead = await readPrivateJson(
        this.managedFile,
        'Managed runtime configuration',
        { optional: true },
      );
    } catch (error) {
      primaryError = error;
    }
    if (!managedRead) {
      let backupRead = null;
      try {
        backupRead = await readPrivateJson(
          this.backupFile,
          'Last-known-good runtime configuration',
          { optional: true },
        );
      } catch (backupError) {
        throw primaryError || backupError;
      }
      if (backupRead) {
        managedRead = backupRead;
        recoveryCode = primaryError
          ? 'RUNTIME_CONFIG_RECOVERED_INVALID_PRIMARY'
          : 'RUNTIME_CONFIG_RECOVERED_MISSING_PRIMARY';
      } else if (primaryError) {
        throw primaryError;
      }
    }
    if (!managedRead && this.managedSeen) {
      fail('Managed runtime configuration disappeared after a valid load.',
        'RUNTIME_CONFIG_FILE_UNAVAILABLE', 500);
    }
    const managed = managedRead ? normalizeManagedDocument(managedRead.value) : {
      version: REGISTRY_VERSION,
      revision: 'unmanaged',
      updatedAt: '',
      models: {},
      embedding: {},
      webSearch: {},
    };
    if (
      managedRead && this.managedDocument && managed.revision === this.managedDocument.revision &&
      digestJson(managed) !== this.managedSemanticDigest
    ) {
      fail('Managed runtime configuration reused a revision for different content.',
        'RUNTIME_CONFIG_REVISION_REUSED', 500);
    }
    if (managed.version === DYNAMIC_REGISTRY_VERSION) {
      const snapshot = snapshotFromDynamicManaged(managed, this.defaults);
      return {
        snapshot: recoveryCode
          ? {
              ...snapshot,
              stale: true,
              staleCode: primaryError?.code || 'RUNTIME_CONFIG_FILE_UNAVAILABLE',
              recovered: true,
              recoveryCode,
            }
          : snapshot,
        settingsRead: null,
        managedRead,
        managed,
        recovered: Boolean(recoveryCode),
      };
    }
    const settingsRead = await readPrivateJson(
      this.settingsFile,
      'Claude settings',
      { optional: true },
    );
    if (!settingsRead && this.settingsSeen) {
      fail('Claude settings disappeared after a valid load.',
        'RUNTIME_CONFIG_FILE_UNAVAILABLE', 500);
    }
    const settingsModels = settingsRead ? extractClaudeModelOverrides(settingsRead.value) : {};
    const models = resolveModels(this.defaults.models, settingsModels, managed.models);
    const embedding = resolveEmbedding(this.defaults.embedding, managed.embedding);
    const webSearch = resolveWebSearch(this.defaults.webSearch, managed.webSearch);
    const modelCatalogRevision = digestJson(models.map(({
      configurationSource,
      inherited,
      ...model
    }) => model));
    const revision = digestJson({
      version: REGISTRY_VERSION,
      managedRevision: managed.revision,
      modelCatalogRevision,
      embedding: {
        provider: embedding.provider,
        apiBase: embedding.apiBase,
        model: embedding.model,
        dimensions: embedding.dimensions,
        apiKeyConfigured: Boolean(embedding.apiKey),
      },
      webSearch: {
        enabled: webSearch.enabled,
        apiKeyConfigured: Boolean(webSearch.apiKey),
      },
    });
    return {
      snapshot: {
        version: REGISTRY_VERSION,
        revision,
        modelCatalogRevision,
        stale: Boolean(recoveryCode),
        ...(recoveryCode ? {
          staleCode: primaryError?.code || 'RUNTIME_CONFIG_FILE_UNAVAILABLE',
          recovered: true,
          recoveryCode,
        } : {}),
        models,
        embedding,
        webSearch,
        branding: safeClone(this.defaults.branding),
      },
      settingsRead,
      managedRead,
      managed,
      recovered: Boolean(recoveryCode),
    };
  }

  async #refreshOnce() {
    try {
      const candidate = await this.#loadCandidate();
      await this.#acceptCandidate(candidate);
      return publicSnapshot(this.current);
    } catch (error) {
      if (!this.current) throw error;
      this.current = {
        ...this.current,
        stale: true,
        staleCode: error?.code || 'RUNTIME_CONFIG_REFRESH_FAILED',
      };
      return publicSnapshot(this.current);
    }
  }

  refresh() {
    return this.#enqueue(() => this.#refreshOnce());
  }

  publicSnapshot() {
    if (!this.current) {
      fail('Runtime configuration is not ready.', 'RUNTIME_CONFIG_NOT_READY', 503);
    }
    return publicSnapshot(this.current);
  }

  runtimeSnapshot() {
    if (!this.current) {
      fail('Runtime configuration is not ready.', 'RUNTIME_CONFIG_NOT_READY', 503);
    }
    return safeClone(this.current);
  }

  async bootstrapManagedV2(options = {}) {
    await this.ready;
    return this.#enqueue(async () => {
      const fresh = await this.#refreshOnce();
      if (fresh.stale) {
        fail('Runtime configuration is stale; repair it before upgrading.',
          'RUNTIME_CONFIG_STALE', 409);
      }
      if (this.current.version === DYNAMIC_REGISTRY_VERSION) {
        return publicSnapshot(this.current);
      }
      const connection = this.dynamicDefaults.connections[0]
        ? { ...this.dynamicDefaults.connections[0] }
        : null;
      const models = connection ? this.current.models.map((model) => ({
        id: model.id,
        displayName: model.label,
        shortLabel: model.shortLabel || model.label,
        connectionId: connection.id,
        actualModel: model.actualModel,
        requestProfile: connection.protocol === 'anthropic-messages'
          ? 'anthropic-standard'
          : 'openai-standard',
        efforts: [...model.efforts],
        defaultEffort: model.defaultEffort,
        enabled: model.available !== false,
        description: model.description || '',
        reasoningMapping: { mode: 'auto' },
      })) : [];
      const document = normalizeManagedDocumentV2({
        version: DYNAMIC_REGISTRY_VERSION,
        revision: crypto.randomUUID(),
        updatedAt: new Date().toISOString(),
        connections: connection ? [connection] : [],
        models,
        defaultModelId: models.find((model) => model.enabled)?.id || models[0]?.id || '',
        branding: normalizeBranding(options.branding, this.defaults.branding),
        embedding: this.current.embedding.provider === 'disabled'
          ? { provider: 'disabled', apiKey: null }
          : {
              provider: this.current.embedding.provider,
              apiBase: this.current.embedding.apiBase,
              apiKey: this.current.embedding.apiKey || null,
              model: this.current.embedding.model,
              dimensions: this.current.embedding.dimensions,
            },
        webSearch: {
          enabled: this.current.webSearch.enabled,
          provider: 'bailian-mcp',
          providers: {
            'bailian-mcp': {
              apiKey: this.current.webSearch.apiKey || null,
              extractFallbackEnabled: options.bailianExtractFallbackEnabled === true,
            },
            'tavily-rest': {
              apiKey: options.tavilyApiKey || null,
              extractFallbackEnabled: false,
            },
          },
        },
      });
      await atomicPrivateJson(this.managedFile, document);
      const candidate = await this.#loadCandidate();
      await this.#acceptCandidate(candidate);
      return publicSnapshot(this.current);
    });
  }

  async previewUpdate(patch, options = {}) {
    await this.ready;
    return this.#enqueue(async () => {
      const fresh = await this.#refreshOnce();
      if (fresh.stale) {
        fail('Runtime configuration is stale; repair the source file before validating.',
          'RUNTIME_CONFIG_STALE', 409);
      }
      const expectedRevision = String(
        options.expectedRevision ?? (plainObject(patch) ? patch.expectedRevision : '') ?? '',
      ).trim();
      if (!expectedRevision) {
        fail('expectedRevision is required.', 'RUNTIME_CONFIG_REVISION_REQUIRED', 400);
      }
      if (expectedRevision !== this.current.revision) {
        fail('Runtime configuration changed; reload before validating.',
          'RUNTIME_CONFIG_REVISION_CONFLICT', 409);
      }
      if (this.managedDocument.version !== DYNAMIC_REGISTRY_VERSION) {
        fail('Dynamic runtime configuration version 2 is required.',
          'RUNTIME_CONFIG_UPGRADE_REQUIRED', 409);
      }
      const document = managedDocumentV2FromPatch(this.managedDocument, patch);
      const nextEmbedding = resolveEmbedding(this.defaults.embedding, document.embedding);
      assertEmbeddingUpdateCredentialBoundary(
        this.current.embedding,
        nextEmbedding,
        plainObject(patch) && plainObject(patch.embedding) ? patch.embedding : null,
      );
      return snapshotFromDynamicManaged(document, this.defaults);
    });
  }

  async update(patch, options = {}) {
    await this.ready;
    return this.#enqueue(async () => {
      const fresh = await this.#refreshOnce();
      if (fresh.stale) {
        fail('Runtime configuration is stale; repair the source file before saving.',
          'RUNTIME_CONFIG_STALE', 409);
      }
      const expectedRevision = String(
        options.expectedRevision ?? (plainObject(patch) ? patch.expectedRevision : '') ?? '',
      ).trim();
      if (!expectedRevision) {
        fail('expectedRevision is required.', 'RUNTIME_CONFIG_REVISION_REQUIRED', 400);
      }
      if (expectedRevision !== this.current.revision) {
        fail('Runtime configuration changed; reload before saving.',
          'RUNTIME_CONFIG_REVISION_CONFLICT', 409);
      }
      if (
        this.managedDocument.version !== DYNAMIC_REGISTRY_VERSION &&
        plainObject(patch) && Object.hasOwn(patch, 'schemaVersion')
      ) {
        fail('Upgrade the runtime configuration to schema version 2 before using the dynamic API.',
          'RUNTIME_CONFIG_UPGRADE_REQUIRED', 409);
      }
      let document = this.managedDocument.version === DYNAMIC_REGISTRY_VERSION
        ? managedDocumentV2FromPatch(this.managedDocument, patch)
        : managedDocumentFromPatch(this.managedDocument, patch);
      const nextEmbedding = resolveEmbedding(this.defaults.embedding, document.embedding);
      assertEmbeddingUpdateCredentialBoundary(
        this.current.embedding,
        nextEmbedding,
        plainObject(patch) && plainObject(patch.embedding) ? patch.embedding : null,
      );
      if (document.version === DYNAMIC_REGISTRY_VERSION && typeof options.beforeCommit === 'function') {
        let candidateSnapshot = snapshotFromDynamicManaged(document, this.defaults);
        const adjustment = await options.beforeCommit(safeClone(candidateSnapshot));
        if (plainObject(adjustment) && Object.hasOwn(adjustment, 'embeddingDimensions')) {
          const detected = integer(
            adjustment.embeddingDimensions,
            'embedding.dimensions',
            8,
            32_768,
          );
          document = normalizeManagedDocumentV2({
            ...document,
            embedding: { ...document.embedding, dimensions: detected },
          });
          candidateSnapshot = snapshotFromDynamicManaged(document, this.defaults);
        }
        const confirmed = await this.#loadCandidate();
        if (confirmed.snapshot.revision !== this.current.revision) {
          fail('Runtime configuration changed while it was being verified; reload before saving.',
            'RUNTIME_CONFIG_REVISION_CONFLICT', 409);
        }
      }
      await atomicPrivateJson(this.managedFile, document);
      const candidate = await this.#loadCandidate();
      await this.#acceptCandidate(candidate);
      return publicSnapshot(this.current);
    });
  }
}

export const runtimeConfigInternals = Object.freeze({
  REGISTRY_VERSION,
  DYNAMIC_REGISTRY_VERSION,
  MAX_MODEL_CONNECTIONS,
  MAX_DYNAMIC_MODELS,
  LEGACY_DIRECT_MODEL_ALIASES,
  MODEL_SLOTS,
  MODEL_PROTOCOLS,
  MODEL_AUTH_MODES,
  MODEL_REQUEST_PROFILES,
  BAILIAN_WEB_SEARCH_ENDPOINT,
  TAVILY_SEARCH_ENDPOINT,
  TAVILY_EXTRACT_ENDPOINT,
  safeEmbeddingUrl,
  safeModelApiBase,
  extractClaudeModelOverrides,
  normalizeManagedDocument,
  normalizeManagedDocumentV2,
  managedDocumentV2FromPatch,
  snapshotFromDynamicManaged,
  connectionBindingRevision,
  readPrivateJson,
  atomicPrivateJson,
  publicSnapshot,
});
