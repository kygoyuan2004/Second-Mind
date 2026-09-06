import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const REGISTRY_VERSION = 1;
const APPLICATION_MAX_OUTPUT_TOKENS = 131_072;
const APPLICATION_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTPUT_TOKENS = 3_000;

const PROTOCOLS = new Set(['anthropic-messages', 'openai-chat-completions']);
const AUTH_MODES = new Set(['x-api-key', 'bearer', 'none']);
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const UNIVERSAL_REASONING_EFFORTS = Object.freeze([
  'low', 'medium', 'high', 'xhigh', 'max',
]);
const UNIVERSAL_EFFORT_RANK = Object.freeze({
  minimal: -1,
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
});

const ENDPOINT_SUFFIX = Object.freeze({
  'anthropic-messages': '/v1/messages',
  'openai-chat-completions': '/chat/completions',
});

const DEFINITIONS = deepFreeze({
  bailian: {
    id: 'bailian',
    label: '阿里云百炼',
    defaultApiBase: 'https://dashscope.aliyuncs.com/apps/anthropic',
    protocols: ['anthropic-messages', 'openai-chat-completions'],
    defaultProtocol: 'anthropic-messages',
    authByProtocol: {
      'anthropic-messages': 'x-api-key',
      'openai-chat-completions': 'bearer',
    },
    reasoningByProtocol: {
      'anthropic-messages': 'anthropic-effort',
      'openai-chat-completions': 'bailian-thinking-toggle',
    },
    legacyProfileByProtocol: {
      'anthropic-messages': 'anthropic-standard',
      'openai-chat-completions': 'bailian-openai',
    },
    docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    defaultSafeOutputTokens: 16_384,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek 官网',
    defaultApiBase: 'https://api.deepseek.com',
    protocols: ['openai-chat-completions'],
    defaultProtocol: 'openai-chat-completions',
    authByProtocol: { 'openai-chat-completions': 'bearer' },
    reasoningByProtocol: { 'openai-chat-completions': 'deepseek-reasoning' },
    legacyProfileByProtocol: { 'openai-chat-completions': 'deepseek-openai' },
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
    defaultSafeOutputTokens: 8_192,
  },
  glm: {
    id: 'glm',
    label: 'GLM / 智谱官网',
    defaultApiBase: 'https://open.bigmodel.cn/api/paas/v4',
    protocols: ['openai-chat-completions'],
    defaultProtocol: 'openai-chat-completions',
    authByProtocol: { 'openai-chat-completions': 'bearer' },
    reasoningByProtocol: { 'openai-chat-completions': 'thinking-toggle' },
    legacyProfileByProtocol: { 'openai-chat-completions': 'glm-openai' },
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    defaultSafeOutputTokens: 4_095,
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi / Moonshot 官网',
    defaultApiBase: 'https://api.moonshot.cn/v1',
    protocols: ['openai-chat-completions'],
    defaultProtocol: 'openai-chat-completions',
    authByProtocol: { 'openai-chat-completions': 'bearer' },
    // Kimi model families do not share one provider-wide reasoning switch.
    // The wire adapter is available here, while providerModelReasoningPolicy
    // decides whether the selected model is one of the explicitly supported
    // K3 identifiers before any non-default value can reach it.
    reasoningByProtocol: { 'openai-chat-completions': 'kimi-reasoning' },
    legacyProfileByProtocol: { 'openai-chat-completions': 'kimi-openai' },
    docsUrl: 'https://platform.moonshot.cn/docs/',
    defaultSafeOutputTokens: 8_192,
  },
  custom: {
    id: 'custom',
    label: '自定义兼容服务',
    defaultApiBase: '',
    protocols: ['openai-chat-completions', 'anthropic-messages'],
    defaultProtocol: 'openai-chat-completions',
    authByProtocol: {
      'openai-chat-completions': 'bearer',
      'anthropic-messages': 'x-api-key',
    },
    // Unknown compatible services receive only the common protocol payload.
    // Never infer vendor-specific reasoning fields from a model-name string.
    reasoningByProtocol: {
      'openai-chat-completions': 'none',
      'anthropic-messages': 'none',
    },
    legacyProfileByProtocol: {
      'openai-chat-completions': 'default',
      'anthropic-messages': 'default',
    },
    docsUrl: '',
    defaultSafeOutputTokens: 4_096,
  },
});

const ORDER = Object.freeze(['bailian', 'deepseek', 'glm', 'kimi', 'custom']);

// Exact, provider-scoped migrations for identifiers that were previously
// imported from a compatibility launcher. Do not apply these aliases by model
// name alone: another provider is allowed to use the same opaque identifier.
const MODEL_ID_ALIASES = deepFreeze({
  deepseek: {
    'deepseek-v4-pro-0813': 'deepseek-v4-pro',
  },
});

export class ModelProviderRegistryError extends Error {
  constructor(message, code = 'MODEL_PROVIDER_REGISTRY_ERROR', status = 400) {
    super(message);
    this.name = 'ModelProviderRegistryError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code) {
  throw new ModelProviderRegistryError(message, code);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function publicDefinition(definition) {
  return {
    id: definition.id,
    label: definition.label,
    defaultApiBase: definition.defaultApiBase,
    protocols: [...definition.protocols],
    defaultProtocol: definition.defaultProtocol,
    docsUrl: definition.docsUrl,
    outputPolicy: {
      requestField: 'max_tokens',
      defaultTokens: DEFAULT_OUTPUT_TOKENS,
      applicationSafetyMaximumTokens: definition.defaultSafeOutputTokens,
      applicationSafetyMaximumResponseBytes: APPLICATION_MAX_RESPONSE_BYTES,
    },
  };
}

function normalizedProviderId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!Object.hasOwn(DEFINITIONS, id)) {
    fail('The model provider is not registered.', 'MODEL_PROVIDER_NOT_REGISTERED');
  }
  return id;
}

function normalizedApiBase(value) {
  const raw = String(value || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('The model provider API Base is invalid.', 'MODEL_PROVIDER_BASE_INVALID');
  }
  if (
    url.protocol !== 'https:' || url.username || url.password ||
    url.search || url.hash || (url.port && url.port !== '443')
  ) {
    fail(
      'The model provider API Base must be public HTTPS without credentials, query, fragment, or a nonstandard port.',
      'MODEL_PROVIDER_BASE_INVALID',
    );
  }
  const hostname = domainToASCII(url.hostname).toLowerCase().replace(/\.$/u, '');
  if (
    !hostname || isIP(hostname) || hostname === 'localhost' ||
    hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    fail('The model provider API Base must use a public DNS hostname.', 'MODEL_PROVIDER_BASE_INVALID');
  }
  url.hostname = hostname;
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.href.replace(/\/$/u, '');
}

function bailianProtocol(apiBase) {
  const path = new URL(apiBase).pathname.replace(/\/+$/u, '').toLowerCase();
  if (/\/apps\/anthropic(?:\/v1(?:\/messages)?)?$/u.test(path)) {
    return 'anthropic-messages';
  }
  if (/\/compatible-mode\/v1(?:\/chat\/completions)?$/u.test(path)) {
    return 'openai-chat-completions';
  }
  fail(
    'Bailian API Base must use the /apps/anthropic or /compatible-mode/v1 API path.',
    'BAILIAN_API_VARIANT_UNKNOWN',
  );
}

function normalizedProtocol(definition, input, apiBase) {
  const explicit = String(input.protocol || '').trim().toLowerCase();
  const protocol = definition.id === 'bailian'
    ? bailianProtocol(apiBase)
    : explicit || definition.defaultProtocol;
  if (!PROTOCOLS.has(protocol) || !definition.protocols.includes(protocol)) {
    fail('The protocol is not supported by this model provider.', 'MODEL_PROVIDER_PROTOCOL_UNSUPPORTED');
  }
  if (definition.id !== 'custom' && explicit && explicit !== protocol) {
    fail('The selected protocol conflicts with the provider API Base.', 'MODEL_PROVIDER_PROTOCOL_CONFLICT');
  }
  return protocol;
}

function normalizedAuthMode(definition, input, protocol) {
  const expected = definition.authByProtocol[protocol];
  const explicit = String(input.authMode || '').trim().toLowerCase();
  const authMode = definition.id === 'custom' ? explicit || expected : expected;
  if (!AUTH_MODES.has(authMode)) {
    fail('The model provider authentication mode is invalid.', 'MODEL_PROVIDER_AUTH_UNSUPPORTED');
  }
  if (definition.id !== 'custom' && explicit && explicit !== expected) {
    fail('The authentication mode is fixed by this provider adapter.', 'MODEL_PROVIDER_AUTH_CONFLICT');
  }
  return authMode;
}

function endpointFor(apiBase, protocol) {
  const suffix = ENDPOINT_SUFFIX[protocol];
  const clean = apiBase.replace(/\/+$/u, '');
  if (clean.endsWith(suffix)) return clean;
  if (protocol === 'anthropic-messages' && clean.endsWith('/v1')) return `${clean}/messages`;
  return `${clean}${suffix}`;
}

function reasoningDefaults(strategy) {
  if (strategy === 'anthropic-effort') {
    return { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'xhigh' };
  }
  if (strategy === 'deepseek-reasoning') {
    return { efforts: ['low', 'high', 'max'], defaultEffort: 'high' };
  }
  if (strategy === 'thinking-toggle' || strategy === 'bailian-thinking-toggle') {
    return { efforts: ['low', 'high'], defaultEffort: 'high' };
  }
  // Kimi capability is model-scoped, not provider-scoped. Unknown Moonshot
  // models must continue to receive no vendor-specific reasoning field.
  if (strategy === 'kimi-reasoning') {
    return { efforts: ['default'], defaultEffort: 'default' };
  }
  return { efforts: ['default'], defaultEffort: 'default' };
}

/**
 * Project a provider/model's native effort vocabulary onto the five stable
 * application tiers.  The projection is monotonic and deterministic: an
 * unsupported tier selects the nearest native tier, with ties going to the
 * stronger tier.  Providers without a reasoning control map every selection
 * to `default`, which deliberately emits no vendor-specific request field.
 *
 * Keeping the requested tier separate from the effective wire value lets a
 * conversation retain exactly what the user selected while still making the
 * downgrade/upgrade visible to clients.
 */
export function universalReasoningPolicy(input = {}) {
  const source = Array.isArray(input.efforts) ? input.efforts : ['default'];
  const nativeEfforts = [...new Set(source
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => entry === 'default' || REASONING_EFFORTS.has(entry)))];
  const concrete = nativeEfforts
    .filter((entry) => entry !== 'default')
    .sort((left, right) => UNIVERSAL_EFFORT_RANK[left] - UNIVERSAL_EFFORT_RANK[right]);
  const effortMapping = {};
  for (const requested of UNIVERSAL_REASONING_EFFORTS) {
    if (!concrete.length) {
      effortMapping[requested] = 'default';
      continue;
    }
    const requestedRank = UNIVERSAL_EFFORT_RANK[requested];
    effortMapping[requested] = concrete.reduce((best, candidate) => {
      if (!best) return candidate;
      const bestDistance = Math.abs(UNIVERSAL_EFFORT_RANK[best] - requestedRank);
      const candidateDistance = Math.abs(UNIVERSAL_EFFORT_RANK[candidate] - requestedRank);
      if (candidateDistance < bestDistance) return candidate;
      if (
        candidateDistance === bestDistance &&
        UNIVERSAL_EFFORT_RANK[candidate] > UNIVERSAL_EFFORT_RANK[best]
      ) return candidate;
      return best;
    }, '');
  }
  const nativeDefault = String(input.defaultEffort || nativeEfforts[0] || 'default')
    .trim().toLowerCase();
  let defaultEffort = 'medium';
  if (nativeDefault !== 'default' && Object.hasOwn(UNIVERSAL_EFFORT_RANK, nativeDefault)) {
    defaultEffort = UNIVERSAL_REASONING_EFFORTS.reduce((best, candidate) => {
      const effective = effortMapping[candidate];
      const distance = Math.abs(
        (UNIVERSAL_EFFORT_RANK[effective] ?? UNIVERSAL_EFFORT_RANK.medium) -
        UNIVERSAL_EFFORT_RANK[nativeDefault],
      );
      const bestEffective = effortMapping[best];
      const bestDistance = Math.abs(
        (UNIVERSAL_EFFORT_RANK[bestEffective] ?? UNIVERSAL_EFFORT_RANK.medium) -
        UNIVERSAL_EFFORT_RANK[nativeDefault],
      );
      if (distance < bestDistance) return candidate;
      // Prefer the tier whose name matches the provider default. This keeps a
      // native `high` default displayed as High even when several requested
      // tiers collapse onto the same toggle/value.
      if (distance === bestDistance && candidate === nativeDefault) return candidate;
      return best;
    }, UNIVERSAL_REASONING_EFFORTS[0]);
  }
  return deepFreeze({
    efforts: [...UNIVERSAL_REASONING_EFFORTS],
    defaultEffort,
    effortMapping,
    nativeEfforts,
    nativeDefaultEffort: nativeDefault,
  });
}

export function providerUniversalReasoningPolicy(adapterInput, modelInput = '') {
  const native = providerModelReasoningPolicy(adapterInput, modelInput);
  return universalReasoningPolicy(native);
}

/**
 * Apply an optional administrator semantic remapping to the five stable UI
 * tiers, then project it through the provider/model capability table. The
 * configured values are application tiers rather than raw wire values, so an
 * override can never make an unsupported value (for example Kimi `xhigh`)
 * escape to the provider.
 */
export function resolveModelReasoningPolicy(
  adapterInput,
  modelInput = '',
  reasoningMappingInput = undefined,
) {
  const automatic = providerUniversalReasoningPolicy(adapterInput, modelInput);
  if (reasoningMappingInput === undefined || reasoningMappingInput === null) {
    return deepFreeze({
      ...automatic,
      reasoningMapping: { mode: 'auto' },
      automaticEffortMapping: { ...automatic.effortMapping },
    });
  }
  if (
    !reasoningMappingInput || typeof reasoningMappingInput !== 'object' ||
    Array.isArray(reasoningMappingInput)
  ) {
    fail('The model reasoning mapping is invalid.', 'MODEL_PROVIDER_EFFORT_MAPPING_INVALID');
  }
  const keys = Object.keys(reasoningMappingInput);
  if (keys.some((key) => !['mode', 'tiers'].includes(key))) {
    fail('The model reasoning mapping contains an unsupported field.',
      'MODEL_PROVIDER_EFFORT_MAPPING_INVALID');
  }
  const mode = String(reasoningMappingInput.mode || 'auto').trim().toLowerCase();
  if (!['auto', 'manual'].includes(mode)) {
    fail('The model reasoning mapping mode is invalid.',
      'MODEL_PROVIDER_EFFORT_MAPPING_INVALID');
  }
  if (mode === 'auto') {
    if (Object.hasOwn(reasoningMappingInput, 'tiers')) {
      fail('Automatic model reasoning mapping cannot include manual tiers.',
        'MODEL_PROVIDER_EFFORT_MAPPING_INVALID');
    }
    return deepFreeze({
      ...automatic,
      reasoningMapping: { mode: 'auto' },
      automaticEffortMapping: { ...automatic.effortMapping },
    });
  }
  const tiers = reasoningMappingInput.tiers;
  if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) {
    fail('Manual model reasoning mapping requires five tiers.',
      'MODEL_PROVIDER_EFFORT_MAPPING_INVALID');
  }
  const tierKeys = Object.keys(tiers);
  if (
    tierKeys.length !== UNIVERSAL_REASONING_EFFORTS.length ||
    tierKeys.some((key) => !UNIVERSAL_REASONING_EFFORTS.includes(key)) ||
    UNIVERSAL_REASONING_EFFORTS.some((key) => !Object.hasOwn(tiers, key))
  ) {
    fail('Manual model reasoning mapping must define exactly five tiers.',
      'MODEL_PROVIDER_EFFORT_MAPPING_INVALID');
  }
  const semanticTiers = {};
  const effortMapping = {};
  for (const requested of UNIVERSAL_REASONING_EFFORTS) {
    const semantic = String(tiers[requested] || '').trim().toLowerCase();
    if (semantic !== 'default' && !UNIVERSAL_REASONING_EFFORTS.includes(semantic)) {
      fail('A manual model reasoning tier is invalid.',
        'MODEL_PROVIDER_EFFORT_MAPPING_INVALID');
    }
    semanticTiers[requested] = semantic;
    effortMapping[requested] = semantic === 'default'
      ? 'default'
      : effectiveReasoningEffort(automatic, semantic);
  }
  return deepFreeze({
    ...automatic,
    effortMapping,
    reasoningMapping: { mode: 'manual', tiers: semanticTiers },
    automaticEffortMapping: { ...automatic.effortMapping },
  });
}

export function effectiveReasoningEffort(policyInput, requestedInput = '') {
  const requested = String(requestedInput || policyInput?.defaultEffort || 'medium')
    .trim().toLowerCase();
  if (requested === 'default') return 'default';
  if (!UNIVERSAL_REASONING_EFFORTS.includes(requested)) {
    fail('The requested reasoning effort is invalid.', 'MODEL_PROVIDER_EFFORT_INVALID');
  }
  const effective = String(policyInput?.effortMapping?.[requested] || '').trim().toLowerCase();
  if (effective !== 'default' && !REASONING_EFFORTS.has(effective)) {
    fail('The effective reasoning effort is invalid.', 'MODEL_PROVIDER_EFFORT_INVALID');
  }
  return effective || 'default';
}

function adapterValue(value) {
  if (!value || value.registryVersion !== REGISTRY_VERSION || !Object.hasOwn(DEFINITIONS, value.id)) {
    fail('The model provider adapter is invalid.', 'MODEL_PROVIDER_ADAPTER_INVALID');
  }
  return value;
}

export function listModelProviders() {
  return ORDER.map((id) => publicDefinition(DEFINITIONS[id]));
}

export function identifyModelProvider(input = {}) {
  let url;
  try { url = new URL(String(input.apiBase || '')); } catch { return 'custom'; }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (hostname === 'dashscope.aliyuncs.com') return 'bailian';
  if (hostname === 'api.deepseek.com') return 'deepseek';
  if (hostname === 'open.bigmodel.cn') return 'glm';
  if (hostname === 'api.moonshot.cn') return 'kimi';
  return 'custom';
}

export function resolveModelProvider(input = {}) {
  const providerId = normalizedProviderId(input.providerId || input.id);
  const definition = DEFINITIONS[providerId];
  const apiBase = normalizedApiBase(input.apiBase || definition.defaultApiBase);
  const protocol = normalizedProtocol(definition, input, apiBase);
  const authMode = normalizedAuthMode(definition, input, protocol);
  const reasoningStrategy = definition.reasoningByProtocol[protocol];
  const nativeReasoning = reasoningDefaults(reasoningStrategy);
  const legacy = reasoningDefaults(
    definition.legacyProfileByProtocol[protocol] === 'default' ? 'none' : reasoningStrategy,
  );
  return deepFreeze({
    registryVersion: REGISTRY_VERSION,
    id: definition.id,
    label: definition.label,
    apiBase,
    protocol,
    endpoint: endpointFor(apiBase, protocol),
    authMode,
    reasoningStrategy,
    reasoningEfforts: nativeReasoning.efforts,
    defaultReasoningEffort: nativeReasoning.defaultEffort,
    requestProfile: definition.legacyProfileByProtocol[protocol],
    efforts: legacy.efforts,
    defaultEffort: legacy.defaultEffort,
    docsUrl: definition.docsUrl,
    outputPolicy: {
      requestField: 'max_tokens',
      defaultTokens: DEFAULT_OUTPUT_TOKENS,
      applicationSafetyMaximumTokens: definition.defaultSafeOutputTokens,
      applicationSafetyMaximumResponseBytes: APPLICATION_MAX_RESPONSE_BYTES,
    },
  });
}

/**
 * Normalize only identifiers that the selected provider explicitly owns.
 * Custom providers and other first-party providers retain identifiers byte for
 * byte so a vendor-specific alias cannot be rewritten across trust boundaries.
 */
export function normalizeProviderModelId(adapterInput, modelInput = '') {
  const adapter = adapterValue(adapterInput);
  const model = String(modelInput || '').trim();
  return MODEL_ID_ALIASES[adapter.id]?.[model] || model;
}

export function providerModelOutputLimit(adapterInput, modelInput = '') {
  const adapter = adapterValue(adapterInput);
  const model = normalizeProviderModelId(adapter, modelInput).toLowerCase();
  let maximum = adapter.outputPolicy.applicationSafetyMaximumTokens;
  if (adapter.id === 'bailian' && /^qwen3\.8-max(?:-|$)/u.test(model)) {
    maximum = APPLICATION_MAX_OUTPUT_TOKENS;
  } else if (adapter.id === 'deepseek' && /^deepseek-v4(?:-|$)/u.test(model)) {
    maximum = APPLICATION_MAX_OUTPUT_TOKENS;
  } else if (adapter.id === 'glm') {
    if (/^glm-(?:5(?:\.|-|$)|4\.(?:6|7)(?:-|$))/u.test(model)) {
      maximum = APPLICATION_MAX_OUTPUT_TOKENS;
    } else if (/^glm-4\.5(?:-|$)/u.test(model)) {
      maximum = 98_304;
    }
  }
  return Math.min(APPLICATION_MAX_OUTPUT_TOKENS, Math.max(1, maximum));
}

export function providerModelReasoningPolicy(adapterInput, modelInput = '') {
  const adapter = adapterValue(adapterInput);
  const model = normalizeProviderModelId(adapter, modelInput).toLowerCase();
  if (
    adapter.id === 'kimi' && adapter.protocol === 'openai-chat-completions' &&
    /^kimi-k3(?:-|$)/u.test(model)
  ) {
    return { efforts: ['low', 'high', 'max'], defaultEffort: 'max' };
  }
  if (adapter.id === 'bailian' && adapter.protocol === 'anthropic-messages') {
    if (/^qwen3\.8-max(?:-|$)/u.test(model)) {
      return { efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh' };
    }
    if (/^kimi-k3(?:-|$)/u.test(model)) {
      return { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' };
    }
    if (/^deepseek-v4(?:-|$)/u.test(model)) {
      return { efforts: ['high', 'max'], defaultEffort: 'high' };
    }
  }
  return {
    efforts: [...adapter.efforts],
    defaultEffort: adapter.defaultEffort,
  };
}

export function providerModelCapabilities(adapterInput, modelInput = '') {
  const adapter = adapterValue(adapterInput);
  const model = normalizeProviderModelId(adapter, modelInput).toLowerCase();
  const kimiK3OpenAi = adapter.id === 'kimi' &&
    adapter.protocol === 'openai-chat-completions' && /^kimi-k3(?:-|$)/u.test(model);
  const deepseekOpenAi = adapter.id === 'deepseek' &&
    adapter.protocol === 'openai-chat-completions';
  const requiresCompleteAssistantReplay = kimiK3OpenAi || deepseekOpenAi;
  return deepFreeze({
    requiresCompleteAssistantReplay,
    assistantReasoningField: requiresCompleteAssistantReplay ? 'reasoning_content' : '',
  });
}

export function providerAuthHeaders(adapterInput, apiKeyInput = '') {
  const adapter = adapterValue(adapterInput);
  if (adapter.authMode === 'none') return {};
  const apiKey = String(apiKeyInput || '');
  if (
    apiKey.length < 8 || apiKey.length > 16_384 ||
    /[\s\u0000-\u001f\u007f]/u.test(apiKey)
  ) {
    fail('A valid model provider API key is required.', 'MODEL_PROVIDER_KEY_REQUIRED');
  }
  return adapter.authMode === 'bearer'
    ? { Authorization: `Bearer ${apiKey}` }
    : { 'x-api-key': apiKey };
}

export function providerReasoningFields(adapterInput, effortInput = 'default') {
  const adapter = adapterValue(adapterInput);
  if (adapter.reasoningStrategy === 'none') return {};
  const effort = String(effortInput || 'default').trim().toLowerCase();
  if (effort === 'default') return {};
  if (!REASONING_EFFORTS.has(effort)) {
    fail('The reasoning effort is invalid.', 'MODEL_PROVIDER_EFFORT_INVALID');
  }
  if (adapter.reasoningStrategy === 'anthropic-effort') {
    return { output_config: { effort } };
  }
  if (adapter.reasoningStrategy === 'deepseek-reasoning') {
    const mappedEffort = effort === 'low' ? 'low' : effort === 'max' ? 'max' : 'high';
    return {
      thinking: { type: 'enabled' },
      reasoning_effort: mappedEffort,
    };
  }
  if (adapter.reasoningStrategy === 'kimi-reasoning') {
    return { reasoning_effort: effort };
  }
  const enabled = !['minimal', 'low'].includes(effort);
  if (adapter.reasoningStrategy === 'bailian-thinking-toggle') {
    return { enable_thinking: enabled };
  }
  return { thinking: { type: enabled ? 'enabled' : 'disabled' } };
}

export function providerOutputFields(
  adapterInput,
  requestedTokens = DEFAULT_OUTPUT_TOKENS,
  modelInput = '',
) {
  const adapter = adapterValue(adapterInput);
  const parsed = Number(requestedTokens);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail('The model output token limit must be a positive integer.', 'MODEL_PROVIDER_OUTPUT_LIMIT_INVALID');
  }
  // This ceiling is an application safety bound, not a claim that every
  // provider or model accepts this many output tokens.
  const bounded = Math.min(parsed, providerModelOutputLimit(adapter, modelInput));
  return { [adapter.outputPolicy.requestField]: bounded };
}

export function buildProviderRequestPolicy(input = {}) {
  const adapter = resolveModelProvider(input);
  const actualModel = input.actualModel || input.model;
  const reasoning = resolveModelReasoningPolicy(adapter, actualModel, input.reasoningMapping);
  const requestedEffort = String(input.effort || 'default').trim().toLowerCase();
  const effectiveEffort = requestedEffort === 'default'
    ? 'default'
    : effectiveReasoningEffort(reasoning, requestedEffort);
  return {
    adapter,
    endpoint: adapter.endpoint,
    headers: providerAuthHeaders(adapter, input.apiKey),
    bodyFields: {
      ...providerOutputFields(
        adapter,
        input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
        actualModel,
      ),
      ...providerReasoningFields(adapter, effectiveEffort),
    },
  };
}

/**
 * Project one provider selection into the existing managed-v2 connection and
 * model fields. No credential or model identifier is included.
 */
export function legacyV2ProviderFields(input = {}) {
  const adapter = resolveModelProvider(input);
  const reasoning = providerModelReasoningPolicy(adapter, input.actualModel);
  return {
    protocol: adapter.protocol,
    authMode: adapter.authMode,
    requestProfile: adapter.requestProfile,
    efforts: reasoning.efforts,
    defaultEffort: reasoning.defaultEffort,
    endpointPreview: adapter.endpoint,
    docsUrl: adapter.docsUrl,
  };
}

export const modelProviderRegistryInternals = Object.freeze({
  REGISTRY_VERSION,
  APPLICATION_MAX_OUTPUT_TOKENS,
  APPLICATION_MAX_RESPONSE_BYTES,
  DEFAULT_OUTPUT_TOKENS,
  endpointFor,
  bailianProtocol,
});
