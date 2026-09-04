import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';

export const BENCHMARK_MODEL = 'qwen3.8-max';
export const BENCHMARK_EFFORT = 'medium';
export const BENCHMARK_MAX_OUTPUT_TOKENS = 3_000;
export const BENCHMARK_PRICING_CNY_PER_MILLION = Object.freeze({
  input: 12,
  output: 36,
  cacheCreation: 15,
  cacheRead: 1.5,
});
export const BENCHMARK_BUDGET_CNY = Object.freeze({ soft: 90, hard: 100 });
export const DEFAULT_UPSTREAM_ALLOWLIST = Object.freeze([
  'https://dashscope.aliyuncs.com',
]);

const SAFE_ANONYMOUS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class BenchmarkRuntimeError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BenchmarkRuntimeError';
    this.code = code;
    this.httpStatus = options.httpStatus || 500;
  }
}

function runtimeError(message, code, options) {
  return new BenchmarkRuntimeError(message, code, options);
}

function finiteNonnegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw runtimeError(`${label} must be a finite non-negative number.`, 'INVALID_RUNTIME_OPTION');
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw runtimeError(`${label} must be a positive integer.`, 'INVALID_RUNTIME_OPTION');
  }
  return number;
}

function normalizeOrigin(input, label = 'upstream allowlist entry') {
  let value;
  try {
    value = new URL(String(input));
  } catch {
    throw runtimeError(`${label} is not a valid URL.`, 'UPSTREAM_URL_REJECTED');
  }
  if (value.protocol !== 'https:' || value.username || value.password || value.pathname !== '/' ||
      value.search || value.hash) {
    throw runtimeError(
      `${label} must be an HTTPS origin without credentials, path, query, or fragment.`,
      'UPSTREAM_URL_REJECTED',
    );
  }
  return value.origin;
}

export function assertAllowedUpstream(upstreamUrl, allowlist = DEFAULT_UPSTREAM_ALLOWLIST) {
  let value;
  try {
    value = new URL(String(upstreamUrl));
  } catch {
    throw runtimeError('The Anthropic upstream URL is invalid.', 'UPSTREAM_URL_REJECTED');
  }
  if (value.protocol !== 'https:' || value.username || value.password || value.hash) {
    throw runtimeError(
      'The Anthropic upstream must be HTTPS and must not contain URL credentials or a fragment.',
      'UPSTREAM_URL_REJECTED',
    );
  }
  const allowedOrigins = new Set(allowlist.map((entry) => normalizeOrigin(entry)));
  if (!allowedOrigins.has(value.origin)) {
    throw runtimeError('The Anthropic upstream origin is not allowlisted.', 'UPSTREAM_HOST_REJECTED');
  }
  return value.href;
}

function aliasesMap(value) {
  if (value instanceof Map) return value;
  if (!value) return new Map();
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw runtimeError('verifiedModelAliases must be a Map or object.', 'INVALID_RUNTIME_OPTION');
  }
  return new Map(Object.entries(value));
}

/**
 * Normalize the request immediately before it leaves the machine.
 *
 * `[1M]qwen3.8-max` is deliberately not silently rewritten. It is accepted only
 * when the caller explicitly attests the alias through verifiedModelAliases.
 */
export function enforceAnthropicBenchmarkBody(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw runtimeError('Anthropic Messages body must be a JSON object.', 'INVALID_ANTHROPIC_BODY');
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw runtimeError('Anthropic Messages body needs at least one message.', 'INVALID_ANTHROPIC_BODY');
  }
  const forbiddenWebTool = (Array.isArray(input.tools) ? input.tools : []).find((tool) => {
    const name = String(tool?.name || '').toLowerCase().replace(/[^a-z0-9]/gu, '');
    const type = String(tool?.type || '').toLowerCase().replace(/[^a-z0-9]/gu, '');
    return name === 'websearch' || type.startsWith('websearch');
  });
  if (forbiddenWebTool) {
    throw runtimeError('Web Search is disabled for every benchmark request.', 'WEB_SEARCH_DISABLED');
  }
  const requestedModel = String(input.model || '');
  const verifiedAliases = aliasesMap(options.verifiedModelAliases);
  if (requestedModel !== BENCHMARK_MODEL) {
    if (requestedModel === `[1M]${BENCHMARK_MODEL}`) {
      if (verifiedAliases.get(requestedModel) !== BENCHMARK_MODEL) {
        throw runtimeError(
          'The [1M] model alias has not been proven equivalent to qwen3.8-max.',
          'MODEL_ALIAS_UNVERIFIED',
        );
      }
    } else {
      throw runtimeError('The request model differs from the benchmark model.', 'MODEL_MISMATCH');
    }
  }
  const suppliedMaximum = input.max_tokens === undefined
    ? BENCHMARK_MAX_OUTPUT_TOKENS
    : positiveInteger(input.max_tokens, 'max_tokens');
  // Remove caller-specific sampling knobs so both adapters reach the provider
  // with the same deterministic sampling configuration.
  const { top_p: _topP, top_k: _topK, ...lockedInput } = input;
  return {
    ...lockedInput,
    model: BENCHMARK_MODEL,
    stream: true,
    temperature: 0,
    max_tokens: Math.min(suppliedMaximum, BENCHMARK_MAX_OUTPUT_TOKENS),
    output_config: {
      ...(input.output_config && typeof input.output_config === 'object' &&
        !Array.isArray(input.output_config) ? input.output_config : {}),
      effort: BENCHMARK_EFFORT,
    },
  };
}

function usageShape(input = {}) {
  const integer = (value, label) => {
    const number = finiteNonnegative(value ?? 0, label);
    if (!Number.isInteger(number)) {
      throw runtimeError(`${label} must be an integer.`, 'INVALID_USAGE');
    }
    return number;
  };
  return {
    inputTokens: integer(input.inputTokens, 'inputTokens'),
    outputTokens: integer(input.outputTokens, 'outputTokens'),
    cacheCreationTokens: integer(input.cacheCreationTokens, 'cacheCreationTokens'),
    cacheReadTokens: integer(input.cacheReadTokens, 'cacheReadTokens'),
  };
}

export function estimateUsageCostCny(usage, pricing = BENCHMARK_PRICING_CNY_PER_MILLION) {
  const normalized = usageShape(usage);
  const cost = (
    normalized.inputTokens * finiteNonnegative(pricing.input, 'pricing.input') +
    normalized.outputTokens * finiteNonnegative(pricing.output, 'pricing.output') +
    normalized.cacheCreationTokens * finiteNonnegative(
      pricing.cacheCreation,
      'pricing.cacheCreation',
    ) +
    normalized.cacheReadTokens * finiteNonnegative(pricing.cacheRead, 'pricing.cacheRead')
  ) / 1_000_000;
  return Number(cost.toFixed(9));
}

/**
 * Process-concurrency-safe ledger. Every mutation is serialized. An attempt that
 * reached the network but did not yield complete usage remains permanently locked
 * at its conservative reservation until an operator reconciles the provider bill.
 */
export class BudgetLedger {
  #tail = Promise.resolve();
  #settledCny = 0;
  #reservations = new Map();
  #sequence = 0;

  constructor(options = {}) {
    this.pricing = Object.freeze({
      ...BENCHMARK_PRICING_CNY_PER_MILLION,
      ...(options.pricing || {}),
    });
    this.limits = Object.freeze({
      ...BENCHMARK_BUDGET_CNY,
      ...(options.limits || {}),
    });
    finiteNonnegative(this.limits.soft, 'limits.soft');
    finiteNonnegative(this.limits.hard, 'limits.hard');
    if (this.limits.soft > this.limits.hard) {
      throw runtimeError('The soft budget cannot exceed the hard budget.', 'INVALID_RUNTIME_OPTION');
    }
    for (const [name, value] of Object.entries(this.pricing)) {
      finiteNonnegative(value, `pricing.${name}`);
    }
  }

  async #locked(operation) {
    let release;
    const previous = this.#tail;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  #lockedTotal() {
    let amount = 0;
    for (const reservation of this.#reservations.values()) amount += reservation.amountCny;
    return amount;
  }

  #snapshot() {
    let activeReservedCny = 0;
    let uncertainCny = 0;
    for (const reservation of this.#reservations.values()) {
      if (reservation.state === 'uncertain') uncertainCny += reservation.amountCny;
      else activeReservedCny += reservation.amountCny;
    }
    const committedCny = this.#settledCny + activeReservedCny + uncertainCny;
    return {
      settledCny: Number(this.#settledCny.toFixed(9)),
      activeReservedCny: Number(activeReservedCny.toFixed(9)),
      uncertainCny: Number(uncertainCny.toFixed(9)),
      committedCny: Number(committedCny.toFixed(9)),
      remainingToSoftCny: Number(Math.max(0, this.limits.soft - committedCny).toFixed(9)),
      remainingToHardCny: Number(Math.max(0, this.limits.hard - committedCny).toFixed(9)),
      softLimitCny: this.limits.soft,
      hardLimitCny: this.limits.hard,
      canStart: committedCny < this.limits.soft && committedCny < this.limits.hard,
      hardExceeded: committedCny > this.limits.hard,
      openReservations: this.#reservations.size,
    };
  }

  async reserve(options = {}) {
    return this.#locked(() => {
      const inputTokenUpperBound = Math.ceil(finiteNonnegative(
        options.inputTokenUpperBound ?? options.inputBytes,
        'inputTokenUpperBound',
      ));
      const maxOutputTokens = positiveInteger(options.maxOutputTokens, 'maxOutputTokens');
      // Cache creation is the most expensive possible disposition of an input token.
      const inputRate = Math.max(this.pricing.input, this.pricing.cacheCreation);
      const amountCny = Number((
        (inputTokenUpperBound * inputRate + maxOutputTokens * this.pricing.output) / 1_000_000
      ).toFixed(9));
      const committed = this.#settledCny + this.#lockedTotal();
      if (committed >= this.limits.hard || committed + amountCny > this.limits.hard) {
        throw runtimeError('The benchmark hard budget does not permit another request.', 'BUDGET_HARD_LIMIT', {
          httpStatus: 429,
        });
      }
      if (committed >= this.limits.soft || committed + amountCny > this.limits.soft) {
        throw runtimeError('The benchmark soft budget does not permit another request.', 'BUDGET_SOFT_LIMIT', {
          httpStatus: 429,
        });
      }
      const id = `reservation-${++this.#sequence}`;
      this.#reservations.set(id, { amountCny, state: 'active' });
      return Object.freeze({ id, amountCny, inputTokenUpperBound, maxOutputTokens });
    });
  }

  async settle(reservation, usage) {
    return this.#locked(() => {
      const current = this.#reservations.get(reservation?.id);
      if (!current) throw runtimeError('The budget reservation is unknown.', 'UNKNOWN_RESERVATION');
      const normalized = usageShape(usage);
      const actualCny = estimateUsageCostCny(normalized, this.pricing);
      this.#reservations.delete(reservation.id);
      this.#settledCny += actualCny;
      return { actualCny, usage: normalized, status: this.#snapshot() };
    });
  }

  async markUncertain(reservation) {
    return this.#locked(() => {
      const current = this.#reservations.get(reservation?.id);
      if (!current) throw runtimeError('The budget reservation is unknown.', 'UNKNOWN_RESERVATION');
      current.state = 'uncertain';
      return this.#snapshot();
    });
  }

  async status() {
    return this.#locked(() => this.#snapshot());
  }
}

function safeAnonymousId(value) {
  const candidate = String(value || '');
  if (SAFE_ANONYMOUS_ID.test(candidate)) return candidate;
  if (!candidate) return `anon-${crypto.randomBytes(8).toString('hex')}`;
  return `anon-${crypto.createHash('sha256').update(candidate).digest('hex').slice(0, 16)}`;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readRequestBody(request, maximumBytes) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw runtimeError('The proxy request is too large.', 'REQUEST_TOO_LARGE', { httpStatus: 413 });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      throw runtimeError('The proxy request is too large.', 'REQUEST_TOO_LARGE', { httpStatus: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeJsonResponse(response, status, code) {
  if (response.destroyed) return;
  if (response.headersSent) {
    if (!response.writableEnded) response.destroy();
    return;
  }
  const body = JSON.stringify({ type: 'error', error: { type: code } });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function errorCode(error) {
  if (error?.code && /^[A-Z0-9_]{2,80}$/.test(error.code)) return error.code;
  if (error?.name === 'AbortError') return 'UPSTREAM_ABORTED';
  return 'UPSTREAM_NETWORK_ERROR';
}

function eventData(block) {
  return block.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

function explicitUsageInteger(input, field) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, field)) return null;
  const value = input[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw runtimeError(`Upstream usage.${field} must be a non-negative integer.`, 'INVALID_USAGE');
  }
  return value;
}

class AnthropicSseTracker {
  constructor(clock, startedAt) {
    this.clock = clock;
    this.startedAt = startedAt;
    this.buffer = '';
    this.decoder = new TextDecoder();
    this.firstSseMs = null;
    this.firstVisibleTextMs = null;
    this.sawMessageStartUsage = false;
    this.sawMessageDeltaUsage = false;
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
  }

  #elapsed() {
    return Number((this.clock() - this.startedAt).toFixed(3));
  }

  #accept(block) {
    const data = eventData(block);
    if (!data || data === '[DONE]') return;
    if (this.firstSseMs === null) this.firstSseMs = this.#elapsed();
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw runtimeError('The upstream SSE contained invalid JSON.', 'INVALID_UPSTREAM_SSE');
    }
    if (payload?.type === 'message_start' && payload?.message?.usage) {
      const usage = payload.message.usage;
      const inputTokens = explicitUsageInteger(usage, 'input_tokens');
      const cacheCreationTokens = explicitUsageInteger(usage, 'cache_creation_input_tokens');
      const cacheReadTokens = explicitUsageInteger(usage, 'cache_read_input_tokens');
      if (inputTokens !== null) {
        this.usage.inputTokens = inputTokens;
        this.usage.cacheCreationTokens = cacheCreationTokens ?? 0;
        this.usage.cacheReadTokens = cacheReadTokens ?? 0;
        this.sawMessageStartUsage = true;
      }
    }
    if (payload?.type === 'message_delta' && payload?.usage) {
      const usage = payload.usage;
      const outputTokens = explicitUsageInteger(usage, 'output_tokens');
      const inputTokens = explicitUsageInteger(usage, 'input_tokens');
      const cacheCreationTokens = explicitUsageInteger(usage, 'cache_creation_input_tokens');
      const cacheReadTokens = explicitUsageInteger(usage, 'cache_read_input_tokens');
      if (outputTokens !== null) {
        this.usage.outputTokens = outputTokens;
        if (inputTokens !== null) this.usage.inputTokens = inputTokens;
        if (cacheCreationTokens !== null) this.usage.cacheCreationTokens = cacheCreationTokens;
        if (cacheReadTokens !== null) this.usage.cacheReadTokens = cacheReadTokens;
        this.sawMessageDeltaUsage = true;
      }
    }
    const visibleDelta = payload?.type === 'content_block_delta' &&
      payload?.delta?.type === 'text_delta' && String(payload.delta.text || '').length > 0;
    const visibleStart = payload?.type === 'content_block_start' &&
      payload?.content_block?.type === 'text' &&
      String(payload.content_block.text || '').length > 0;
    if (this.firstVisibleTextMs === null && (visibleDelta || visibleStart)) {
      this.firstVisibleTextMs = this.#elapsed();
    }
  }

  feed(bytes) {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    let boundary;
    while ((boundary = this.buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      this.#accept(block);
    }
    if (this.buffer.length > 512 * 1024) {
      throw runtimeError('An upstream SSE event exceeded the safety bound.', 'INVALID_UPSTREAM_SSE');
    }
  }

  finish() {
    this.buffer += this.decoder.decode();
    if (this.buffer.trim()) this.#accept(this.buffer);
    this.buffer = '';
  }

  get hasCompleteUsage() {
    return this.sawMessageStartUsage && this.sawMessageDeltaUsage &&
      this.usage.inputTokens + this.usage.outputTokens > 0;
  }
}

function forwardedResponseHeaders(upstream) {
  const output = {
    'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
  };
  for (const name of ['request-id', 'x-request-id', 'anthropic-ratelimit-requests-limit',
    'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-tokens-limit',
    'anthropic-ratelimit-tokens-remaining']) {
    const value = upstream.headers.get(name);
    if (value) output[name] = value;
  }
  return output;
}

function requestHeaders(input, upstreamApiKey) {
  const version = String(input.headers['anthropic-version'] || '2023-06-01').slice(0, 100);
  const headers = {
    'content-type': 'application/json',
    'x-api-key': upstreamApiKey,
    'anthropic-version': version,
  };
  const beta = input.headers['anthropic-beta'];
  if (beta && String(beta).length <= 2_000) headers['anthropic-beta'] = String(beta);
  return headers;
}

function delay(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function settlesWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Loopback-only, body-blind audit proxy for Anthropic Messages. Request and
 * response bodies are streamed transiently and are never included in records.
 */
export class AnthropicBenchmarkProxy {
  #server;
  #upstreamApiKey;
  #records = [];
  #activeControllers = new Set();
  #activeHandlers = new Set();
  #sockets = new Set();

  constructor(options = {}) {
    this.upstreamUrl = assertAllowedUpstream(
      options.upstreamUrl,
      options.allowedUpstreamOrigins || DEFAULT_UPSTREAM_ALLOWLIST,
    );
    if (!options.upstreamApiKey) {
      throw runtimeError('An in-memory upstream API key is required.', 'UPSTREAM_KEY_REQUIRED');
    }
    this.#upstreamApiKey = String(options.upstreamApiKey);
    this.clientToken = options.clientToken || crypto.randomBytes(32).toString('base64url');
    this.upstreamFetch = options.fetch || globalThis.fetch;
    this.ledger = options.ledger || new BudgetLedger();
    this.verifiedModelAliases = options.verifiedModelAliases;
    this.maxBodyBytes = positiveInteger(options.maxBodyBytes || 16 * 1024 * 1024, 'maxBodyBytes');
    this.maxUpstreamAttempts = positiveInteger(options.maxUpstreamAttempts || 1, 'maxUpstreamAttempts');
    this.retryDelayMs = finiteNonnegative(options.retryDelayMs || 0, 'retryDelayMs');
    this.closeTimeoutMs = positiveInteger(options.closeTimeoutMs ?? 2_000, 'closeTimeoutMs');
    this.clock = options.clock || (() => performance.now());
    this.onRecord = typeof options.onRecord === 'function' ? options.onRecord : null;
  }

  async start() {
    if (this.#server) throw runtimeError('The benchmark proxy is already running.', 'PROXY_ALREADY_RUNNING');
    this.#server = http.createServer((request, response) => {
      const operation = this.#handle(request, response);
      this.#activeHandlers.add(operation);
      operation.catch((error) => {
        safeJsonResponse(response, error?.httpStatus || 500, errorCode(error));
      }).finally(() => {
        this.#activeHandlers.delete(operation);
      });
    });
    this.#server.on('clientError', (_error, socket) => socket.destroy());
    this.#server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
    this.#server.listen(0, '127.0.0.1');
    await once(this.#server, 'listening');
    const address = this.#server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      await this.close();
      throw runtimeError('The benchmark proxy failed to bind only to IPv4 loopback.', 'PROXY_BIND_FAILED');
    }
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  records() {
    return structuredClone(this.#records);
  }

  #record(value) {
    const record = Object.freeze(structuredClone(value));
    this.#records.push(record);
    try { this.onRecord?.(record); } catch {}
  }

  async #attempt({ anonymousId, attempt, outboundBody, bodyBytes, request, response, signal }) {
    const startedAt = this.clock();
    let reservation;
    let tracker;
    let ttfbMs = null;
    let error = null;
    try {
      reservation = await this.ledger.reserve({
        inputBytes: bodyBytes,
        maxOutputTokens: outboundBody.max_tokens,
      });
      const upstream = await this.upstreamFetch(this.upstreamUrl, {
        method: 'POST',
        headers: requestHeaders(request, this.#upstreamApiKey),
        body: JSON.stringify(outboundBody),
        redirect: 'error',
        signal,
      });
      ttfbMs = Number((this.clock() - startedAt).toFixed(3));
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => {});
        throw runtimeError('The upstream attempted an HTTP redirect.', 'UPSTREAM_REDIRECT_REJECTED', {
          httpStatus: 502,
        });
      }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        throw runtimeError('The upstream returned a non-success response.', `UPSTREAM_HTTP_${upstream.status}`, {
          httpStatus: 502,
        });
      }
      if (!(upstream.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
        await upstream.body?.cancel().catch(() => {});
        throw runtimeError('The streaming upstream did not return SSE.', 'UPSTREAM_NOT_SSE');
      }
      if (!upstream.body) throw runtimeError('The upstream returned no stream.', 'UPSTREAM_EMPTY_STREAM');
      response.writeHead(upstream.status, forwardedResponseHeaders(upstream));
      tracker = new AnthropicSseTracker(this.clock, startedAt);
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          tracker.feed(value);
          if (!response.write(Buffer.from(value))) await once(response, 'drain', { signal });
        }
        tracker.finish();
      } finally {
        reader.releaseLock();
      }
      if (!tracker.hasCompleteUsage) {
        throw runtimeError('The upstream stream ended without complete usage.', 'USAGE_INCOMPLETE');
      }
      await this.ledger.settle(reservation, tracker.usage);
      return { succeeded: true, retryable: false };
    } catch (caught) {
      error = caught;
      if (reservation) {
        if (tracker?.hasCompleteUsage) await this.ledger.settle(reservation, tracker.usage);
        else await this.ledger.markUncertain(reservation);
      }
      const code = errorCode(caught);
      return {
        succeeded: false,
        retryable: code === 'UPSTREAM_NETWORK_ERROR' || code === 'UPSTREAM_ABORTED' ||
          (code.startsWith('UPSTREAM_HTTP_') && RETRYABLE_STATUS.has(Number(code.slice(14)))),
        error: caught,
      };
    } finally {
      const completedMs = Number((this.clock() - startedAt).toFixed(3));
      this.#record({
        anonymousId,
        attempt,
        usage: tracker?.hasCompleteUsage ? usageShape(tracker.usage) : null,
        timing: {
          ttfbMs,
          firstSseMs: tracker?.firstSseMs ?? null,
          firstVisibleTextMs: tracker?.firstVisibleTextMs ?? null,
          completedMs,
        },
        errorCode: error ? errorCode(error) : null,
      });
    }
  }

  async #handle(request, response) {
    if (request.method !== 'POST' || new URL(request.url || '/', this.url).pathname !== '/v1/messages') {
      safeJsonResponse(response, 404, 'PROXY_ROUTE_NOT_FOUND');
      return;
    }
    if (!constantTimeEqual(request.headers['x-api-key'], this.clientToken)) {
      safeJsonResponse(response, 401, 'PROXY_AUTH_FAILED');
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(runtimeError(
      'The local client disconnected.',
      'CLIENT_DISCONNECTED',
    ));
    const responseClosed = () => {
      if (!response.writableEnded) abort();
    };
    this.#activeControllers.add(controller);
    request.once('aborted', abort);
    response.once('close', responseClosed);
    try {
      const rawBody = await readRequestBody(request, this.maxBodyBytes);
      let input;
      try {
        input = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw runtimeError('The proxy request body is not JSON.', 'INVALID_ANTHROPIC_BODY', {
          httpStatus: 400,
        });
      }
      const outboundBody = enforceAnthropicBenchmarkBody(input, {
        verifiedModelAliases: this.verifiedModelAliases,
      });
      const outboundBytes = Buffer.byteLength(JSON.stringify(outboundBody));
      const anonymousId = safeAnonymousId(request.headers['x-benchmark-anonymous-id']);
      let lastResult;
      for (let attempt = 1; attempt <= this.maxUpstreamAttempts; attempt += 1) {
        lastResult = await this.#attempt({
          anonymousId,
          attempt,
          outboundBody,
          bodyBytes: outboundBytes,
          request,
          response,
          signal: controller.signal,
        });
        if (lastResult.succeeded) {
          // #attempt settles the ledger and publishes its record in finally
          // before the response is ended. A completed client therefore always
          // observes a matching ledger/telemetry state.
          response.end();
          return;
        }
        if (!lastResult.retryable || response.headersSent || attempt === this.maxUpstreamAttempts) break;
        await delay(this.retryDelayMs);
      }
      safeJsonResponse(
        response,
        lastResult?.error?.httpStatus || 502,
        errorCode(lastResult?.error),
      );
    } finally {
      request.removeListener('aborted', abort);
      response.removeListener('close', responseClosed);
      this.#activeControllers.delete(controller);
    }
  }

  async close() {
    const server = this.#server;
    this.#server = null;
    const closing = runtimeError('The local benchmark proxy is closing.', 'PROXY_CLOSING');
    for (const controller of this.#activeControllers) {
      if (!controller.signal.aborted) controller.abort(closing);
    }
    let serverClosed = Promise.resolve();
    try {
      if (server) {
        serverClosed = new Promise((resolve) => {
          try { server.close(() => resolve()); }
          catch { resolve(); }
        });
        server.closeIdleConnections?.();
      }
      const handlers = Promise.allSettled([...this.#activeHandlers]);
      const graceful = await settlesWithin(
        Promise.all([serverClosed, handlers]),
        this.closeTimeoutMs,
      );
      if (!graceful) {
        server?.closeAllConnections?.();
        for (const socket of this.#sockets) socket.destroy();
        await settlesWithin(serverClosed, Math.min(250, this.closeTimeoutMs));
      }
    } finally {
      this.#upstreamApiKey = '';
    }
  }
}

function assertLoopbackProxyUrl(input) {
  let value;
  try {
    value = new URL(String(input));
  } catch {
    throw runtimeError('The local proxy URL is invalid.', 'INVALID_PROXY_URL');
  }
  if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1' || value.username ||
      value.password || value.search || value.hash) {
    throw runtimeError('The instrumented fetch requires an IPv4 loopback HTTP proxy.', 'INVALID_PROXY_URL');
  }
  value.pathname = '/v1/messages';
  return value.href;
}

function parseFetchBody(value) {
  if (typeof value === 'string') return JSON.parse(value);
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return JSON.parse(Buffer.from(value).toString('utf8'));
  }
  throw runtimeError('Instrumented Anthropic fetch requires a buffered JSON body.', 'INVALID_ANTHROPIC_BODY');
}

/** A drop-in fetch for the migrated ChatModelClient's Anthropic adapter. */
export function createInstrumentedAnthropicFetch(options = {}) {
  const target = assertLoopbackProxyUrl(options.proxyUrl);
  if (!options.clientToken) {
    throw runtimeError('The local proxy client token is required.', 'PROXY_AUTH_REQUIRED');
  }
  const fetchImplementation = options.fetch || globalThis.fetch;
  return async function instrumentedAnthropicFetch(_input, init = {}) {
    if (String(init.method || 'GET').toUpperCase() !== 'POST') {
      throw runtimeError('Only Anthropic Messages POST is allowed.', 'INVALID_ANTHROPIC_REQUEST');
    }
    let inputBody;
    try {
      inputBody = parseFetchBody(init.body);
    } catch (error) {
      if (error?.code) throw error;
      throw runtimeError('Instrumented Anthropic fetch received invalid JSON.', 'INVALID_ANTHROPIC_BODY');
    }
    const body = enforceAnthropicBenchmarkBody(inputBody, {
      verifiedModelAliases: options.verifiedModelAliases,
    });
    const incomingHeaders = new Headers(init.headers || {});
    const headers = new Headers({
      'content-type': 'application/json',
      'anthropic-version': incomingHeaders.get('anthropic-version') || '2023-06-01',
      'x-api-key': String(options.clientToken),
      'x-benchmark-anonymous-id': safeAnonymousId(
        typeof options.anonymousId === 'function' ? options.anonymousId() : options.anonymousId,
      ),
    });
    const beta = incomingHeaders.get('anthropic-beta');
    if (beta) headers.set('anthropic-beta', beta);
    return fetchImplementation(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: init.signal,
      redirect: 'error',
    });
  };
}

export async function startAnthropicBenchmarkProxy(options) {
  return new AnthropicBenchmarkProxy(options).start();
}
