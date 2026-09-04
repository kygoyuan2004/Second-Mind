const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_SIZE = 16;
const DASHSCOPE_EMBEDDING_PATH =
  '/api/v1/services/embeddings/text-embedding/text-embedding';

export class EmbeddingClientError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'EmbeddingClientError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProvider(value) {
  const provider = String(value || 'disabled').trim().toLowerCase();
  if (!['disabled', 'openai-compatible', 'dashscope'].includes(provider)) {
    throw new EmbeddingClientError(
      `Unsupported embedding provider: ${provider || '(empty)'}.`,
      'EMBEDDING_PROVIDER_UNSUPPORTED',
    );
  }
  return provider;
}

function trimTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isLocalHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === 'host.docker.internal' || value === '::1' ||
    value === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

export function assertSafeEmbeddingUrl(urlInput, allowInsecureHttp = false) {
  let url;
  try {
    url = new URL(urlInput);
  } catch {
    throw new EmbeddingClientError(
      'Embedding provider URL is invalid.',
      'EMBEDDING_INVALID_ENDPOINT',
    );
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new EmbeddingClientError(
      'Embedding provider URL must use HTTP or HTTPS.',
      'EMBEDDING_INVALID_ENDPOINT',
    );
  }
  if (url.username || url.password) {
    throw new EmbeddingClientError(
      'Embedding provider credentials must be supplied through an API-key secret, not the URL.',
      'EMBEDDING_INVALID_ENDPOINT',
    );
  }
  if (url.protocol === 'http:' && !isLocalHostname(url.hostname) && !allowInsecureHttp) {
    throw new EmbeddingClientError(
      'Plain HTTP is only allowed for local embedding providers. Set ALLOW_INSECURE_PROVIDER_HTTP=true only on a trusted private network.',
      'EMBEDDING_INSECURE_ENDPOINT',
    );
  }
  return url.href;
}

function endpointFor(config, provider) {
  const explicit = String(config.endpoint || '').trim();
  if (explicit) return explicit;
  const apiBase = trimTrailingSlashes(config.apiBase);
  if (!apiBase) {
    throw new EmbeddingClientError(
      'Embedding API base or endpoint is required.',
      'EMBEDDING_ENDPOINT_REQUIRED',
    );
  }
  return provider === 'dashscope'
    ? `${apiBase}${DASHSCOPE_EMBEDDING_PATH}`
    : `${apiBase}/embeddings`;
}

function redact(value, secret) {
  let text = String(value || '');
  if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(
    /(?:bearer\s+|api[_-]?key[=:"'\s]+)[A-Za-z0-9._~+\/-]{8,}/gi,
    (match) => `${match.split(/[=:"'\s]/, 1)[0]} [redacted]`,
  );
}

function providerMessage(payload) {
  return String(
    payload?.error?.message ||
      payload?.message ||
      payload?.error_description ||
      payload?.code ||
      '',
  ).trim();
}

function parseJson(raw, apiKey) {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new EmbeddingClientError(
      'Embedding provider returned an invalid JSON response.',
      'EMBEDDING_INVALID_RESPONSE',
      { cause: new Error(redact(cause?.message, apiKey)) },
    );
  }
}

async function readLimitedText(response, signal, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new EmbeddingClientError(
      'Embedding provider response exceeded the safety limit.',
      'EMBEDDING_RESPONSE_TOO_LARGE',
    );
  }
  if (!response.body) return '';
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
        throw new EmbeddingClientError(
          'Embedding provider response exceeded the safety limit.',
          'EMBEDDING_RESPONSE_TOO_LARGE',
        );
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

function abortError(code, message, cause, secret = '') {
  const safeCause = cause
    ? new Error(redact(cause?.message || String(cause), secret))
    : undefined;
  const error = new EmbeddingClientError(message, code, { cause: safeCause });
  error.name = 'AbortError';
  return error;
}

function vectorRows(payload, provider) {
  if (provider === 'dashscope' && Array.isArray(payload?.output?.embeddings)) {
    return payload.output.embeddings.map((row, position) => ({
      index: Number(row?.text_index ?? row?.index ?? position),
      vector: row?.embedding,
    }));
  }
  if (Array.isArray(payload?.data)) {
    return payload.data.map((row, position) => ({
      index: Number(row?.index ?? row?.text_index ?? position),
      vector: row?.embedding,
    }));
  }
  if (Array.isArray(payload?.output?.embeddings)) {
    return payload.output.embeddings.map((row, position) => ({
      index: Number(row?.text_index ?? row?.index ?? position),
      vector: row?.embedding,
    }));
  }
  return [];
}

function validateVectors(payload, provider, expectedCount, dimensions) {
  const rows = vectorRows(payload, provider).sort((left, right) => left.index - right.index);
  if (rows.length !== expectedCount) {
    throw new EmbeddingClientError(
      `Embedding provider returned ${rows.length} vectors for ${expectedCount} inputs.`,
      'EMBEDDING_COUNT_MISMATCH',
    );
  }
  const seen = new Set();
  const vectors = rows.map((row, position) => {
    if (!Number.isSafeInteger(row.index) || row.index < 0 || row.index >= expectedCount) {
      throw new EmbeddingClientError(
        'Embedding provider returned an invalid vector index.',
        'EMBEDDING_INVALID_RESPONSE',
      );
    }
    if (seen.has(row.index) || row.index !== position) {
      throw new EmbeddingClientError(
        'Embedding provider returned duplicate or missing vector indexes.',
        'EMBEDDING_INVALID_RESPONSE',
      );
    }
    seen.add(row.index);
    if (!Array.isArray(row.vector) || row.vector.length !== dimensions) {
      throw new EmbeddingClientError(
        `Embedding dimensions do not match the configured value (${dimensions}).`,
        'EMBEDDING_DIMENSION_MISMATCH',
      );
    }
    const vector = row.vector.map(Number);
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingClientError(
        'Embedding provider returned a vector containing non-finite values.',
        'EMBEDDING_INVALID_VECTOR',
      );
    }
    return vector;
  });
  return vectors;
}

function detectVectorDimensions(payload, provider) {
  const rows = vectorRows(payload, provider);
  if (rows.length !== 1 || !Array.isArray(rows[0]?.vector)) {
    throw new EmbeddingClientError(
      'Embedding provider did not return exactly one probe vector.',
      'EMBEDDING_INVALID_RESPONSE',
    );
  }
  const vector = rows[0].vector.map(Number);
  if (
    vector.length < 8 || vector.length > 32_768 ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new EmbeddingClientError(
      'Embedding provider returned an invalid probe vector.',
      'EMBEDDING_INVALID_VECTOR',
    );
  }
  return vector.length;
}

function requestBody(provider, config, texts, options) {
  if (provider === 'dashscope') {
    const textType = options.textType === 'query' ? 'query' : 'document';
    const parameters = {
      text_type: textType,
      output_type: 'dense',
    };
    if (options.detectDimensions !== true) parameters.dimension = config.dimensions;
    if (textType === 'query' && options.instruct) {
      parameters.instruct = String(options.instruct);
    }
    return {
      model: config.model,
      input: { texts },
      parameters,
    };
  }
  return {
    model: config.model,
    input: texts,
  };
}

export class EmbeddingClient {
  constructor(embeddingConfig = {}, options = {}) {
    this.config = { ...embeddingConfig };
    this.provider = normalizeProvider(embeddingConfig.provider);
    this.enabled = this.provider !== 'disabled';
    this.apiBase = trimTrailingSlashes(embeddingConfig.apiBase);
    this.allowInsecureHttp = embeddingConfig.allowInsecureHttp === true;
    this.endpoint = this.enabled
      ? assertSafeEmbeddingUrl(
        endpointFor(embeddingConfig, this.provider),
        this.allowInsecureHttp,
      )
      : '';
    this.apiKey = String(embeddingConfig.apiKey || '');
    this.model = String(embeddingConfig.model || '').trim();
    this.embeddingModel = this.model;
    this.dimensions = positiveInteger(embeddingConfig.dimensions, 0);
    this.batchSize = positiveInteger(embeddingConfig.batchSize, DEFAULT_BATCH_SIZE);
    this.timeoutMs = positiveInteger(embeddingConfig.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.fetchFn = options.fetchFn || embeddingConfig.fetchFn || globalThis.fetch;

    if (this.enabled && !this.model) {
      throw new EmbeddingClientError(
        'Embedding model is required when embeddings are enabled.',
        'EMBEDDING_MODEL_REQUIRED',
      );
    }
    if (this.enabled && !this.dimensions) {
      throw new EmbeddingClientError(
        'A positive embedding dimension is required.',
        'EMBEDDING_DIMENSIONS_REQUIRED',
      );
    }
    if (this.enabled && typeof this.fetchFn !== 'function') {
      throw new EmbeddingClientError(
        'No fetch implementation is available for the embedding provider.',
        'EMBEDDING_FETCH_UNAVAILABLE',
      );
    }
  }

  status() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      model: this.enabled ? this.model : null,
      dimensions: this.enabled ? this.dimensions : null,
      endpointConfigured: Boolean(this.endpoint),
      apiKeyConfigured: Boolean(this.apiKey),
    };
  }

  async request(texts, options = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const relayAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener('abort', relayAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    try {
      const response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody(this.provider, this, texts, options)),
        signal: controller.signal,
      });
      const maxResponseBytes = Math.min(
        64 * 1024 * 1024,
        Math.max(1024 * 1024, texts.length * this.dimensions * 24 + 64 * 1024),
      );
      const raw = await readLimitedText(response, controller.signal, maxResponseBytes);
      const payload = parseJson(raw, this.apiKey);
      if (!response.ok || payload?.error || (this.provider === 'dashscope' && payload?.code)) {
        const detail = redact(providerMessage(payload), this.apiKey).slice(0, 300);
        throw new EmbeddingClientError(
          `Embedding provider request failed (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`,
          'EMBEDDING_API_ERROR',
          { status: response.status },
        );
      }
      if (options.detectDimensions === true) {
        return detectVectorDimensions(payload, this.provider);
      }
      return validateVectors(payload, this.provider, texts.length, this.dimensions);
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        if (options.signal?.aborted && !timedOut) {
          throw abortError(
            'EMBEDDING_ABORTED',
            'Embedding request was cancelled.',
            error,
            this.apiKey,
          );
        }
        throw abortError(
          'EMBEDDING_TIMEOUT',
          `Embedding request exceeded ${this.timeoutMs} ms.`,
          error,
          this.apiKey,
        );
      }
      if (error instanceof EmbeddingClientError) throw error;
      throw new EmbeddingClientError(
        `Embedding provider request failed: ${redact(error?.message || 'network error', this.apiKey).slice(0, 300)}`,
        'EMBEDDING_NETWORK_ERROR',
        {
          cause: new Error(
            redact(error?.message || 'network error', this.apiKey).slice(0, 300),
          ),
        },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relayAbort);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  async embed(textsInput, options = {}) {
    const texts = (Array.isArray(textsInput) ? textsInput : [textsInput])
      .map((value) => String(value ?? ''));
    if (!texts.length) return [];
    if (texts.some((value) => !value.trim())) {
      throw new EmbeddingClientError(
        'Embedding input must contain non-empty text.',
        'EMBEDDING_INPUT_REQUIRED',
      );
    }
    if (!this.enabled) {
      throw new EmbeddingClientError('Embeddings are disabled.', 'EMBEDDING_DISABLED');
    }

    const output = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      if (options.signal?.aborted) {
        throw abortError('EMBEDDING_ABORTED', 'Embedding request was cancelled.');
      }
      const batch = texts.slice(offset, offset + this.batchSize);
      output.push(...await this.request(batch, options));
    }
    return output;
  }

  async detectDimensions(options = {}) {
    if (!this.enabled) {
      throw new EmbeddingClientError('Embeddings are disabled.', 'EMBEDDING_DISABLED');
    }
    return this.request(['Second Mind embedding dimension check.'], {
      ...options,
      detectDimensions: true,
      textType: 'document',
    });
  }
}

export const embeddingClientInternals = {
  endpointFor,
  detectVectorDimensions,
  isLocalHostname,
  redact,
  requestBody,
  validateVectors,
  readLimitedText,
};
