import { createHash } from 'node:crypto';

import { normalizeSafeHttpsUrl, registrableDomain } from './safe-web-reader.mjs';

export const TAVILY_WEB_SEARCH_PROVIDER = 'tavily-rest';
export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
export const TAVILY_EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';

const SEARCH_DEPTH = 'advanced';
const EXTRACT_DEPTH = 'advanced';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RESULT_COUNT = 8;
const DEFAULT_MAX_RESULTS_PER_DOMAIN = 2;
const DEFAULT_MAX_CONTEXT_CHARS = 24_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_COUNT = 20;
const MAX_RESULTS_INSPECTED = 100;
const MAX_EXTRACT_URLS = 3;
const MAX_EXTRACTED_CHARS = 16_000;
const SOURCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/u;

const FIELD_LIMITS = Object.freeze({
  title: 300,
  url: 2_048,
  snippet: 4_000,
  source: 200,
  publishedAt: 100,
});

export class TavilyWebSearchError extends Error {
  constructor(message, code = 'TAVILY_WEB_SEARCH_ERROR', options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'TavilyWebSearchError';
    this.code = code;
  }
}

export class TavilyExtractError extends Error {
  constructor(message, code = 'TAVILY_EXTRACT_ERROR', options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'TavilyExtractError';
    this.code = code;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function compactText(value, maximum) {
  if (value === undefined || value === null) return '';
  const output = String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (output.length <= maximum) return output;
  if (maximum <= 1) return output.slice(0, maximum);
  return `${output.slice(0, maximum - 1)}…`;
}

function validApiKey(value) {
  const key = String(value || '').trim();
  return key.length >= 8 && key.length <= 16_384 &&
    !/[\s\u0000-\u001f\u007f]/u.test(key);
}

function redactSecrets(value, apiKey) {
  let output = String(value || '');
  if (apiKey) output = output.split(apiKey).join('[redacted]');
  return output
    .replace(/bearer\s+[A-Za-z0-9._~+\/-]{8,}/giu, 'Bearer [redacted]')
    .replace(/tvly-[A-Za-z0-9._~+\/-]{4,}/gu, 'tvly-[redacted]');
}

function safeFailure(error, apiKey, fallbackCode, fallbackMessage) {
  const rawCode = String(error?.code || fallbackCode);
  const timedOut = rawCode === 'ETIMEDOUT';
  const aborted = error?.name === 'AbortError';
  const code = timedOut
    ? `${fallbackCode.replace(/_FAILED$/u, '')}_TIMEOUT`
    : aborted
      ? `${fallbackCode.replace(/_FAILED$/u, '')}_ABORTED`
      : compactText(redactSecrets(rawCode, apiKey), 80);
  return {
    code: /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : fallbackCode,
    message: compactText(redactSecrets(
      timedOut
        ? 'The Tavily request timed out.'
        : aborted
          ? 'The Tavily request was cancelled.'
          : error?.message || fallbackMessage,
      apiKey,
    ), 500),
  };
}

function abortError(signal, message = 'The Tavily request was cancelled.') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function deadlineSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortError(parentSignal));
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error('The Tavily request timed out.');
    error.name = 'AbortError';
    error.code = 'ETIMEDOUT';
    controller.abort(error);
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
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

async function readLimitedBody(response, maximum, errorFactory) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) throw errorFactory();
  const chunks = [];
  let length = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      length += buffer.length;
      if (length > maximum) {
        await response.body.cancel?.().catch(() => {});
        throw errorFactory();
      }
      chunks.push(buffer);
    }
  }
  return Buffer.concat(chunks, length);
}

async function defaultRequest({
  endpoint,
  apiKey,
  body,
  signal,
  maxResponseBytes,
  kind,
  fetchFn = globalThis.fetch,
}) {
  const response = await fetchFn(endpoint, {
    method: 'POST',
    signal,
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const prefix = kind === 'extract' ? 'TAVILY_EXTRACT' : 'TAVILY_WEB_SEARCH';
  const responseBody = await readLimitedBody(response, maxResponseBytes, () => (
    kind === 'extract'
      ? new TavilyExtractError(
          'The Tavily Extract response exceeded its byte limit.',
          `${prefix}_RESPONSE_TOO_LARGE`,
        )
      : new TavilyWebSearchError(
          'The Tavily Search response exceeded its byte limit.',
          `${prefix}_RESPONSE_TOO_LARGE`,
        )
  ));
  return { statusCode: response.status, body: responseBody };
}

function parseJsonResponse(value, ErrorType, code, message) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Converted to a stable, provider-specific error below.
  }
  throw new ErrorType(message, code);
}

function responseParts(rawResponse) {
  if (
    rawResponse && typeof rawResponse === 'object' &&
    (Object.hasOwn(rawResponse, 'statusCode') || Object.hasOwn(rawResponse, 'status'))
  ) {
    return {
      statusCode: Number(rawResponse.statusCode ?? rawResponse.status),
      body: Object.hasOwn(rawResponse, 'body') ? rawResponse.body : rawResponse,
    };
  }
  return { statusCode: 200, body: rawResponse };
}

function httpErrorCode(statusCode, prefix) {
  return ({
    400: `${prefix}_BAD_REQUEST`,
    401: `${prefix}_UNAUTHORIZED`,
    403: `${prefix}_FORBIDDEN`,
    429: `${prefix}_RATE_LIMITED`,
    432: `${prefix}_USAGE_LIMIT_EXCEEDED`,
    433: `${prefix}_PAYMENT_REQUIRED`,
  })[statusCode] || `${prefix}_HTTP_ERROR`;
}

function normalizedUrl(value) {
  try {
    const url = normalizeSafeHttpsUrl(compactText(value, FIELD_LIMITS.url + 1));
    const output = url.href;
    return output.length <= FIELD_LIMITS.url ? output : '';
  } catch {
    return '';
  }
}

function hostnameFor(url) {
  try { return new URL(url).hostname.toLocaleLowerCase(); } catch { return ''; }
}

function normalizedQuery(value) {
  return compactText(value, 8_000);
}

function uniqueQueries(queries) {
  if (!Array.isArray(queries)) return [];
  const output = [];
  const seen = new Set();
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = normalizedQuery(queries[queryIndex]);
    const key = query.normalize('NFKC').toLocaleLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    output.push({ query, queryIndex });
  }
  return output;
}

function queryHash(query) {
  return createHash('sha256').update(query, 'utf8').digest('hex');
}

function normalizeSearchResult(value, queryIndex) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const url = normalizedUrl(value.url);
  if (!url) return null;
  const hostname = hostnameFor(url);
  return {
    title: compactText(value.title || hostname, FIELD_LIMITS.title),
    url,
    snippet: compactText(value.content || value.snippet || value.description, FIELD_LIMITS.snippet),
    source: compactText(value.source || hostname, FIELD_LIMITS.source),
    publishedAt: compactText(
      value.publishedAt || value.published_at || value.published_date || value.date,
      FIELD_LIMITS.publishedAt,
    ),
    queryIndex,
  };
}

function candidateMetadata(candidate) {
  return {
    title: candidate.title,
    url: candidate.url,
    source: candidate.source,
    publishedAt: candidate.publishedAt,
    queryIndex: candidate.queryIndex,
    selected: false,
    selectionReason: '',
  };
}

function comparisonText(value, maximum) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, maximum);
}

function characterGrams(value, width = 3) {
  const grams = new Set();
  if (value.length < width) return grams;
  for (let index = 0; index <= value.length - width; index += 1) {
    grams.add(value.slice(index, index + width));
  }
  return grams;
}

function nearDuplicateText(left, right, { minimumLength, threshold, maximum }) {
  const leftText = comparisonText(left, maximum);
  const rightText = comparisonText(right, maximum);
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;
  if (Math.min(leftText.length, rightText.length) < minimumLength) return false;
  const leftGrams = characterGrams(leftText);
  const rightGrams = characterGrams(rightText);
  if (!leftGrams.size || !rightGrams.size) return false;
  let overlap = 0;
  const [smaller, larger] = leftGrams.size <= rightGrams.size
    ? [leftGrams, rightGrams]
    : [rightGrams, leftGrams];
  for (const gram of smaller) if (larger.has(gram)) overlap += 1;
  return (2 * overlap) / (leftGrams.size + rightGrams.size) >= threshold;
}

function isNearDuplicate(candidate, accepted) {
  return accepted.some((existing) => (
    nearDuplicateText(candidate.title, existing.title, {
      minimumLength: 8,
      threshold: 0.82,
      maximum: 300,
    }) || nearDuplicateText(candidate.snippet, existing.snippet, {
      minimumLength: 40,
      threshold: 0.9,
      maximum: 2_000,
    })
  ));
}

function emptyFilterStats() {
  return {
    invalid: 0,
    duplicateUrl: 0,
    domainLimit: 0,
    nearDuplicate: 0,
    contextLimit: 0,
  };
}

function incrementFilterStat(outputStats, attemptStats, field) {
  outputStats[field] += 1;
  attemptStats[field] += 1;
}

function serializedLength(results) {
  return JSON.stringify(results).length;
}

function fitWithinContext(results, candidate, maximum) {
  const fitted = { ...candidate };
  if (serializedLength([...results, fitted]) <= maximum) return fitted;
  for (const field of ['snippet', 'title', 'source', 'publishedAt']) {
    if (!fitted[field]) continue;
    const excess = serializedLength([...results, fitted]) - maximum;
    fitted[field] = fitted[field].slice(0, Math.max(0, fitted[field].length - excess));
    if (serializedLength([...results, fitted]) <= maximum) return fitted;
  }
  return null;
}

async function emitActivity(callback, event) {
  if (typeof callback !== 'function') return;
  try { await callback(Object.freeze({ ...event })); } catch {
    // Observability callbacks must not affect search or extraction behavior.
  }
}

export class TavilyWebSearchClient {
  constructor(config = {}, options = {}) {
    this.provider = TAVILY_WEB_SEARCH_PROVIDER;
    this.enabled = config.enabled === true;
    // Deliberately ignore runtime endpoint overrides. Credentials may only be
    // sent to Tavily's fixed official endpoint.
    this.endpoint = TAVILY_SEARCH_ENDPOINT;
    this.apiKey = String(config.apiKey || '').trim();
    this.timeoutMs = boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 300_000);
    this.resultCount = boundedInteger(config.resultCount, DEFAULT_RESULT_COUNT, 1, MAX_RESULT_COUNT);
    this.maxResultsPerDomain = boundedInteger(
      config.maxResultsPerDomain,
      DEFAULT_MAX_RESULTS_PER_DOMAIN,
      1,
      MAX_RESULT_COUNT,
    );
    this.maxContextChars = boundedInteger(
      config.maxContextChars,
      DEFAULT_MAX_CONTEXT_CHARS,
      128,
      200_000,
    );
    this.maxResponseBytes = boundedInteger(
      config.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.request = options.request || defaultRequest;
  }

  publicStatus() {
    const configured = validApiKey(this.apiKey);
    return {
      provider: this.provider,
      enabled: this.enabled,
      configured,
      ready: this.enabled && configured,
      endpointConfigured: true,
      apiKeyConfigured: configured,
      timeoutMs: this.timeoutMs,
      resultCount: this.resultCount,
      maxResultsPerDomain: this.maxResultsPerDomain,
      maxContextChars: this.maxContextChars,
    };
  }

  async openSession(options = {}) {
    if (!this.enabled) {
      throw new TavilyWebSearchError(
        'Tavily web search is disabled.',
        'TAVILY_WEB_SEARCH_DISABLED',
      );
    }
    if (!validApiKey(this.apiKey)) {
      throw new TavilyWebSearchError(
        'Tavily web search requires an API key.',
        'TAVILY_WEB_SEARCH_NOT_CONFIGURED',
      );
    }
    if (options.signal?.aborted) throw abortError(options.signal);
    let closed = false;
    const handle = {
      owner: this,
      provider: this.provider,
      searchMany: async (queries, childOptions = {}) => {
        if (closed) {
          throw new TavilyWebSearchError(
            'The Tavily task session is closed.',
            'TAVILY_WEB_SEARCH_SESSION_CLOSED',
          );
        }
        return this.searchMany(queries, {
          ...childOptions,
          signal: childOptions.signal || options.signal,
          session: handle,
        });
      },
      close: async () => { closed = true; },
    };
    return handle;
  }

  async searchMany(queries, options = {}) {
    const unique = uniqueQueries(queries);
    const output = {
      results: [],
      candidates: [],
      evidenceCandidates: [],
      attempts: [],
      errors: [],
      queryCount: unique.length,
      filterStats: emptyFilterStats(),
    };
    if (!unique.length) return output;
    const { signal, onActivity } = options;
    const total = unique.length;
    const setupError = async (code, message) => {
      const record = { queryIndex: null, code, message };
      output.errors.push(record);
      await emitActivity(onActivity, {
        provider: this.provider,
        stage: 'error',
        index: null,
        total,
        ...record,
      });
    };
    if (!this.enabled) {
      await setupError('TAVILY_WEB_SEARCH_DISABLED', 'Tavily web search is disabled.');
      return output;
    }
    if (!validApiKey(this.apiKey)) {
      await setupError(
        'TAVILY_WEB_SEARCH_NOT_CONFIGURED',
        'Tavily web search requires an API key.',
      );
      return output;
    }
    if (signal?.aborted) throw abortError(signal);

    const requestedResultCount = boundedInteger(
      options.resultCount,
      this.resultCount,
      1,
      MAX_RESULT_COUNT,
    );
    const maxResultsPerDomain = boundedInteger(
      options.maxResultsPerDomain,
      this.maxResultsPerDomain,
      1,
      MAX_RESULT_COUNT,
    );
    const seenUrls = new Set();
    const acceptedForSimilarity = [];
    const domainCounts = new Map();

    for (const [index, item] of unique.entries()) {
      if (signal?.aborted) throw abortError(signal);
      await emitActivity(onActivity, {
        provider: this.provider,
        stage: 'start',
        index,
        total,
        queryIndex: item.queryIndex,
        query: item.query,
      });
      const startedAt = Date.now();
      const attempt = {
        queryHash: queryHash(item.query),
        status: 'started',
        resultCount: 0,
        acceptedResultCount: 0,
        durationMs: 0,
        errorCode: '',
        filterStats: emptyFilterStats(),
      };
      output.attempts.push(attempt);
      const deadline = deadlineSignal(signal, this.timeoutMs);
      try {
        const rawResponse = await abortable(this.request({
          endpoint: TAVILY_SEARCH_ENDPOINT,
          apiKey: this.apiKey,
          body: {
            query: item.query,
            search_depth: SEARCH_DEPTH,
            max_results: requestedResultCount,
            include_answer: false,
            include_raw_content: false,
            include_images: false,
            topic: 'general',
          },
          signal: deadline.signal,
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
          kind: 'search',
        }), deadline.signal);
        const parts = responseParts(rawResponse);
        if (parts.statusCode < 200 || parts.statusCode >= 300) {
          throw new TavilyWebSearchError(
            'Tavily Search returned a non-success status.',
            httpErrorCode(parts.statusCode, 'TAVILY_WEB_SEARCH'),
          );
        }
        const response = parseJsonResponse(
          parts.body,
          TavilyWebSearchError,
          'TAVILY_WEB_SEARCH_INVALID_RESPONSE',
          'Tavily Search returned an invalid JSON response.',
        );
        if (!Array.isArray(response.results)) {
          throw new TavilyWebSearchError(
            'Tavily Search did not contain a results array.',
            'TAVILY_WEB_SEARCH_INVALID_RESPONSE',
          );
        }
        let candidateCount = 0;
        let acceptedCount = 0;
        const queryResults = [];
        const inspectLimit = Math.min(
          response.results.length,
          Math.max(requestedResultCount * 4, requestedResultCount),
          MAX_RESULTS_INSPECTED,
        );
        for (
          let resultIndex = 0;
          resultIndex < inspectLimit && candidateCount < requestedResultCount;
          resultIndex += 1
        ) {
          const candidate = normalizeSearchResult(response.results[resultIndex], item.queryIndex);
          if (!candidate) {
            incrementFilterStat(output.filterStats, attempt.filterStats, 'invalid');
            continue;
          }
          if (seenUrls.has(candidate.url)) {
            incrementFilterStat(output.filterStats, attempt.filterStats, 'duplicateUrl');
            continue;
          }
          seenUrls.add(candidate.url);
          const metadata = candidateMetadata(candidate);
          output.candidates.push(metadata);
          output.evidenceCandidates.push({ ...candidate });
          candidateCount += 1;

          const domain = registrableDomain(hostnameFor(candidate.url));
          if (domain && (domainCounts.get(domain) || 0) >= maxResultsPerDomain) {
            metadata.selectionReason = 'domain_limit';
            incrementFilterStat(output.filterStats, attempt.filterStats, 'domainLimit');
            continue;
          }
          if (isNearDuplicate(candidate, acceptedForSimilarity)) {
            metadata.selectionReason = 'near_duplicate';
            incrementFilterStat(output.filterStats, attempt.filterStats, 'nearDuplicate');
            continue;
          }
          const fitted = fitWithinContext(queryResults, candidate, this.maxContextChars);
          if (!fitted) {
            metadata.selectionReason = 'context_limit';
            incrementFilterStat(output.filterStats, attempt.filterStats, 'contextLimit');
            continue;
          }
          queryResults.push(fitted);
          output.results.push(fitted);
          acceptedForSimilarity.push(candidate);
          if (domain) domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
          metadata.selected = true;
          metadata.selectionReason = 'selected';
          acceptedCount += 1;
        }
        attempt.status = 'completed';
        attempt.resultCount = candidateCount;
        attempt.acceptedResultCount = acceptedCount;
        attempt.durationMs = Math.max(0, Date.now() - startedAt);
        await emitActivity(onActivity, {
          provider: this.provider,
          stage: 'complete',
          index,
          total,
          queryIndex: item.queryIndex,
          resultCount: candidateCount,
          acceptedResultCount: acceptedCount,
          filterStats: { ...attempt.filterStats },
        });
      } catch (error) {
        const failure = safeFailure(
          error,
          this.apiKey,
          'TAVILY_WEB_SEARCH_FAILED',
          'Tavily web search failed.',
        );
        attempt.status = 'failed';
        attempt.durationMs = Math.max(0, Date.now() - startedAt);
        attempt.errorCode = failure.code;
        const record = { queryIndex: item.queryIndex, ...failure };
        output.errors.push(record);
        await emitActivity(onActivity, {
          provider: this.provider,
          stage: 'error',
          index,
          total,
          ...record,
        });
        if (signal?.aborted || error?.name === 'AbortError') {
          if (signal?.aborted) throw abortError(signal);
          if (error?.code === 'ETIMEDOUT') {
            // A per-query timeout is a bounded provider failure; later distinct
            // queries may still run, matching the Bailian adapter contract.
          } else {
            throw error;
          }
        }
      } finally {
        deadline.cleanup();
      }
    }
    return output;
  }
}

function selectedExtractSources(sources, sourceIds) {
  const allowlist = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    const id = compactText(source?.id || source?.sourceId, 100);
    const url = normalizedUrl(source?.url);
    if (SOURCE_ID_PATTERN.test(id) && url && !allowlist.has(id)) {
      allowlist.set(id, {
        id,
        url,
        title: compactText(source?.title || hostnameFor(url), FIELD_LIMITS.title),
      });
    }
  }
  const selected = [];
  const errors = [];
  const seenIds = new Set();
  const seenUrls = new Set();
  for (const rawId of Array.isArray(sourceIds) ? sourceIds : []) {
    const id = compactText(rawId, 100);
    if (!SOURCE_ID_PATTERN.test(id) || seenIds.has(id)) continue;
    seenIds.add(id);
    const source = allowlist.get(id);
    if (!source) {
      errors.push({
        sourceId: id || null,
        code: 'TAVILY_EXTRACT_SOURCE_NOT_ALLOWED',
        message: 'The requested source ID was not in the current allowlist.',
      });
      continue;
    }
    if (!seenUrls.has(source.url)) {
      selected.push(source);
      seenUrls.add(source.url);
    }
    if (selected.length >= MAX_EXTRACT_URLS) break;
  }
  return { selected, errors };
}

function extractedContent(value) {
  return compactText(value?.raw_content || value?.content || value?.text, MAX_EXTRACTED_CHARS);
}

export class TavilyExtractFallback {
  constructor(config = {}, options = {}) {
    this.provider = 'tavily-extract-rest';
    this.enabled = config.enabled === true;
    this.endpoint = TAVILY_EXTRACT_ENDPOINT;
    this.apiKey = String(config.apiKey || '').trim();
    this.timeoutMs = boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 300_000);
    this.maxResponseBytes = boundedInteger(
      config.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.maxOutputChars = boundedInteger(
      config.maxOutputChars,
      MAX_EXTRACTED_CHARS,
      100,
      100_000,
    );
    this.request = options.request || defaultRequest;
  }

  publicStatus() {
    const configured = validApiKey(this.apiKey);
    return {
      provider: this.provider,
      enabled: this.enabled,
      configured,
      fallbackConfigured: this.enabled && configured,
      endpointConfigured: true,
      apiKeyConfigured: configured,
    };
  }

  async extract({ sources, sourceIds, signal, onActivity } = {}) {
    const output = {
      text: '',
      extractedSourceIds: [],
      documents: [],
      toolCounts: { webSearch: 0, webExtractor: 0 },
      attempts: [],
      errors: [],
      attempted: false,
    };
    const selection = selectedExtractSources(sources, sourceIds);
    output.errors.push(...selection.errors);
    if (!selection.selected.length) return output;
    if (!this.enabled) {
      output.errors.push({
        code: 'TAVILY_EXTRACT_DISABLED',
        message: 'Tavily Extract fallback is disabled.',
      });
      return output;
    }
    if (!validApiKey(this.apiKey)) {
      output.errors.push({
        code: 'TAVILY_EXTRACT_NOT_CONFIGURED',
        message: 'Tavily Extract fallback requires a Tavily API key.',
      });
      return output;
    }
    if (signal?.aborted) throw abortError(signal);

    output.attempted = true;
    output.toolCounts.webExtractor = 1;
    const startedAt = Date.now();
    const attempt = {
      status: 'started',
      sourceCount: selection.selected.length,
      durationMs: 0,
      errorCode: '',
      toolCounts: { ...output.toolCounts },
    };
    output.attempts.push(attempt);
    await emitActivity(onActivity, {
      provider: this.provider,
      stage: 'start',
      sourceCount: selection.selected.length,
      toolCounts: { ...output.toolCounts },
      billable: true,
    });
    const deadline = deadlineSignal(signal, this.timeoutMs);
    try {
      const rawResponse = await abortable(this.request({
        endpoint: TAVILY_EXTRACT_ENDPOINT,
        apiKey: this.apiKey,
        body: {
          urls: selection.selected.map((source) => source.url),
          extract_depth: EXTRACT_DEPTH,
          include_images: false,
          format: 'text',
        },
        signal: deadline.signal,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: this.maxResponseBytes,
        kind: 'extract',
      }), deadline.signal);
      const parts = responseParts(rawResponse);
      if (parts.statusCode < 200 || parts.statusCode >= 300) {
        throw new TavilyExtractError(
          'Tavily Extract returned a non-success status.',
          httpErrorCode(parts.statusCode, 'TAVILY_EXTRACT'),
        );
      }
      const response = parseJsonResponse(
        parts.body,
        TavilyExtractError,
        'TAVILY_EXTRACT_INVALID_RESPONSE',
        'Tavily Extract returned an invalid JSON response.',
      );
      if (!Array.isArray(response.results)) {
        throw new TavilyExtractError(
          'Tavily Extract did not contain a results array.',
          'TAVILY_EXTRACT_INVALID_RESPONSE',
        );
      }
      const allowedByUrl = new Map(selection.selected.map((source) => [source.url, source]));
      const normalizedResults = response.results.map((result) => ({
        raw: result,
        url: normalizedUrl(result?.url),
      }));
      if (normalizedResults.some((result) => !result.url || !allowedByUrl.has(result.url))) {
        throw new TavilyExtractError(
          'Tavily Extract returned a URL outside the verified allowlist.',
          'TAVILY_EXTRACT_URL_NOT_ALLOWED',
        );
      }
      let remaining = this.maxOutputChars;
      for (const result of normalizedResults) {
        if (!remaining) break;
        const source = allowedByUrl.get(result.url);
        const text = extractedContent(result.raw).slice(0, remaining);
        if (!text) continue;
        output.documents.push({
          sourceId: source.id,
          sourceIds: [source.id],
          title: source.title,
          url: source.url,
          text,
          fetchedAt: new Date().toISOString(),
          extraction: 'tavily-extract-fallback',
        });
        output.extractedSourceIds.push(source.id);
        remaining -= text.length;
      }
      if (!output.documents.length) {
        throw new TavilyExtractError(
          'Tavily Extract returned no usable text.',
          'TAVILY_EXTRACT_TEXT_MISSING',
        );
      }
      output.text = output.documents.map((document) => document.text).join('\n\n');
      attempt.status = 'completed';
      attempt.durationMs = Math.max(0, Date.now() - startedAt);
      await emitActivity(onActivity, {
        provider: this.provider,
        stage: 'complete',
        sourceCount: output.extractedSourceIds.length,
        toolCounts: { ...output.toolCounts },
        billable: true,
      });
    } catch (error) {
      const failure = safeFailure(
        error,
        this.apiKey,
        'TAVILY_EXTRACT_FAILED',
        'Tavily Extract failed.',
      );
      attempt.status = 'failed';
      attempt.durationMs = Math.max(0, Date.now() - startedAt);
      attempt.errorCode = failure.code;
      output.errors.push(failure);
      output.text = '';
      output.documents = [];
      output.extractedSourceIds = [];
      await emitActivity(onActivity, {
        provider: this.provider,
        stage: 'error',
        code: failure.code,
        toolCounts: { ...output.toolCounts },
        billable: true,
      });
      if (signal?.aborted) throw abortError(signal);
    } finally {
      deadline.cleanup();
    }
    return output;
  }
}

export const tavilyWebSearchInternals = Object.freeze({
  SEARCH_DEPTH,
  EXTRACT_DEPTH,
  defaultRequest,
  normalizedUrl,
  normalizeSearchResult,
  selectedExtractSources,
});
