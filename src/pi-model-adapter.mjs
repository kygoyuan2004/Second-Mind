import crypto from 'node:crypto';

import {
  InMemoryCredentialStore,
  Type,
  lazyApi,
} from '@earendil-works/pi-ai';
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  defineTool,
} from '@earendil-works/pi-coding-agent';

import { requestProfileReasoningFields } from './llm-client.mjs';

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
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 900_000;
const MAX_PROBE_TIMEOUT_MS = 120_000;
const MAX_PROBE_ASSISTANT_TURNS = 2;
const MAX_PROBE_TOOL_CALLS = 1;
const PROBE_TOOL_NAME = 'second_mind_capability_nonce';
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

export class PiToolProbeError extends Error {
  constructor(message, code = 'PI_TOOL_PROBE_FAILED') {
    super(message);
    this.name = 'PiToolProbeError';
    this.code = code;
  }
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
    DEFAULT_CONTEXT_WINDOW,
    4_096,
    2_000_000,
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

function rewritePiRequestBody(binding, body, effortInput) {
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

  // Pi's provider adapters intentionally offer broad defaults. Second Mind's
  // managed provider catalogue has a narrower, already-tested wire contract,
  // so normalize the final JSON at the pinned transport boundary.
  removeCacheControls(payload);
  delete payload.prompt_cache_key;
  delete payload.prompt_cache_retention;
  delete payload.betas;
  for (const field of PI_TOP_LEVEL_REASONING_FIELDS) delete payload[field];
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
function createConfiguredFetch(binding, fetchImpl, outerSignal, timeoutMs, effort) {
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
    const body = rewritePiRequestBody(binding, await requestBody(input, init), effort);
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

function isolatedResourceLoader(systemPrompt) {
  const runtime = createExtensionRuntime();
  const extensions = Object.freeze({ extensions: Object.freeze([]), errors: Object.freeze([]), runtime });
  const emptyDiagnostics = Object.freeze({
    diagnostics: Object.freeze([]),
  });
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ ...emptyDiagnostics, skills: [] }),
    getPrompts: () => ({ ...emptyDiagnostics, prompts: [] }),
    getThemes: () => ({ ...emptyDiagnostics, themes: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function messageText(message) {
  if (!Array.isArray(message?.content)) return typeof message?.content === 'string' ? message.content : '';
  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text || ''))
    .join('');
}

function summedMessageUsage(messages) {
  const total = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    reasoning: 0, totalTokens: 0,
  };
  let available = false;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant' || !message.usage) continue;
    available = true;
    for (const field of Object.keys(total)) {
      const value = Number(message.usage[field]);
      if (Number.isFinite(value) && value >= 0) total[field] += value;
    }
  }
  return available ? total : null;
}

function probeError(message, code) {
  return new PiToolProbeError(message, code);
}

function randomNonce() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Prove that the configured endpoint supports a complete Pi tool loop. The
 * result nonce is created inside the tool and is absent from the prompt, so a
 * successful probe requires one model turn to call the tool and a later model
 * turn to consume its result.
 */
export async function probePiToolCalling(binding, options = {}) {
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    1,
    MAX_PROBE_TIMEOUT_MS,
  );
  if (options.signal?.aborted) {
    throw probeError('The Pi tool capability check was cancelled.', 'PI_TOOL_PROBE_ABORTED');
  }
  const controller = new AbortController();
  const challengeNonce = randomNonce();
  const resultNonce = randomNonce();
  let toolCalls = 0;
  let assistantTurnStarts = 0;
  let limitError = null;
  let session;
  let unsubscribe = () => {};
  let timedOut = false;
  const relayAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', relayAbort, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort(probeError('The Pi tool capability check timed out.', 'PI_TOOL_PROBE_TIMEOUT'));
  }, timeoutMs);

  try {
    const adapterFactory = options.adapterFactory || createPiModelAdapter;
    const adapter = await adapterFactory(binding, {
      fetch: options.fetch,
      signal: controller.signal,
      timeoutMs,
      streamFactory: options.streamFactory,
    });
    const tool = defineTool({
      name: PROBE_TOOL_NAME,
      label: 'Verify model tool calling',
      description: 'Return an unpredictable capability proof for the supplied challenge nonce.',
      parameters: Type.Object({
        nonce: Type.String({ minLength: 1, maxLength: 128 }),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      async execute(_toolCallId, params) {
        toolCalls += 1;
        if (toolCalls > MAX_PROBE_TOOL_CALLS) {
          limitError ||= probeError(
            'The Pi tool capability check exceeded its one-call budget.',
            'PI_TOOL_PROBE_LIMIT',
          );
          controller.abort(limitError);
          void Promise.resolve(session?.abort?.()).catch(() => {});
          throw limitError;
        }
        if (params.nonce !== challengeNonce) {
          throw new Error('Capability challenge mismatch.');
        }
        return {
          content: [{ type: 'text', text: `capability-proof:${resultNonce}` }],
          details: { verified: true },
        };
      },
    });
    const resourceLoader = isolatedResourceLoader([
      'You are testing whether this model endpoint supports client tools.',
      `Call ${PROBE_TOOL_NAME} exactly once with the nonce supplied by the user.`,
      'After the tool returns, reply with the exact capability-proof value from the tool result.',
      'Do not invent or transform the value.',
    ].join(' '));
    const createSession = options.sessionFactory || createAgentSession;
    const created = await createSession({
      cwd: '/',
      model: adapter.model,
      modelRuntime: adapter.modelRuntime,
      thinkingLevel: 'off',
      noTools: 'all',
      tools: [PROBE_TOOL_NAME],
      customTools: [tool],
      resourceLoader,
      sessionManager: SessionManager.inMemory('/'),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false, maxRetries: 0 },
        defaultTools: [],
        packages: [],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
        enableSkillCommands: false,
        defaultProjectTrust: 'never',
        httpIdleTimeoutMs: timeoutMs,
      }, { projectTrusted: false }),
    });
    session = created?.session || created;
    if (!session || typeof session.prompt !== 'function') {
      throw probeError('The Pi probe session could not be created.', 'PI_TOOL_PROBE_SESSION_INVALID');
    }
    if (typeof session.subscribe === 'function') {
      unsubscribe = session.subscribe((event) => {
        if (event?.type !== 'turn_start') return;
        assistantTurnStarts += 1;
        if (assistantTurnStarts <= MAX_PROBE_ASSISTANT_TURNS || limitError) return;
        limitError = probeError(
          'The Pi tool capability check exceeded its two-turn budget.',
          'PI_TOOL_PROBE_LIMIT',
        );
        controller.abort(limitError);
        void Promise.resolve(session.abort?.()).catch(() => {});
      });
    }

    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    await Promise.race([
      (async () => {
        await session.prompt(
          `Use the required capability tool now. Invocation nonce: ${challengeNonce}`,
          { expandPromptTemplates: false, source: 'rpc' },
        );
        await session.waitForIdle?.();
      })(),
      aborted,
    ]);

    if (toolCalls < 1) {
      throw probeError('The model did not execute the required Pi tool.', 'PI_TOOL_CALL_REQUIRED');
    }
    const messages = Array.isArray(session.state?.messages) ? session.state.messages : [];
    const toolResultIndex = messages.findIndex((message) => (
      message?.role === 'toolResult' && message.toolName === PROBE_TOOL_NAME
    ));
    const observedResult = toolResultIndex >= 0 && messages.slice(toolResultIndex + 1).some((message) => (
      message?.role === 'assistant' && messageText(message).includes(resultNonce)
    ));
    if (!observedResult) {
      throw probeError(
        'The model did not consume the Pi tool result in a later response.',
        'PI_TOOL_RESULT_NOT_OBSERVED',
      );
    }
    const assistantTurns = messages.filter((message) => message?.role === 'assistant').length;
    if (toolCalls > MAX_PROBE_TOOL_CALLS || assistantTurns > MAX_PROBE_ASSISTANT_TURNS) {
      throw probeError(
        'The Pi tool capability check exceeded its bounded loop.',
        'PI_TOOL_PROBE_LIMIT',
      );
    }
    if (assistantTurns < 2) {
      throw probeError('The model did not complete a two-turn Pi tool loop.', 'PI_TOOL_ROUND_TRIP_INCOMPLETE');
    }
    return Object.freeze({
      ok: true,
      code: 'PI_TOOL_CALL_VERIFIED',
      toolCalls,
      assistantTurns,
      usage: summedMessageUsage(messages),
    });
  } catch (error) {
    if (limitError) throw limitError;
    if (error instanceof PiToolProbeError) throw error;
    if (timedOut) {
      throw probeError('The Pi tool capability check timed out.', 'PI_TOOL_PROBE_TIMEOUT');
    }
    if (options.signal?.aborted || controller.signal.aborted) {
      throw probeError('The Pi tool capability check was cancelled.', 'PI_TOOL_PROBE_ABORTED');
    }
    if (error instanceof PiModelAdapterError) {
      throw probeError('The Pi model binding cannot be used for tool calling.', 'PI_TOOL_PROBE_BINDING_INVALID');
    }
    // Provider exceptions are intentionally not copied: compatible gateways
    // sometimes echo an endpoint, credential, or account metadata in errors.
    throw probeError('The Pi tool capability request failed.', 'PI_TOOL_PROBE_REQUEST_FAILED');
  } finally {
    clearTimeout(deadline);
    unsubscribe();
    options.signal?.removeEventListener('abort', relayAbort);
    if (session?.isStreaming) await session.abort().catch(() => {});
    session?.dispose?.();
  }
}
