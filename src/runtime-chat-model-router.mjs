import crypto from 'node:crypto';

import { ChatModelClient, createPinnedModelFetch } from './llm-client.mjs';
import {
  effectiveReasoningEffort,
  identifyModelProvider,
  normalizeProviderModelId,
  providerModelCapabilities,
  providerModelOutputLimit,
  resolveModelReasoningPolicy,
  resolveModelProvider,
  universalReasoningPolicy,
} from './model-provider-registry.mjs';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CATALOG_REVISION = /^[a-f0-9]{64}$/u;
const PROTOCOLS = new Set(['anthropic-messages', 'openai-chat-completions']);
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
const VALIDATION_MESSAGES = Object.freeze([
  Object.freeze({ role: 'system', content: 'Connectivity check. Return a short response.' }),
  Object.freeze({ role: 'user', content: 'Reply with OK.' }),
]);
const VALIDATION_OUTPUT_TOKENS = 64;

export class RuntimeChatModelRouterError extends Error {
  constructor(message, code = 'RUNTIME_LLM_ERROR', status = 500, options = {}) {
    super(message, options);
    this.name = 'RuntimeChatModelRouterError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status = 500, options = {}) {
  throw new RuntimeChatModelRouterError(message, code, status, options);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedBase(value) {
  return String(value || '').trim().replace(/\/+$/u, '');
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * A non-secret transport/model identity used to decide whether an existing
 * conversation must fork. Deliberately excludes credentials and labels.
 */
export function modelConnectionBindingRevision(connection, model) {
  let actualModel = String(model?.actualModel || '').trim();
  let effortPolicy = universalReasoningPolicy({
    efforts: model?.efforts,
    defaultEffort: model?.defaultEffort,
  });
  try {
    const adapter = resolveModelProvider({
      providerId: String(connection?.providerId || identifyModelProvider(connection || {})),
      apiBase: normalizedBase(connection?.apiBase),
      protocol: connection?.protocol,
      authMode: connection?.authMode,
    });
    actualModel = normalizeProviderModelId(adapter, actualModel);
    effortPolicy = resolveModelReasoningPolicy(adapter, actualModel, model?.reasoningMapping);
  } catch {
    // Preserve compatibility with older hand-written v2 bindings. Invalid
    // transport details are rejected later by resolveBinding.
  }
  return digest({
    connectionId: String(connection?.id || ''),
    providerId: String(connection?.providerId || identifyModelProvider(connection || {})),
    protocol: String(connection?.protocol || ''),
    apiBase: normalizedBase(connection?.apiBase),
    authMode: String(connection?.authMode || ''),
    requestProfile: String(model?.requestProfile || 'default'),
    actualModel,
    effortMapping: effortPolicy.effortMapping,
    reasoningMapping: effortPolicy.reasoningMapping,
  });
}

function resolveBinding(snapshot, modelId) {
  if (!plainObject(snapshot)) {
    fail('The runtime model snapshot is unavailable.', 'MODEL_RUNTIME_UNAVAILABLE', 503);
  }
  const models = Array.isArray(snapshot.models) ? snapshot.models : [];
  const connections = Array.isArray(snapshot.connections) ? snapshot.connections : [];
  const requested = String(modelId || snapshot.defaultModelId || '').trim();
  const model = models.find((entry) => String(entry?.id || '') === requested);
  if (!model || !MODEL_ID.test(requested)) {
    fail('The selected model is not present in the current catalog.', 'MODEL_NOT_FOUND', 400);
  }
  if (model.enabled === false || model.available === false) {
    fail('The selected model is unavailable.', 'MODEL_UNAVAILABLE', 409);
  }
  const connectionId = String(model.connectionId || model.provider || '').trim();
  const connection = connections.find((entry) => String(entry?.id || '') === connectionId);
  if (!connection) {
    fail('The selected model connection is unavailable.', 'MODEL_CONNECTION_NOT_FOUND', 409);
  }
  const protocol = String(connection.protocol || '').trim().toLowerCase();
  const authMode = String(connection.authMode || '').trim().toLowerCase();
  const requestProfile = String(model.requestProfile || 'default').trim().toLowerCase();
  const apiBase = normalizedBase(connection.apiBase);
  const apiKey = String(connection.apiKey || '');
  const configuredActualModel = String(model.actualModel || '').trim();
  if (!PROTOCOLS.has(protocol) || !AUTH_MODES.has(authMode) || !REQUEST_PROFILES.has(requestProfile)) {
    fail('The selected model binding is invalid.', 'MODEL_BINDING_INVALID', 500);
  }
  if (
    (protocol === 'anthropic-messages' && !['default', 'anthropic-standard'].includes(requestProfile)) ||
    (protocol === 'openai-chat-completions' && requestProfile === 'anthropic-standard')
  ) {
    fail('The selected model request profile does not match its protocol.', 'MODEL_BINDING_INVALID', 500);
  }
  if (!apiBase || !configuredActualModel || (authMode !== 'none' && !apiKey)) {
    fail('The selected model connection is incomplete.', 'MODEL_CONNECTION_INCOMPLETE', 409);
  }
  let outputTokenLimit = 4_096;
  let actualModel = configuredActualModel;
  let effortPolicy = universalReasoningPolicy({
    efforts: model.efforts,
    defaultEffort: model.defaultEffort,
  });
  let modelCapabilities = Object.freeze({
    requiresCompleteAssistantReplay: false,
    assistantReasoningField: '',
  });
  try {
    const provider = resolveModelProvider({
      providerId: String(connection.providerId || identifyModelProvider(connection)),
      apiBase,
      protocol,
      authMode,
    });
    actualModel = normalizeProviderModelId(provider, configuredActualModel);
    outputTokenLimit = providerModelOutputLimit(provider, actualModel);
    effortPolicy = resolveModelReasoningPolicy(
      provider,
      actualModel,
      model.reasoningMapping,
    );
    modelCapabilities = providerModelCapabilities(provider, actualModel);
  } catch {
    // Older or hand-written v2 connections still need a fail-safe ceiling.
    // Connectivity validation can prove reachability, but cannot prove an
    // arbitrary compatible model accepts the deployment-wide 131K setting.
  }
  const efforts = Object.freeze([...effortPolicy.efforts]);
  const defaultEffort = effortPolicy.defaultEffort;
  const effortMapping = Object.freeze({ ...effortPolicy.effortMapping });
  const nonSecret = Object.freeze({
    id: requested,
    displayName: String(model.label || model.displayName || actualModel),
    shortLabel: String(model.shortLabel || model.label || model.displayName || actualModel),
    actualModel,
    connectionId,
    protocol,
    authMode,
    requestProfile,
    efforts,
    defaultEffort,
    effortMapping,
    reasoningMapping: effortPolicy.reasoningMapping,
    automaticEffortMapping: effortPolicy.automaticEffortMapping || effortPolicy.effortMapping,
    nativeEfforts: effortPolicy.nativeEfforts || [],
    requiresCompleteAssistantReplay: modelCapabilities.requiresCompleteAssistantReplay === true,
    assistantReasoningField: modelCapabilities.assistantReasoningField || '',
    bindingRevision: modelConnectionBindingRevision(connection, model),
    outputTokenLimit,
  });
  return {
    model: nonSecret,
    privateConfig: Object.freeze({
      protocol,
      provider: protocol === 'anthropic-messages' ? 'anthropic' : 'openai-compatible',
      authMode,
      requestProfile,
      apiBase,
      apiKey,
      model: actualModel,
    }),
  };
}

function finiteInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number)
    ? Math.min(maximum, Math.max(minimum, number))
    : fallback;
}

function safeValidationError(error, apiKey = '') {
  const candidateCode = String(error?.code || '').trim();
  const code = /^[A-Z][A-Z0-9_]{0,99}$/u.test(candidateCode)
    ? candidateCode
    : 'LLM_VALIDATION_REQUEST_FAILED';
  const message = ({
    LLM_AUTH_FAILED: 'API Key is invalid, expired, or lacks access to this model.',
    LLM_PAYMENT_REQUIRED: 'The provider account has insufficient balance or requires payment.',
    LLM_MODEL_NOT_FOUND: 'The configured model ID does not exist or is unavailable to this account.',
    LLM_ENDPOINT_NOT_FOUND: 'The configured API address does not expose the expected chat endpoint.',
    LLM_REQUEST_INCOMPATIBLE: 'The provider rejected one or more request parameters.',
    LLM_BAD_REQUEST: 'The provider rejected the validation request. Check API compatibility and model settings.',
    LLM_RATE_LIMITED: 'The provider rate limit or quota was exceeded.',
    LLM_EMPTY_RESPONSE: 'The provider returned an empty validation response.',
  })[code] || 'Model connection validation failed. Review the provider settings and try again.';
  // Provider text is intentionally discarded rather than redacted because it
  // may contain a private Base URL or account metadata unrelated to the key.
  void apiKey;
  return {
    code,
    message,
  };
}

async function mapWithConcurrency(values, maximum, operation) {
  const results = Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index], index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, maximum), values.length) },
    () => worker(),
  ));
  return results;
}

/**
 * Exercise one model binding with a deliberately small, privacy-safe request.
 *
 * ChatModelClient quite correctly rejects token-limited output for normal task
 * traffic so TaskManager can continue an incomplete answer. A connectivity
 * check has a narrower purpose: a structurally valid provider response proves
 * the endpoint, credential, and model binding work. Some reasoning models can
 * consume the entire tiny probe budget before emitting visible answer text, so
 * their otherwise-valid response may end at `length`/`max_tokens`. Keep that
 * validation-only exception here instead of weakening the generation client's
 * completeness contract.
 */
async function runConnectionProbe(lease, options = {}) {
  let receivedUsableText = false;
  try {
    const output = await lease.generate(VALIDATION_MESSAGES, {
      // Connectivity validation must exercise only the common request
      // envelope. Vendor-specific reasoning controls are tested by normal
      // task traffic, not by this low-cost probe.
      effort: 'default',
      // Several compatible gateways reject extremely small output limits.
      // Keep the check inexpensive while remaining inside their accepted
      // request envelope.
      maxOutputTokens: VALIDATION_OUTPUT_TOKENS,
      temperature: null,
      stream: false,
      signal: options.signal,
      onToken(token) {
        // Retain only a boolean. Provider output must never be copied into a
        // validation receipt, log, exception, or administrator response.
        if (!receivedUsableText && /\S/u.test(String(token || ''))) {
          receivedUsableText = true;
        }
      },
    });
    if (!receivedUsableText && /\S/u.test(String(output || ''))) {
      receivedUsableText = true;
    }
    if (!receivedUsableText) {
      fail('Model returned an empty response.', 'LLM_EMPTY_RESPONSE', 502);
    }
    return Object.freeze({ truncated: false });
  } catch (error) {
    if (error?.code === 'LLM_OUTPUT_TRUNCATED') {
      return Object.freeze({ truncated: true, outputObserved: receivedUsableText });
    }
    throw error;
  }
}

export class RuntimeChatModelRouter {
  constructor(options = {}) {
    this.registry = options.registry || null;
    this.baseConfig = Object.freeze({
      timeoutMs: finiteInteger(options.baseConfig?.timeoutMs, 120_000, 1_000, 900_000),
      maxOutputTokens: finiteInteger(options.baseConfig?.maxOutputTokens, 3_000, 128, 131_072),
      temperature: Number.isFinite(options.baseConfig?.temperature)
        ? options.baseConfig.temperature
        : null,
      allowInsecureHttp: options.baseConfig?.allowInsecureHttp === true,
    });
    this.clientFactory = options.clientFactory || ((config, clientOptions) => (
      new ChatModelClient(config, clientOptions)
    ));
    this.fetch = options.fetch || createPinnedModelFetch({
      lookup: options.lookup,
      httpsRequest: options.httpsRequest || options.request,
      httpRequest: options.httpRequest,
      allowInsecureHttp: this.baseConfig.allowInsecureHttp,
      maxResponseBytes: options.maxResponseBytes,
    });
  }

  createLease(snapshot, modelId) {
    const binding = resolveBinding(snapshot, modelId);
    const maximumOutputTokens = Math.min(
      this.baseConfig.maxOutputTokens,
      binding.model.outputTokenLimit,
    );
    const client = this.clientFactory(Object.freeze({
      ...this.baseConfig,
      maxOutputTokens: maximumOutputTokens,
      ...binding.privateConfig,
    }), { fetch: this.fetch });
    Object.freeze(client);
    const generate = (messages, options = {}) => {
      const requestedOutputTokens = Number(options.maxOutputTokens);
      const maxOutputTokens = Number.isSafeInteger(requestedOutputTokens) && requestedOutputTokens > 0
        ? Math.min(requestedOutputTokens, maximumOutputTokens)
        : maximumOutputTokens;
      const requestedEffort = String(options.effort || options.reasoningEffort || 'default')
        .trim().toLowerCase();
      const effectiveEffort = requestedEffort === 'default'
        ? 'default'
        : effectiveReasoningEffort(binding.model, requestedEffort);
      return client.generate(messages, {
        ...options,
        effort: effectiveEffort,
        maxOutputTokens,
        model: binding.model.actualModel,
      });
    };
    const lease = {
      // Callers pass the stable application tier. This lease owns the single
      // projection to the provider's native wire value.
      mapsRequestedEffort: true,
      model: binding.model,
      modelId: binding.model.id,
      actualModel: binding.model.actualModel,
      connectionId: binding.model.connectionId,
      bindingRevision: binding.model.bindingRevision,
      catalogRevision: String(snapshot.modelCatalogRevision || ''),
      configurationRevision: String(snapshot.revision || ''),
      maxOutputTokens: maximumOutputTokens,
      efforts: binding.model.efforts,
      defaultEffort: binding.model.defaultEffort,
      effortMapping: binding.model.effortMapping,
      reasoningMapping: binding.model.reasoningMapping,
      automaticEffortMapping: binding.model.automaticEffortMapping,
      nativeEfforts: binding.model.nativeEfforts,
      requiresCompleteAssistantReplay: binding.model.requiresCompleteAssistantReplay,
      assistantReasoningField: binding.model.assistantReasoningField,
    };
    Object.defineProperties(lease, {
      client: { value: client, enumerable: false, writable: false, configurable: false },
      generate: { value: generate, enumerable: false, writable: false, configurable: false },
    });
    return Object.freeze(lease);
  }

  async acquireForTask(input = {}) {
    const options = typeof input === 'string' ? { modelId: input } : (input || {});
    let snapshot = options.snapshot;
    if (!snapshot) {
      if (!this.registry) fail('The runtime model registry is unavailable.', 'MODEL_RUNTIME_UNAVAILABLE', 503);
      await this.registry.refresh?.();
      snapshot = this.registry.runtimeSnapshot();
    }
    const expected = String(options.expectedCatalogRevision || options.modelCatalogRevision || '')
      .trim().toLowerCase();
    const current = String(snapshot?.modelCatalogRevision || '').trim().toLowerCase();
    if (expected && (!CATALOG_REVISION.test(expected) || expected !== current)) {
      fail('The model catalog changed before the task was created.', 'MODEL_CATALOG_CHANGED', 409);
    }
    return this.createLease(snapshot, options.modelId);
  }

  async validateSnapshot(snapshot, options = {}) {
    return this.validateAllEnabled(snapshot, options);
  }

  async validateAllEnabled(snapshot, options = {}) {
    if (!plainObject(snapshot) || !Array.isArray(snapshot.models)) {
      fail('The runtime model snapshot is unavailable.', 'MODEL_RUNTIME_UNAVAILABLE', 503);
    }
    let selectedIds = null;
    if (options.modelIds !== undefined) {
      if (!Array.isArray(options.modelIds) || !options.modelIds.length) {
        fail('At least one validation model is required.', 'MODEL_VALIDATION_TARGET_EMPTY', 400);
      }
      selectedIds = new Set(options.modelIds.map((entry) => String(entry || '').trim()));
    }
    const enabled = snapshot.models.filter((model) => (
      model?.enabled !== false && (!selectedIds || selectedIds.has(String(model?.id || '')))
    ));
    if (!enabled.length) {
      fail(
        selectedIds ? 'The selected provider has no enabled model.' : 'At least one enabled model is required.',
        selectedIds ? 'MODEL_VALIDATION_TARGET_EMPTY' : 'MODEL_CATALOG_EMPTY',
        400,
      );
    }
    const concurrency = Math.min(2, Math.max(1, Number(options.concurrency) || 2));
    const results = await mapWithConcurrency(enabled, concurrency, async (model) => {
      const modelId = String(model?.id || '');
      let lease;
      try {
        lease = this.createLease(snapshot, modelId);
        await runConnectionProbe(lease, { signal: options.signal });
        const result = Object.freeze({ modelId, ok: true, code: '', message: '' });
        await options.onResult?.(result);
        return result;
      } catch (error) {
        const connection = Array.isArray(snapshot.connections)
          ? snapshot.connections.find((entry) => String(entry?.id || '') === String(model?.connectionId || model?.provider || ''))
          : null;
        const failure = safeValidationError(error, String(connection?.apiKey || ''));
        const result = Object.freeze({ modelId, ok: false, ...failure });
        await options.onResult?.(result);
        return result;
      }
    });
    const failed = results.filter((entry) => !entry.ok);
    if (failed.length) {
      const error = new RuntimeChatModelRouterError(
        `${failed.length} enabled model connection${failed.length === 1 ? '' : 's'} failed validation.`,
        'LLM_VALIDATION_FAILED',
        400,
      );
      error.results = Object.freeze(results);
      throw error;
    }
    return Object.freeze({
      ok: true,
      checked: results.length,
      results: Object.freeze(results),
    });
  }
}

export async function validateSnapshot(snapshot, options = {}) {
  const router = new RuntimeChatModelRouter(options);
  return router.validateSnapshot(snapshot, options);
}

export async function validateAllEnabled(snapshot, options = {}) {
  return validateSnapshot(snapshot, options);
}

export const runtimeChatModelInternals = {
  VALIDATION_MESSAGES, VALIDATION_OUTPUT_TOKENS,
  mapWithConcurrency,
  normalizedBase,
  resolveBinding,
  runConnectionProbe,
  safeValidationError,
};
