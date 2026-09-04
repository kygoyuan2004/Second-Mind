import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

import { isPublicAddress } from './safe-web-reader.mjs';

function providerError(message, code = 'LLM_ERROR', cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function classifyProviderResponseError(status, detail = '') {
  const text = String(detail || '').toLowerCase().replace(/[_-]+/gu, ' ');
  if (status === 401 || status === 403) return 'LLM_AUTH_FAILED';
  if (status === 402) return 'LLM_PAYMENT_REQUIRED';
  if (status === 429) return 'LLM_RATE_LIMITED';
  if (/(invalid|incorrect|expired|missing)[ -]?(?:api )?key|authentication (?:fail(?:ed|s|ure)?|required)|unauthorized|permission denied|鉴权|密钥(?:无效|错误|过期)/u.test(text)) {
    return 'LLM_AUTH_FAILED';
  }
  if (/\bmodel\b/u.test(text) && /(not found|not exist|unknown|invalid|unsupported|does not exist|no such|不存在|无效)/u.test(text)) {
    return 'LLM_MODEL_NOT_FOUND';
  }
  if (status === 404) return 'LLM_ENDPOINT_NOT_FOUND';
  if ([400, 422].includes(status) && /(parameter|argument|field|max[ -]?tokens|thinking|effort|不支持|参数)/u.test(text)) {
    return 'LLM_REQUEST_INCOMPATIBLE';
  }
  if (status === 400) return 'LLM_BAD_REQUEST';
  if (status >= 500) return 'LLM_PROVIDER_UNAVAILABLE';
  return 'LLM_API_ERROR';
}

function redactProviderDetail(value, apiKey = '') {
  let safe = String(value || '').replace(/[\r\n]+/gu, ' ');
  if (apiKey) safe = safe.split(apiKey).join('[redacted]');
  safe = safe
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/giu, '[redacted]')
    .replace(/((?:api[-_ ]?key|authorization|credential)\s*[:=]\s*["']?)[^\s,"'}]{8,}/giu, '$1[redacted]');
  return safe.slice(0, 500);
}

function endpoint(base, suffix) {
  const clean = String(base || '').replace(/\/+$/, '');
  if (clean.endsWith(suffix)) return clean;
  if (suffix.startsWith('/v1/') && clean.endsWith('/v1')) {
    return `${clean}${suffix.slice('/v1'.length)}`;
  }
  return `${clean}${suffix}`;
}

function isLocalHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === 'host.docker.internal' || value === '::1' ||
    value === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

export function assertSafeProviderUrl(urlInput, allowInsecureHttp = false) {
  let url;
  try {
    url = new URL(urlInput);
  } catch {
    throw providerError('Model provider URL is invalid.', 'LLM_INVALID_ENDPOINT');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw providerError('Model provider URL must use HTTP or HTTPS.', 'LLM_INVALID_ENDPOINT');
  }
  if (url.username || url.password) {
    throw providerError('Model provider credentials must be supplied through an API-key secret, not the URL.', 'LLM_INVALID_ENDPOINT');
  }
  if (url.protocol === 'http:' && !isLocalHostname(url.hostname) && !allowInsecureHttp) {
    throw providerError(
      'Plain HTTP is only allowed for loopback model providers. Set ALLOW_INSECURE_PROVIDER_HTTP=true only on a trusted private network.',
      'LLM_INSECURE_ENDPOINT',
    );
  }
  return url.href;
}

async function readResponseText(response, signal, maxBytes) {
  if (!response.body) return '';
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw providerError('Model provider response exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = '';
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw providerError('Model provider response exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function responseError(response, apiKey = '', signal) {
  const raw = await readResponseText(response, signal, 64 * 1024).catch((error) => {
    if (error?.code === 'LLM_RESPONSE_TOO_LARGE' || signal?.aborted) throw error;
    return '';
  });
  let message = '';
  try {
    const payload = JSON.parse(raw);
    const providerErrorValue = payload?.error;
    message = [
      providerErrorValue?.message || payload?.message,
      providerErrorValue?.type,
      providerErrorValue?.code,
    ].filter(Boolean).join(' · ');
  } catch {}
  const safe = redactProviderDetail(message || `HTTP ${response.status}`, apiKey);
  const error = providerError(
    `Model provider request failed: ${safe}`,
    classifyProviderResponseError(Number(response.status), safe),
  );
  error.status = Number(response.status) || 502;
  return error;
}

async function readSse(response, onEvent, signal, limits = {}) {
  if (!response.body) throw providerError('Model provider returned no response body.', 'LLM_INVALID_RESPONSE');
  const maxBytes = Number(limits.maxBytes) || 8 * 1024 * 1024;
  const maxBufferCharacters = Number(limits.maxBufferCharacters) || 512 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw providerError('Model provider stream exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = '';
  let sawDone = false;
  let eventCount = 0;
  const dispatchBlock = async (block) => {
    const data = String(block || '').split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    eventCount += 1;
    await onEvent(data, block);
  };
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      bytes += value?.byteLength || 0;
      if (bytes > maxBytes) {
        throw providerError('Model provider stream exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
      }
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (buffer.length > maxBufferCharacters && !/\r?\n\r?\n/.test(buffer)) {
        throw providerError('Model provider stream event exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
      }
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        await dispatchBlock(block);
      }
      if (done) break;
    }
    // A valid final SSE event is allowed to end at EOF without another blank
    // line. Parse it instead of silently discarding its stop reason or usage.
    if (buffer.trim()) await dispatchBlock(buffer);
    return Object.freeze({ sawDone, eventCount });
  } finally {
    reader.releaseLock();
  }
}

function normalizeMessages(messages, options = {}) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const role = ['system', 'assistant'].includes(message?.role) ? message.role : 'user';
    const normalized = {
      role,
      content: String(message?.content || ''),
    };
    // Kimi K3 requires a previously returned assistant message to be replayed
    // intact. Keep the provider field only on assistant messages; it is never
    // surfaced through token/progress callbacks and normal application
    // histories do not synthesize it.
    if (
      options.allowAssistantReasoning === true
      && role === 'assistant'
      && typeof message?.reasoning_content === 'string'
    ) {
      normalized.reasoning_content = message.reasoning_content;
    }
    return normalized;
  }).filter((message) => message.content || (
    message.role === 'assistant' && message.reasoning_content
  ));
}

const USAGE_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningTokens',
  'totalTokens',
]);
const TRUNCATED_STOP_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
  'model_context_window_exceeded',
  'token_limit',
]);
const KNOWN_STOP_REASONS = new Set([
  ...TRUNCATED_STOP_REASONS,
  'stop',
  'end_turn',
  'stop_sequence',
  'content_filter',
  'tool_calls',
  'function_call',
  'pause_turn',
  'refusal',
  'safety',
]);
const BLOCKED_STOP_REASONS = new Set(['content_filter', 'refusal', 'safety']);
const UNSUPPORTED_STOP_REASONS = new Set(['tool_calls', 'function_call']);
const INCOMPLETE_STOP_REASONS = new Set(['pause_turn']);

function tokenCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function firstTokenCount(...values) {
  for (const value of values) {
    const count = tokenCount(value);
    if (count !== null) return count;
  }
  return null;
}

function nestedTokenSum(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const counts = Object.values(value).map(tokenCount).filter((count) => count !== null);
  return counts.length ? counts.reduce((total, count) => total + count, 0) : null;
}

/**
 * Normalize only counters explicitly reported by a provider. Missing counters
 * remain null rather than being presented as measured zeroes.
 */
function derivedTotalTokens(usage, protocol = '') {
  if (usage?.inputTokens === null || usage?.outputTokens === null) return null;
  let total = usage.inputTokens + usage.outputTokens;
  if (protocol === 'anthropic-messages') {
    // Anthropic reports cache creation/read as input-token classes separate
    // from input_tokens. OpenAI's cached_tokens is instead a subset of
    // prompt_tokens and must not be added a second time.
    total += usage.cacheReadInputTokens || 0;
    total += usage.cacheCreationInputTokens || 0;
  }
  return total;
}

function normalizeModelUsage(value, protocol = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const promptDetails = value.prompt_tokens_details || value.input_tokens_details || {};
  const completionDetails = value.completion_tokens_details || value.output_tokens_details || {};
  const inputTokens = firstTokenCount(
    value.inputTokens,
    value.input_tokens,
    value.prompt_tokens,
  );
  const outputTokens = firstTokenCount(
    value.outputTokens,
    value.output_tokens,
    value.completion_tokens,
  );
  const usage = {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: firstTokenCount(
      value.cacheReadInputTokens,
      value.cache_read_input_tokens,
      value.cached_input_tokens,
      promptDetails.cached_tokens,
    ),
    cacheCreationInputTokens: firstTokenCount(
      value.cacheCreationInputTokens,
      value.cache_creation_input_tokens,
      value.cache_write_input_tokens,
      nestedTokenSum(value.cache_creation),
    ),
    reasoningTokens: firstTokenCount(
      value.reasoningTokens,
      value.reasoning_tokens,
      completionDetails.reasoning_tokens,
    ),
    totalTokens: firstTokenCount(value.totalTokens, value.total_tokens),
  };
  if (usage.totalTokens === null) usage.totalTokens = derivedTotalTokens(usage, protocol);
  return USAGE_FIELDS.some((field) => usage[field] !== null)
    ? Object.freeze(usage)
    : null;
}

function mergeModelUsage(current, update, protocol = '') {
  if (!update) return current;
  const merged = {};
  for (const field of USAGE_FIELDS) {
    merged[field] = update[field] !== null && update[field] !== undefined
      ? update[field]
      : current?.[field] ?? null;
  }
  if (update.totalTokens === null && USAGE_FIELDS.some((field) => (
    field !== 'totalTokens' && update[field] !== null
  ))) merged.totalTokens = derivedTotalTokens(merged, protocol);
  return Object.freeze(merged);
}

function sameUsage(left, right) {
  return left === right || USAGE_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function normalizeStopReason(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[ -]+/gu, '_');
  // Stop reasons are control metadata, never free-form provider text. Keeping
  // only a compact identifier prevents a hostile gateway from reflecting
  // prompt/output content into progress events or logs through this field.
  return KNOWN_STOP_REASONS.has(normalized) ? normalized : normalized ? 'unknown' : '';
}

function isTruncatedStopReason(value) {
  return TRUNCATED_STOP_REASONS.has(normalizeStopReason(value));
}

async function callTelemetryCallback(callback, event) {
  if (typeof callback === 'function') await callback(event);
}

function createModelTelemetry(protocol, options = {}) {
  let cumulativeUsage = null;
  let stopReason = '';
  const usageEvent = async (phase) => {
    const event = Object.freeze({
      type: 'model_usage',
      phase,
      protocol,
      stopReason: stopReason || null,
      usageAvailable: Boolean(cumulativeUsage),
      usage: cumulativeUsage,
      // Explicit alias for consumers that aggregate several model calls.
      // Within one call, provider snapshots are merged rather than summed.
      cumulativeUsage,
    });
    await callTelemetryCallback(options.onUsage, event);
    return event;
  };
  return Object.freeze({
    get stopReason() { return stopReason; },
    get usage() { return cumulativeUsage; },
    get truncated() { return isTruncatedStopReason(stopReason); },
    observeStopReason(value) {
      const normalized = normalizeStopReason(value);
      if (normalized) stopReason = normalized;
    },
    async observeUsage(rawUsage) {
      const next = mergeModelUsage(
        cumulativeUsage,
        normalizeModelUsage(rawUsage, protocol),
        protocol,
      );
      if (!next || sameUsage(next, cumulativeUsage)) return;
      cumulativeUsage = next;
      const event = await usageEvent('update');
      await callTelemetryCallback(options.onProgress, Object.freeze({
        ...event,
        type: 'model_progress',
        stage: 'usage',
      }));
    },
    async finalize(outputCharacters, hasOutput = true, completion = {}) {
      const truncated = isTruncatedStopReason(stopReason);
      const streamIncomplete = completion.requireStopReason === true && !stopReason;
      const blocked = BLOCKED_STOP_REASONS.has(stopReason);
      const unsupported = UNSUPPORTED_STOP_REASONS.has(stopReason) || stopReason === 'unknown';
      const incomplete = streamIncomplete || INCOMPLETE_STOP_REASONS.has(stopReason) ||
        completion.streamCompleted === false;
      const stage = truncated
        ? 'truncated'
        : blocked
          ? 'blocked'
          : unsupported
            ? 'unsupported'
            : incomplete
              ? 'incomplete'
              : hasOutput ? 'complete' : 'invalid';
      const finalUsage = await usageEvent('final');
      await callTelemetryCallback(options.onProgress, Object.freeze({
        type: 'model_progress',
        stage,
        protocol,
        stopReason: stopReason || null,
        truncated,
        outputCharacters: Math.max(0, Number(outputCharacters) || 0),
        usageAvailable: finalUsage.usageAvailable,
        usage: cumulativeUsage,
        cumulativeUsage,
      }));
      if (truncated) {
        const error = providerError(
          'Model output reached the provider token limit before the answer completed.',
          'LLM_OUTPUT_TRUNCATED',
        );
        // Metadata is numeric/bounded only. Never attach the partial answer,
        // prompt, model endpoint, or credentials to the error.
        error.stopReason = stopReason;
        error.usage = cumulativeUsage;
        error.outputCharacters = Math.max(0, Number(outputCharacters) || 0);
        error.retryable = false;
        throw error;
      }
      if (blocked || unsupported || incomplete) {
        const code = blocked
          ? 'LLM_RESPONSE_BLOCKED'
          : unsupported
            ? 'LLM_UNSUPPORTED_STOP_REASON'
            : 'LLM_STREAM_INCOMPLETE';
        const message = blocked
          ? 'Model provider blocked or refused the response before a usable answer completed.'
          : unsupported
            ? 'Model provider ended with an unsupported tool or completion state.'
            : 'Model provider stream ended before its required terminal event.';
        const error = providerError(message, code);
        error.stopReason = stopReason || null;
        error.usage = cumulativeUsage;
        error.outputCharacters = Math.max(0, Number(outputCharacters) || 0);
        error.retryable = false;
        throw error;
      }
    },
  });
}

const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_PROTOCOLS = new Set(['anthropic-messages', 'openai-chat-completions']);
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
const MAX_MODEL_RESPONSE_BYTES = 8 * 1024 * 1024;

function optionalTemperature(options, config) {
  const value = Object.hasOwn(options, 'temperature')
    ? options.temperature
    : config.temperature;
  return Number.isFinite(value) ? { temperature: value } : {};
}

function reasoningEffort(options) {
  const value = String(options.effort || options.reasoningEffort || '').trim().toLowerCase();
  if (!value || value === 'default') return '';
  if (!REASONING_EFFORTS.has(value)) {
    throw providerError('Model reasoning effort is invalid.', 'LLM_INVALID_EFFORT');
  }
  return value;
}

function configuredProtocol(config = {}) {
  const explicit = String(config.protocol || '').trim().toLowerCase();
  const protocol = explicit || (
    String(config.provider || '').trim().toLowerCase() === 'anthropic'
      ? 'anthropic-messages'
      : 'openai-chat-completions'
  );
  if (!MODEL_PROTOCOLS.has(protocol)) {
    throw providerError('Model provider protocol is invalid.', 'LLM_INVALID_PROTOCOL');
  }
  return protocol;
}

function configuredAuthMode(config = {}, protocol = configuredProtocol(config)) {
  const explicit = String(config.authMode || '').trim().toLowerCase();
  const authMode = explicit || (
    protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'
  );
  if (!AUTH_MODES.has(authMode)) {
    throw providerError('Model provider authentication mode is invalid.', 'LLM_INVALID_AUTH_MODE');
  }
  return authMode;
}

function configuredRequestProfile(config = {}, protocol = configuredProtocol(config)) {
  const explicit = String(config.requestProfile || '').trim().toLowerCase();
  const profile = explicit || (
    protocol === 'anthropic-messages' ? 'anthropic-standard' : 'default'
  );
  if (!REQUEST_PROFILES.has(profile)) {
    throw providerError('Model request profile is invalid.', 'LLM_INVALID_REQUEST_PROFILE');
  }
  if (protocol === 'anthropic-messages' && !['default', 'anthropic-standard'].includes(profile)) {
    throw providerError('The selected request profile is incompatible with Anthropic Messages.', 'LLM_INVALID_REQUEST_PROFILE');
  }
  if (protocol === 'openai-chat-completions' && profile === 'anthropic-standard') {
    throw providerError('The selected request profile is incompatible with OpenAI Chat Completions.', 'LLM_INVALID_REQUEST_PROFILE');
  }
  return profile;
}

function authenticationHeaders(config, protocol) {
  const authMode = configuredAuthMode(config, protocol);
  const apiKey = String(config.apiKey || '');
  if (!apiKey || authMode === 'none') return {};
  if (authMode === 'bearer') return { Authorization: `Bearer ${apiKey}` };
  return { 'x-api-key': apiKey };
}

function effortRequestFields(profile, options) {
  const effort = reasoningEffort(options);
  if (!effort || profile === 'default') return {};
  if (profile === 'anthropic-standard') return { output_config: { effort } };
  if (profile === 'openai-standard') return { reasoning_effort: effort };
  if (profile === 'kimi-openai') return { reasoning_effort: effort };
  if (profile === 'bailian-openai') {
    return { enable_thinking: !['minimal', 'low'].includes(effort) };
  }
  if (profile === 'deepseek-openai') {
    const mappedEffort = effort === 'low' ? 'low' : effort === 'max' ? 'max' : 'high';
    return {
      thinking: { type: 'enabled' },
      reasoning_effort: mappedEffort,
    };
  }
  if (profile === 'glm-openai') {
    return {
      thinking: {
        type: ['minimal', 'low'].includes(effort) ? 'disabled' : 'enabled',
      },
    };
  }
  return {};
}

function requestTimeoutMs(options = {}, config = {}) {
  const configured = Number(config.timeoutMs);
  const defaultTimeout = Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 900_000)
    : 120_000;
  if (!Object.hasOwn(options, 'timeoutMs')) return defaultTimeout;
  const requested = Number(options.timeoutMs);
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw providerError('Model request timeout must be a positive integer.', 'LLM_INVALID_TIMEOUT');
  }
  // A call may shorten the client-wide ceiling but cannot silently extend it.
  return Math.min(requested, defaultTimeout);
}

function normalizeDnsAnswers(answers) {
  if (!Array.isArray(answers)) return [];
  return answers.map((entry) => {
    const address = String(entry?.address || '');
    return { address, family: isIP(address) };
  }).filter((entry) => entry.family > 0);
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The model request was cancelled.', 'AbortError');
}

function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function resolvePublicModelTarget(target, lookup, signal) {
  const hostname = target.hostname.startsWith('[') && target.hostname.endsWith(']')
    ? target.hostname.slice(1, -1)
    : target.hostname;
  if (!hostname || isIP(hostname)) {
    throw providerError('Model providers must use a public DNS hostname.', 'LLM_DESTINATION_DENIED');
  }
  let answers;
  try {
    answers = normalizeDnsAnswers(await withAbort(
      lookup(hostname, { all: true, verbatim: true }),
      signal,
    ));
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortReason(signal);
    throw providerError('The model provider hostname could not be resolved.', 'LLM_DNS_FAILED', error);
  }
  if (!answers.length || answers.some((entry) => !isPublicAddress(entry.address))) {
    throw providerError('Model providers must resolve only to public network addresses.', 'LLM_DESTINATION_DENIED');
  }
  return {
    hostname,
    selected: answers.find((entry) => entry.family === 4) || answers[0],
  };
}

function pinnedLookup(selected) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'object' && options ? options : {};
    if (settings.all === true) done(null, [{ address: selected.address, family: selected.family }]);
    else done(null, selected.address, selected.family);
  };
}

function sanitizedTransportHeaders(input, body) {
  const headers = new Headers(input || {});
  for (const name of ['host', 'connection', 'transfer-encoding', 'content-length']) {
    headers.delete(name);
  }
  headers.set('content-length', String(body.byteLength));
  return Object.fromEntries(headers.entries());
}

function responseHeaders(raw = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else {
      headers.set(name, String(value));
    }
  }
  return headers;
}

function requestAsFetch(requestFn, target, requestOptions, body, maxResponseBytes) {
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let promiseSettled = false;
    let responseEnded = false;
    let streamController = null;
    let onAbort = null;
    const signal = requestOptions.signal;
    const cleanup = () => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    };
    const settle = (callback, value) => {
      if (promiseSettled) return;
      promiseSettled = true;
      callback(value);
    };
    try {
      request = requestFn(target, requestOptions, (incoming) => {
        response = incoming;
        const status = Number(incoming.statusCode || 0);
        if (status >= 300 && status < 400) {
          incoming.resume?.();
          incoming.destroy?.();
          cleanup();
          settle(reject, providerError('Model provider redirects are not permitted.', 'LLM_REDIRECT_DENIED'));
          return;
        }
        const declared = Number(incoming.headers?.['content-length']);
        if (Number.isFinite(declared) && declared > maxResponseBytes) {
          incoming.resume?.();
          incoming.destroy?.();
          cleanup();
          settle(reject, providerError('Model provider response exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE'));
          return;
        }
        let bytes = 0;
        const stream = new ReadableStream({
          start(controller) {
            streamController = controller;
            incoming.on('data', (chunk) => {
              if (responseEnded) return;
              const buffer = Buffer.from(chunk);
              bytes += buffer.byteLength;
              if (bytes > maxResponseBytes) {
                responseEnded = true;
                const error = providerError('Model provider response exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
                controller.error(error);
                incoming.destroy?.(error);
                cleanup();
                return;
              }
              controller.enqueue(new Uint8Array(buffer));
            });
            incoming.once('end', () => {
              if (responseEnded) return;
              responseEnded = true;
              cleanup();
              controller.close();
            });
            incoming.once('error', (error) => {
              if (responseEnded) return;
              responseEnded = true;
              cleanup();
              controller.error(providerError(
                'The model provider response failed.',
                'LLM_NETWORK_ERROR',
                error,
              ));
            });
          },
          cancel(reason) {
            responseEnded = true;
            cleanup();
            incoming.destroy?.(reason instanceof Error ? reason : undefined);
          },
        });
        const safeStatus = status >= 200 && status <= 599 ? status : 502;
        const emptyStatus = [204, 205, 304].includes(safeStatus);
        settle(resolve, new Response(emptyStatus ? null : stream, {
          status: safeStatus,
          statusText: String(incoming.statusMessage || '').slice(0, 100),
          headers: responseHeaders(incoming.headers),
        }));
      });
    } catch (error) {
      cleanup();
      settle(reject, providerError('The model provider request could not be created.', 'LLM_NETWORK_ERROR', error));
      return;
    }
    request.once('error', (error) => {
      const safe = providerError(
        'The model provider request failed.',
        error?.name === 'AbortError' ? 'LLM_ABORTED' : 'LLM_NETWORK_ERROR',
        error,
      );
      if (!promiseSettled) {
        cleanup();
        settle(reject, safe);
      } else if (!responseEnded) {
        responseEnded = true;
        cleanup();
        streamController?.error(safe);
      }
    });
    onAbort = () => {
      const reason = abortReason(signal);
      if (!promiseSettled) settle(reject, reason);
      else if (!responseEnded) {
        responseEnded = true;
        streamController?.error(reason);
      }
      cleanup();
      response?.destroy?.(reason);
      request.destroy?.(reason);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    request.end(body);
  });
}

/**
 * Fetch-compatible, POST-only transport for user-managed model endpoints.
 * Public HTTPS requests are resolved on every call, reject mixed/private DNS
 * answers and connect to one validated address while preserving TLS SNI.
 */
export function createPinnedModelFetch(options = {}) {
  const lookup = options.lookup || dns.lookup;
  const httpsRequest = options.httpsRequest || options.request || https.request;
  const httpRequest = options.httpRequest || http.request;
  const allowInsecureHttp = options.allowInsecureHttp === true;
  const maxResponseBytes = Math.min(
    MAX_MODEL_RESPONSE_BYTES,
    Math.max(1_024, Number(options.maxResponseBytes) || MAX_MODEL_RESPONSE_BYTES),
  );
  return async (input, init = {}) => {
    let target;
    try { target = new URL(String(input)); }
    catch { throw providerError('Model provider URL is invalid.', 'LLM_INVALID_ENDPOINT'); }
    if (
      target.username || target.password || target.search || target.hash ||
      !['https:', 'http:'].includes(target.protocol)
    ) {
      throw providerError('Model provider URL must be credential-free and cannot contain a query or fragment.', 'LLM_INVALID_ENDPOINT');
    }
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'POST') throw providerError('The model transport only permits POST requests.', 'LLM_METHOD_DENIED');
    if (init.signal?.aborted) throw abortReason(init.signal);
    const body = Buffer.isBuffer(init.body)
      ? init.body
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : Buffer.from(String(init.body ?? ''), 'utf8');
    if (target.protocol === 'http:') {
      if (!allowInsecureHttp || !isLocalHostname(target.hostname)) {
        throw providerError('Plain HTTP is permitted only for an explicitly enabled loopback model provider.', 'LLM_INSECURE_ENDPOINT');
      }
      return requestAsFetch(httpRequest, target, {
        method,
        headers: sanitizedTransportHeaders(init.headers, body),
        signal: init.signal,
        agent: false,
      }, body, maxResponseBytes);
    }
    if (target.port && target.port !== '443') {
      throw providerError('Public model providers must use HTTPS on port 443.', 'LLM_INVALID_ENDPOINT');
    }
    const { hostname, selected } = await resolvePublicModelTarget(target, lookup, init.signal);
    if (init.signal?.aborted) throw abortReason(init.signal);
    return requestAsFetch(httpsRequest, target, {
      method,
      headers: sanitizedTransportHeaders(init.headers, body),
      signal: init.signal,
      agent: false,
      family: selected.family,
      lookup: pinnedLookup(selected),
      servername: hostname,
      rejectUnauthorized: true,
    }, body, maxResponseBytes);
  };
}

export class ChatModelClient {
  constructor(config, options = {}) {
    Object.defineProperty(this, 'config', {
      value: Object.freeze({ ...config }),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    this.protocol = configuredProtocol(this.config);
    this.authMode = configuredAuthMode(this.config, this.protocol);
    this.requestProfile = configuredRequestProfile(this.config, this.protocol);
    Object.defineProperty(this, 'fetch', {
      value: options.fetch || globalThis.fetch,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  publicStatus() {
    return {
      provider: this.config.provider || this.protocol,
      protocol: this.protocol,
      model: this.config.model,
      configured: Boolean(this.config.apiBase && this.config.model),
    };
  }

  async generate(messagesInput, options = {}) {
    const messages = normalizeMessages(messagesInput, {
      allowAssistantReasoning: this.requestProfile === 'kimi-openai',
    });
    if (!messages.length) throw providerError('At least one model message is required.', 'LLM_INPUT_REQUIRED');
    if (this.protocol === 'anthropic-messages') return this.generateAnthropic(messages, options);
    return this.generateOpenAiCompatible(messages, options);
  }

  async request(url, init, options, consume) {
    assertSafeProviderUrl(url, this.config.allowInsecureHttp);
    const timeoutMs = requestTimeoutMs(options, this.config);
    const controller = new AbortController();
    let timedOut = false;
    const relay = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(providerError('Model request timed out.', 'LLM_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetch(url, { ...init, signal: controller.signal });
      return await consume(response, controller.signal);
    } catch (error) {
      if (timedOut) {
        throw providerError(`Model request exceeded ${Math.round(timeoutMs / 1000)} seconds.`, 'LLM_TIMEOUT', error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relay);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  async generateOpenAiCompatible(messages, options) {
    const url = endpoint(this.config.apiBase, '/chat/completions');
    const headers = {
      'Content-Type': 'application/json',
      ...authenticationHeaders(this.config, this.protocol),
    };
    const streaming = options.stream !== false;
    return this.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model || this.config.model,
        messages,
        stream: streaming,
        ...(streaming && options.includeUsage === true
          ? { stream_options: { include_usage: true } }
          : {}),
        // Kimi K3 fixes sampling parameters and rejects attempts to tune them.
        // Its registered request profile therefore omits temperature even if
        // the deployment has a global value for other providers.
        ...(this.requestProfile === 'kimi-openai'
          ? {}
          : optionalTemperature(options, this.config)),
        max_tokens: options.maxOutputTokens || this.config.maxOutputTokens,
        ...effortRequestFields(this.requestProfile, options),
      }),
    }, options, async (response, signal) => {
      if (!response.ok) throw await responseError(response, this.config.apiKey, signal);
      const contentType = response.headers.get('content-type') || '';
      const maximumCharacters = Math.max(
        4_096,
        Math.min(2_000_000, Number(options.maxOutputTokens || this.config.maxOutputTokens) * 8),
      );
      const telemetry = createModelTelemetry(this.protocol, options);
      let output = '';
      let reasoningOutput = '';
      const preserveAssistantReasoning = this.requestProfile === 'kimi-openai';
      let assistantMessageReported = false;
      const reportAssistantMessage = async () => {
        if (assistantMessageReported || typeof options.onAssistantMessage !== 'function') return;
        assistantMessageReported = true;
        const message = {
          role: 'assistant',
          content: output,
          ...(reasoningOutput ? { reasoning_content: reasoningOutput } : {}),
        };
        await options.onAssistantMessage(Object.freeze(message));
      };
      const push = (text) => {
        if (!text) return;
        if (output.length + text.length > maximumCharacters) {
          throw providerError('Model output exceeded the configured safety limit.', 'LLM_OUTPUT_TOO_LARGE');
        }
        output += text;
        options.onToken?.(text);
      };
      const pushReasoning = (text) => {
        if (!preserveAssistantReasoning || !text) return;
        if (output.length + reasoningOutput.length + text.length > maximumCharacters) {
          throw providerError('Model output exceeded the configured safety limit.', 'LLM_OUTPUT_TOO_LARGE');
        }
        reasoningOutput += text;
      };
      if (contentType.includes('text/event-stream')) {
        const streamState = await readSse(response, async (data) => {
          let payload;
          try { payload = JSON.parse(data); }
          catch { throw providerError('Model stream contained invalid JSON.', 'LLM_INVALID_RESPONSE'); }
          const choice = payload?.choices?.[0];
          telemetry.observeStopReason(choice?.finish_reason ?? choice?.finishReason);
          await telemetry.observeUsage(payload?.usage ?? choice?.usage);
          pushReasoning(choice?.delta?.reasoning_content || '');
          push(choice?.delta?.content || choice?.text || '');
        }, signal, {
          maxBytes: Math.min(8 * 1024 * 1024, maximumCharacters * 4 + 64 * 1024),
          maxBufferCharacters: Math.min(4 * 1024 * 1024, maximumCharacters * 2 + 64 * 1024),
        });
        await reportAssistantMessage();
        await telemetry.finalize(output.length, Boolean(output.trim()), {
          requireStopReason: true,
          // `[DONE]` is tracked for diagnostics and compatibility, but the
          // authoritative OpenAI completion signal is finish_reason.
          sawDone: streamState.sawDone,
        });
      } else {
        let payload;
        try {
          payload = JSON.parse(await readResponseText(
            response,
            signal,
            Math.min(8 * 1024 * 1024, maximumCharacters * 4 + 64 * 1024),
          ));
        }
        catch (error) {
          if (signal.aborted) throw signal.reason || error;
          throw providerError('Model provider returned invalid JSON.', 'LLM_INVALID_RESPONSE', error);
        }
        const choice = payload?.choices?.[0];
        telemetry.observeStopReason(choice?.finish_reason ?? choice?.finishReason);
        await telemetry.observeUsage(payload?.usage ?? choice?.usage);
        pushReasoning(choice?.message?.reasoning_content || '');
        push(choice?.message?.content || choice?.text || '');
        await reportAssistantMessage();
        await telemetry.finalize(output.length, Boolean(output.trim()));
      }
      if (!output.trim()) throw providerError('Model returned an empty response.', 'LLM_EMPTY_RESPONSE');
      return output;
    });
  }

  async generateAnthropic(messages, options) {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const conversation = messages.filter((message) => message.role !== 'system');
    const url = endpoint(this.config.apiBase, '/v1/messages');
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...authenticationHeaders(this.config, this.protocol),
    };
    return this.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model || this.config.model,
        system,
        messages: conversation,
        stream: options.stream !== false,
        ...optionalTemperature(options, this.config),
        max_tokens: options.maxOutputTokens || this.config.maxOutputTokens,
        ...effortRequestFields(this.requestProfile, options),
      }),
    }, options, async (response, signal) => {
      if (!response.ok) throw await responseError(response, this.config.apiKey, signal);
      const contentType = response.headers.get('content-type') || '';
      const maximumCharacters = Math.max(
        4_096,
        Math.min(2_000_000, Number(options.maxOutputTokens || this.config.maxOutputTokens) * 8),
      );
      const telemetry = createModelTelemetry(this.protocol, options);
      let output = '';
      const push = (text) => {
        if (!text) return;
        if (output.length + text.length > maximumCharacters) {
          throw providerError('Model output exceeded the configured safety limit.', 'LLM_OUTPUT_TOO_LARGE');
        }
        output += text;
        options.onToken?.(text);
      };
      if (contentType.includes('text/event-stream')) {
        let messageStopped = false;
        await readSse(response, async (data) => {
          let payload;
          try { payload = JSON.parse(data); }
          catch { throw providerError('Model stream contained invalid JSON.', 'LLM_INVALID_RESPONSE'); }
          if (payload?.type === 'message_stop') messageStopped = true;
          telemetry.observeStopReason(
            payload?.delta?.stop_reason ?? payload?.message?.stop_reason ?? payload?.stop_reason,
          );
          await telemetry.observeUsage(payload?.usage ?? payload?.message?.usage ?? payload?.delta?.usage);
          if (payload?.type === 'content_block_delta' && payload?.delta?.type === 'text_delta') {
            push(payload.delta.text || '');
          }
        }, signal, {
          maxBytes: Math.min(8 * 1024 * 1024, maximumCharacters * 4 + 64 * 1024),
          maxBufferCharacters: Math.min(4 * 1024 * 1024, maximumCharacters * 2 + 64 * 1024),
        });
        await telemetry.finalize(output.length, Boolean(output.trim()), {
          requireStopReason: true,
          streamCompleted: messageStopped,
        });
      } else {
        let payload;
        try {
          payload = JSON.parse(await readResponseText(
            response,
            signal,
            Math.min(8 * 1024 * 1024, maximumCharacters * 4 + 64 * 1024),
          ));
        }
        catch (error) {
          if (signal.aborted) throw signal.reason || error;
          throw providerError('Model provider returned invalid JSON.', 'LLM_INVALID_RESPONSE', error);
        }
        telemetry.observeStopReason(payload?.stop_reason);
        await telemetry.observeUsage(payload?.usage);
        for (const block of payload?.content || []) if (block?.type === 'text') push(block.text || '');
        await telemetry.finalize(output.length, Boolean(output.trim()));
      }
      if (!output.trim()) throw providerError('Model returned an empty response.', 'LLM_EMPTY_RESPONSE');
      return output;
    });
  }
}

export const llmInternals = {
  abortReason, authenticationHeaders, configuredAuthMode, configuredProtocol,
  configuredRequestProfile, effortRequestFields, endpoint, isLocalHostname,
  classifyProviderResponseError,
  createModelTelemetry, isTruncatedStopReason, mergeModelUsage,
  derivedTotalTokens, normalizeModelUsage, normalizeStopReason,
  redactProviderDetail, requestTimeoutMs,
  normalizeMessages, optionalTemperature, reasoningEffort, resolvePublicModelTarget,
  readResponseText, readSse,
};
