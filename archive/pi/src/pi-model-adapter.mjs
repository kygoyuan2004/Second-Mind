import crypto from 'node:crypto';

import {
  InMemoryCredentialStore,
  lazyApi,
} from '@earendil-works/pi-ai';
import {
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';

import { requestProfileReasoningFields } from './llm-client.mjs';
import {
  DEFAULT_PI_CONTEXT_WINDOW_TOKENS,
  MAX_PI_CONTEXT_WINDOW_TOKENS,
  MIN_PI_CONTEXT_WINDOW_TOKENS,
} from './pi-context-policy.mjs';

const PROTOCOL_APIS = Object.freeze({
  'anthropic-messages': 'anthropic-messages',
  'openai-chat-completions': 'openai-completions',
});
const AUTH_MODES = new Set(['bearer', 'x-api-key', 'none']);
const REQUEST_PROFILES = new Set([
  'default',
  'anthropic-standard',
  'openai-standard',
  'bailian-openai',
  'deepseek-openai',
  'glm-openai',
  'kimi-openai',
]);
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 900_000;
const KEYLESS_RUNTIME_CREDENTIAL = 'second-mind-keyless-transport';

const ZERO_COST = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export class PiModelAdapterError extends Error {
  constructor(message, code = 'PI_MODEL_ADAPTER_ERROR') {
    super(message);
    this.name = 'PiModelAdapterError';
    this.code = code;
  }
}

// Kept as an import-compatible denial for checkpoints/tests created by the
// earlier migration. Production validation and task execution never call it.
export class PiToolProbeError extends Error {
  constructor(message, code = 'PI_TOOL_PROBE_DISABLED') {
    super(message);
    this.name = 'PiToolProbeError';
    this.code = code;
  }
}

export async function probePiToolCalling() {
  throw new PiToolProbeError(
    'Pi tool-loop validation is disabled; only single-generation execution is permitted.',
  );
}

function adapterFail(message, code) {
  throw new PiModelAdapterError(message, code);
}

function normalizedText(value) {
  return String(value ?? '').trim();
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number)
    ? Math.min(maximum, Math.max(minimum, number))
    : fallback;
}

function normalizeBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    adapterFail('The Pi model binding is unavailable.', 'PI_MODEL_BINDING_INVALID');
  }
  const protocol = normalizedText(input.protocol).toLowerCase();
  const api = PROTOCOL_APIS[protocol];
  const authMode = normalizedText(input.authMode).toLowerCase();
  const requestProfile = normalizedText(input.requestProfile || (
    protocol === 'anthropic-messages' ? 'anthropic-standard' : 'default'
  )).toLowerCase();
  const apiBase = normalizedText(input.apiBase).replace(/\/+$/u, '');
  const apiKey = String(input.apiKey ?? '');
  const actualModel = normalizedText(input.actualModel || input.model);
  const providerId = normalizedText(input.providerId || input.provider || 'custom');
  const temperature = input.temperature === null || input.temperature === undefined
    ? null
    : Number(input.temperature);

  if (!api) adapterFail('The configured model protocol is not supported by Pi.', 'PI_MODEL_PROTOCOL_UNSUPPORTED');
  if (!AUTH_MODES.has(authMode)) {
    adapterFail('The configured model authentication mode is invalid.', 'PI_MODEL_AUTH_INVALID');
  }
  if (!REQUEST_PROFILES.has(requestProfile)) {
    adapterFail('The configured model request profile is invalid.', 'PI_MODEL_PROFILE_INVALID');
  }
  if (
    (protocol === 'anthropic-messages' && !['default', 'anthropic-standard'].includes(requestProfile))
    || (protocol === 'openai-chat-completions' && requestProfile === 'anthropic-standard')
  ) {
    adapterFail('The configured model request profile does not match its protocol.', 'PI_MODEL_PROFILE_INVALID');
  }
  let parsedBase;
  try {
    parsedBase = new URL(apiBase);
  } catch {
    adapterFail('The configured model API address is invalid.', 'PI_MODEL_ENDPOINT_INVALID');
  }
  if (
    !['https:', 'http:'].includes(parsedBase.protocol)
    || parsedBase.username
    || parsedBase.password
    || parsedBase.search
    || parsedBase.hash
  ) {
    adapterFail('The configured model API address is invalid.', 'PI_MODEL_ENDPOINT_INVALID');
  }
  if (!actualModel) adapterFail('The configured model ID is missing.', 'PI_MODEL_BINDING_INVALID');
  if (authMode !== 'none' && !apiKey) {
    adapterFail('The configured model credential is missing.', 'PI_MODEL_CREDENTIAL_MISSING');
  }
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    adapterFail('The configured model temperature is invalid.', 'PI_MODEL_BINDING_INVALID');
  }

  const contextWindow = boundedInteger(
    input.contextWindow,
    DEFAULT_PI_CONTEXT_WINDOW_TOKENS,
    MIN_PI_CONTEXT_WINDOW_TOKENS,
    MAX_PI_CONTEXT_WINDOW_TOKENS,
  );
  const maxOutputTokens = Math.min(contextWindow, boundedInteger(
    input.maxOutputTokens,
    DEFAULT_MAX_OUTPUT_TOKENS,
    128,
    1_000_000,
  ));
  return Object.freeze({
    protocol,
    api,
    authMode,
    requestProfile,
    apiBase,
    apiKey,
    actualModel,
    providerId,
    contextWindow,
    maxOutputTokens,
    temperature,
    requiresCompleteAssistantReplay: input.requiresCompleteAssistantReplay === true,
    assistantReasoningField: normalizedText(input.assistantReasoningField),
  });
}

function openAiCompat(profile) {
  const conservative = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    supportsFinishReason: true,
    maxTokensField: 'max_tokens',
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: false,
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  };
  if (profile === 'openai-standard') {
    return { ...conservative, supportsReasoningEffort: true, thinkingFormat: 'openai' };
  }
  if (profile === 'bailian-openai') {
    return { ...conservative, thinkingFormat: 'qwen' };
  }
  if (profile === 'deepseek-openai') {
    return { ...conservative, supportsReasoningEffort: true, thinkingFormat: 'deepseek' };
  }
  if (profile === 'glm-openai') {
    return { ...conservative, thinkingFormat: 'zai' };
  }
  if (profile === 'kimi-openai') {
    return {
      ...conservative,
      supportsReasoningEffort: true,
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
    };
  }
  return conservative;
}

function modelCompatibility(binding) {
  if (binding.api === 'openai-completions') {
    return {
      ...openAiCompat(binding.requestProfile),
      requiresReasoningContentOnAssistantMessages:
        binding.requiresCompleteAssistantReplay === true,
    };
  }
  // Anthropic-compatible gateways vary widely. Omit optional cache, eager
  // streaming, and strict-schema features until the real tool probe proves the
  // endpoint's core contract.
  return {
    supportsEagerToolInputStreaming: false,
    supportsLongCacheRetention: false,
    supportsCacheControlOnTools: false,
    supportsStrictTools: false,
    supportsToolReferences: false,
  };
}

const PI_TOP_LEVEL_REASONING_FIELDS = Object.freeze([
  'thinking',
  'reasoning_effort',
  'enable_thinking',
  'output_config',
]);

function removeCacheControls(value) {
  if (Array.isArray(value)) {
    for (const item of value) removeCacheControls(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  delete value.cache_control;
  for (const item of Object.values(value)) removeCacheControls(item);
}

function rewritePiRequestBody(binding, body, effortInput, maxOutputTokens) {
  if (body === undefined || body === null) return body;
  let text;
  if (typeof body === 'string') text = body;
  else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  else return body;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return body;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return body;

  // [1M] is a Claude execution/context selector, not a Model Studio model ID.
  // Keep it in the application binding (and its 1M context limit), but send
  // the gateway's actual ID on the wire. Do not rewrite arbitrary custom IDs.
  if (binding.api === 'anthropic-messages' && binding.providerId === 'bailian' &&
      /^(?:qwen3\.8-max(?:-0902)?|kimi-k3)\[1m\]$/iu.test(binding.actualModel)) {
    payload.model = binding.actualModel.replace(/\[1m\]$/iu, '');
  }

  // Pi's provider adapters intentionally offer broad defaults. Second Mind's
  // managed provider catalogue has a narrower, already-tested wire contract,
  // so normalize the final JSON at the pinned transport boundary.
  removeCacheControls(payload);
  delete payload.prompt_cache_key;
  delete payload.prompt_cache_retention;
  delete payload.betas;
  for (const field of PI_TOP_LEVEL_REASONING_FIELDS) delete payload[field];
  if (Number.isSafeInteger(Number(maxOutputTokens)) && Number(maxOutputTokens) > 0) {
    payload.max_tokens = Math.min(Number(maxOutputTokens), binding.maxOutputTokens);
  }
  Object.assign(payload, requestProfileReasoningFields(
    binding.requestProfile,
    normalizedText(effortInput).toLowerCase(),
  ));
  return JSON.stringify(payload);
}

function supportsConfiguredReasoning(binding) {
  return binding.requestProfile !== 'default';
}

function runtimeProviderId(binding) {
  const identity = [
    binding.providerId,
    binding.protocol,
    binding.requestProfile,
    binding.apiBase,
    binding.actualModel,
  ].join('\0');
  const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return `second-mind-${suffix}`;
}

function combinedSignal(...values) {
  const signals = values.filter((value) => value && typeof value.aborted === 'boolean');
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function sdkBaseUrl(binding) {
  const base = new URL(binding.apiBase);
  if (binding.api === 'anthropic-messages') {
    base.pathname = base.pathname
      .replace(/\/v1\/messages\/?$/u, '')
      .replace(/\/v1\/?$/u, '');
  } else {
    base.pathname = base.pathname.replace(/\/chat\/completions\/?$/u, '');
  }
  return base.href.replace(/\/+$/u, '');
}

async function requestBody(input, init) {
  if (Object.hasOwn(init, 'body')) return init.body;
  if (typeof Request !== 'undefined' && input instanceof Request && input.body) {
    return new Uint8Array(await input.clone().arrayBuffer());
  }
  return undefined;
}

/**
 * Wrap the application's DNS-pinned transport while making the configured web
 * credential authoritative. Provider SDK defaults are deliberately removed so
 * an Anthropic protocol can use bearer auth and an OpenAI protocol can use an
 * x-api-key without silently sending both credentials.
 */
function createConfiguredFetch(binding, fetchImpl, outerSignal, timeoutMs, effort, maxOutputTokens) {
  return async (input, init = {}) => {
    const fromRequest = typeof Request !== 'undefined' && input instanceof Request
      ? input
      : null;
    const rawUrl = fromRequest ? fromRequest.url : String(input);
    const parsedUrl = new URL(rawUrl);
    // Anthropic's public SDK routes the Messages request through its beta
    // resource and appends this fixed query marker. The project's pinned
    // transport intentionally rejects every query string; the actual feature
    // selection already travels in `anthropic-beta`, so remove only this exact
    // SDK marker and leave every other query to the transport's deny policy.
    if (binding.api === 'anthropic-messages' && parsedUrl.search === '?beta=true') {
      parsedUrl.search = '';
    }
    const url = parsedUrl.href;
    const headers = new Headers(fromRequest?.headers);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    headers.delete('authorization');
    headers.delete('x-api-key');
    headers.delete('anthropic-beta');
    if (binding.authMode === 'bearer') headers.set('authorization', `Bearer ${binding.apiKey}`);
    if (binding.authMode === 'x-api-key') headers.set('x-api-key', binding.apiKey);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = combinedSignal(init.signal, fromRequest?.signal, outerSignal, timeoutSignal);
    const body = rewritePiRequestBody(
      binding,
      await requestBody(input, init),
      effort,
      maxOutputTokens,
    );
    // The provider SDK may have computed this for its pre-normalized body.
    headers.delete('content-length');
    return fetchImpl(url, {
      ...init,
      method: init.method || fromRequest?.method || 'GET',
      headers,
      body,
      signal,
    });
  };
}

function defaultStreams(api) {
  if (api === 'anthropic-messages') {
    return lazyApi(() => import('@earendil-works/pi-ai/api/anthropic-messages'));
  }
  return lazyApi(() => import('@earendil-works/pi-ai/api/openai-completions'));
}

/**
 * Create a file-independent Pi runtime for one already-validated web binding.
 * No environment credential, auth file, models file, or global Pi setting is
 * consulted. `fetch` must be the application's existing pinned model fetch.
 */
export async function createPiModelAdapter(bindingInput, options = {}) {
  const binding = normalizeBinding(bindingInput);
  if (typeof options.fetch !== 'function') {
    adapterFail('A pinned model transport is required.', 'PI_MODEL_PINNED_FETCH_REQUIRED');
  }
  if (options.signal?.aborted) {
    adapterFail('Pi model adapter creation was cancelled.', 'PI_MODEL_ADAPTER_ABORTED');
  }
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const providerId = runtimeProviderId(binding);
  const baseUrl = sdkBaseUrl(binding);
  const reasoning = supportsConfiguredReasoning(binding);
  const streamProvider = options.streamFactory
    ? options.streamFactory(binding.api)
    : defaultStreams(binding.api);
  if (!streamProvider || typeof streamProvider.streamSimple !== 'function') {
    adapterFail('The Pi provider stream is unavailable.', 'PI_MODEL_STREAM_INVALID');
  }
  const streamSimple = (requestModel, context, requestOptions = {}) => {
    // Kimi fixes sampling parameters for its reasoning models and rejects a
    // caller-supplied temperature. Keep this as a final transport-side guard so
    // neither a web setting nor a future AgentSession option can reintroduce it.
    const temperature = binding.requestProfile === 'kimi-openai'
      ? undefined
      : Object.hasOwn(requestOptions, 'temperature')
        ? requestOptions.temperature
        : binding.temperature ?? undefined;
    return streamProvider.streamSimple(
      requestModel,
      context,
      {
        ...requestOptions,
        cacheRetention: 'none',
        temperature,
        fetch: createConfiguredFetch(
          binding,
          options.fetch,
          options.signal,
          timeoutMs,
          requestOptions.reasoning,
          requestOptions.maxTokens,
        ),
        timeoutMs: Math.min(
          timeoutMs,
          boundedInteger(requestOptions.timeoutMs, timeoutMs, 1, MAX_TIMEOUT_MS),
        ),
      },
    );
  };

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    signal: options.signal,
  });
  modelRuntime.registerProvider(providerId, {
    name: 'Second Mind web model',
    api: binding.api,
    baseUrl,
    // A non-secret configured fallback gives this otherwise-custom provider an
    // auth contract. The real credential remains only inside configuredFetch.
    apiKey: KEYLESS_RUNTIME_CREDENTIAL,
    authHeader: false,
    streamSimple,
    models: [{
      id: binding.actualModel,
      name: binding.actualModel,
      api: binding.api,
      baseUrl,
      reasoning,
      input: ['text'],
      cost: ZERO_COST,
      contextWindow: binding.contextWindow,
      maxTokens: binding.maxOutputTokens,
      ...(reasoning ? {
        thinkingLevelMap: Object.fromEntries([...THINKING_LEVELS].map((level) => [level, level])),
      } : {}),
      compat: modelCompatibility(binding),
    }],
  });
  // Never expose the real web credential to provider SDK heuristics. In
  // particular, Anthropic infers OAuth/Claude-Code mode from key text. The
  // pinned fetch closure alone applies the configured authentication mode.
  await modelRuntime.setRuntimeApiKey(providerId, KEYLESS_RUNTIME_CREDENTIAL, {
    signal: options.signal,
  });
  const model = modelRuntime.getModel(providerId, binding.actualModel);
  if (!model) adapterFail('Pi did not register the configured model.', 'PI_MODEL_REGISTRATION_FAILED');

  return Object.freeze({
    model,
    modelRuntime,
    thinkingLevelFor(effort) {
      const value = normalizedText(effort).toLowerCase();
      if (!reasoning || !value || value === 'default' || value === 'off') return 'off';
      if (!THINKING_LEVELS.has(value)) {
        adapterFail('The selected Pi reasoning effort is invalid.', 'PI_MODEL_EFFORT_INVALID');
      }
      return value;
    },
  });
}
