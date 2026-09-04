import { createHash } from 'node:crypto';

const TOOL_NAME = 'bailian_web_search';
const OFFICIAL_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RESULT_COUNT = 8;
const DEFAULT_MAX_CONTEXT_CHARS = 24_000;
const MAX_RESULT_COUNT = 50;
const MAX_PAGES_INSPECTED = 100;
const MAX_RESULTS_PER_DOMAIN = 2;
const DUPLICATE_TEXT_LIMITS = Object.freeze({
  title: 300,
  snippet: 2_000,
});
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'ac.jp', 'ac.nz', 'ac.uk',
  'co.jp', 'co.kr', 'co.nz', 'co.uk',
  'com.ar', 'com.au', 'com.br', 'com.cn', 'com.hk', 'com.mx', 'com.sg',
  'com.tr', 'com.tw',
  'edu.au', 'edu.cn', 'edu.hk', 'edu.sg', 'edu.tw',
  'go.jp', 'go.kr', 'gov.au', 'gov.cn', 'gov.hk', 'gov.sg', 'gov.tw', 'govt.nz',
  'me.uk', 'ne.jp', 'ne.kr',
  'net.au', 'net.cn', 'net.hk', 'net.nz', 'net.sg', 'net.tw', 'net.uk',
  'or.jp', 'or.kr',
  'org.au', 'org.cn', 'org.hk', 'org.nz', 'org.sg', 'org.tw', 'org.uk',
  'pe.kr', 're.kr',
  // Common multi-tenant suffixes need one tenant label to avoid merging unrelated sites.
  'blogspot.com', 'github.io', 'netlify.app', 'pages.dev', 'vercel.app',
]);
const FIELD_LIMITS = Object.freeze({
  title: 300,
  url: 2_048,
  snippet: 4_000,
  source: 200,
  publishedAt: 100,
});

class BailianWebSearchError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BailianWebSearchError';
    this.code = code;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function endpointState(endpoint) {
  if (!endpoint) return { configured: false, valid: false };
  try {
    const parsed = new URL(endpoint);
    const canonical = parsed.href.replace(/\/$/u, '');
    return {
      configured: true,
      valid: parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
        (!parsed.port || parsed.port === '443') && !parsed.search && !parsed.hash &&
        canonical === OFFICIAL_ENDPOINT,
    };
  } catch {
    return { configured: true, valid: false };
  }
}

function redact(value, secret) {
  let text = String(value || '');
  if (secret) text = text.split(secret).join('[redacted]');
  return text
    .replace(/bearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function stableProviderErrorCode(value, fallbackCode) {
  const raw = String(value || fallbackCode);
  return ({
    400: 'BAILIAN_WEB_SEARCH_BAD_REQUEST',
    401: 'BAILIAN_WEB_SEARCH_UNAUTHORIZED',
    403: 'BAILIAN_WEB_SEARCH_FORBIDDEN',
    404: 'BAILIAN_WEB_SEARCH_NOT_ACTIVATED',
    405: 'BAILIAN_WEB_SEARCH_PROTOCOL_UPGRADE_REQUIRED',
    429: 'BAILIAN_WEB_SEARCH_RATE_LIMITED',
  })[raw] || raw;
}

function safeError(error, apiKey, fallbackCode = 'BAILIAN_WEB_SEARCH_ERROR') {
  const aborted = error?.name === 'AbortError';
  return {
    code: aborted
      ? 'BAILIAN_WEB_SEARCH_ABORTED'
      : redact(stableProviderErrorCode(error?.code, fallbackCode), apiKey).slice(0, 80),
    message: redact(
      error?.message || (aborted ? 'Web search was cancelled.' : 'Web search failed.'),
      apiKey,
    ),
  };
}

function queryHash(query) {
  return createHash('sha256').update(query, 'utf8').digest('hex');
}

function abortError(signal) {
  if (signal?.reason instanceof Error && signal.reason.name === 'AbortError') {
    return signal.reason;
  }
  const error = new Error('Web search was cancelled.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function compactText(value, maximum) {
  if (value === undefined || value === null) return '';
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maximum) return text;
  if (maximum <= 1) return text.slice(0, maximum);
  return `${text.slice(0, maximum - 1)}…`;
}

function normalizedQuery(value) {
  return compactText(value, 8_000);
}

function uniqueQueries(queries) {
  if (!Array.isArray(queries)) return [];
  const seen = new Set();
  const output = [];
  for (let index = 0; index < queries.length; index += 1) {
    const query = normalizedQuery(queries[index]);
    if (!query) continue;
    const key = query.normalize('NFKC').toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ query, queryIndex: index });
  }
  return output;
}

function hasJsonType(schema, expected) {
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  return types.includes(expected);
}

function finiteSchemaInteger(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}

function validateSearchTool(listed) {
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  const tool = tools.find((candidate) => candidate?.name === TOOL_NAME);
  if (!tool) {
    throw new BailianWebSearchError(
      `MCP server did not expose the required ${TOOL_NAME} tool.`,
      'BAILIAN_WEB_SEARCH_TOOL_NOT_FOUND',
    );
  }
  const schema = tool.inputSchema;
  const properties = schema?.properties;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (
    schema?.type !== 'object' ||
    !properties || typeof properties !== 'object' ||
    !hasJsonType(properties.query, 'string') ||
    !hasJsonType(properties.count, 'integer') ||
    !required.includes('query')
  ) {
    throw new BailianWebSearchError(
      `${TOOL_NAME} has an incompatible query/count input schema.`,
      'BAILIAN_WEB_SEARCH_TOOL_SCHEMA_INVALID',
    );
  }
  const queryMinimum = finiteSchemaInteger(properties.query.minLength, 1);
  const queryMaximum = finiteSchemaInteger(properties.query.maxLength, 8_000);
  const countMinimum = finiteSchemaInteger(properties.count.minimum, 1);
  const countMaximum = finiteSchemaInteger(properties.count.maximum, MAX_RESULT_COUNT);
  if (
    queryMinimum < 0 || queryMaximum < queryMinimum ||
    countMinimum < 0 || countMaximum < countMinimum
  ) {
    throw new BailianWebSearchError(
      `${TOOL_NAME} has invalid query/count bounds.`,
      'BAILIAN_WEB_SEARCH_TOOL_SCHEMA_INVALID',
    );
  }
  return { queryMinimum, queryMaximum, countMinimum, countMaximum };
}

function validHttpsUrl(value) {
  const raw = compactText(value, FIELD_LIMITS.url + 1);
  if (!raw || raw.length > FIELD_LIMITS.url) return '';
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== '443')
    ) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

function sourceText(page) {
  if (typeof page?.source === 'string') return page.source;
  if (page?.source && typeof page.source === 'object') {
    return page.source.name || page.source.domain || page.source.site_name || '';
  }
  return page?.source_name || page?.site_name || page?.siteName ||
    page?.hostname || page?.domain || '';
}

function normalizePage(page, queryIndex) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return null;
  const url = validHttpsUrl(page.url || page.source_url || page.link);
  if (!url) return null;
  return {
    title: compactText(page.title || page.name, FIELD_LIMITS.title),
    url,
    snippet: compactText(
      page.snippet || page.summary || page.description || page.content || page.text,
      FIELD_LIMITS.snippet,
    ),
    source: compactText(sourceText(page), FIELD_LIMITS.source),
    publishedAt: compactText(
      page.publishedAt || page.published_at || page.publishTime ||
        page.publish_time || page.pub_date || page.date,
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

function domainKey(url) {
  try {
    const hostname = new URL(url).hostname.toLocaleLowerCase().replace(/\.$/u, '');
    if (!hostname || hostname.includes(':') || /^\d+(?:\.\d+){3}$/u.test(hostname)) {
      return hostname;
    }
    const labels = hostname.split('.').filter(Boolean);
    if (labels.length <= 2) return hostname;
    const suffix = labels.slice(-2).join('.');
    return labels.slice(MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? -3 : -2).join('.');
  } catch {
    return '';
  }
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
  const [smaller, larger] = leftGrams.size <= rightGrams.size
    ? [leftGrams, rightGrams]
    : [rightGrams, leftGrams];
  let overlap = 0;
  for (const gram of smaller) {
    if (larger.has(gram)) overlap += 1;
  }
  return (2 * overlap) / (leftGrams.size + rightGrams.size) >= threshold;
}

function isNearDuplicate(candidate, accepted) {
  return accepted.some((existing) => (
    nearDuplicateText(candidate.title, existing.title, {
      minimumLength: 8,
      threshold: 0.82,
      maximum: DUPLICATE_TEXT_LIMITS.title,
    }) ||
    nearDuplicateText(candidate.snippet, existing.snippet, {
      minimumLength: 40,
      threshold: 0.9,
      maximum: DUPLICATE_TEXT_LIMITS.snippet,
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

function parseJsonText(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function toolPayload(response) {
  if (response?.isError) {
    throw new BailianWebSearchError(
      'The WebSearch MCP tool returned an error.',
      'BAILIAN_WEB_SEARCH_TOOL_ERROR',
    );
  }
  if (response?.structuredContent && typeof response.structuredContent === 'object') {
    return response.structuredContent;
  }
  if (response?.toolResult && typeof response.toolResult === 'object') {
    return response.toolResult;
  }
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const texts = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean);
  for (const text of texts) {
    const parsed = parseJsonText(text);
    if (parsed) return parsed;
  }
  const combined = parseJsonText(texts.join('\n'));
  if (combined) return combined;
  throw new BailianWebSearchError(
    'The WebSearch MCP tool returned an invalid response.',
    'BAILIAN_WEB_SEARCH_INVALID_RESPONSE',
  );
}

function responseError(code, message) {
  return new BailianWebSearchError(message, code);
}

function pagesFromToolResponse(response) {
  const payload = toolPayload(response);
  if (
    payload?.status !== undefined &&
    payload.status !== 0 &&
    payload.status !== '0' &&
    payload.status !== 'success'
  ) {
    throw responseError(
      'BAILIAN_WEB_SEARCH_TOOL_ERROR',
      'The WebSearch MCP response reported a failure.',
    );
  }
  if (!Array.isArray(payload?.pages)) {
    throw responseError(
      'BAILIAN_WEB_SEARCH_INVALID_RESPONSE',
      'The WebSearch MCP response did not contain a pages array.',
    );
  }
  return payload.pages;
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
  try {
    await callback(Object.freeze({ ...event }));
  } catch {
    // Activity reporting is observational and must not change search behavior.
  }
}

async function createSdkSession({ endpoint, apiKey, timeoutMs, signal }) {
  let Client;
  let StreamableHTTPClientTransport;
  try {
    ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
    ({ StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    ));
  } catch (cause) {
    throw new BailianWebSearchError(
      'The Model Context Protocol SDK is unavailable.',
      'BAILIAN_WEB_SEARCH_SDK_UNAVAILABLE',
      { cause },
    );
  }
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client(
    { name: 'second-mind-bailian-web-search', version: '0.1.0' },
    { capabilities: {} },
  );
  const requestOptions = {
    signal,
    timeout: timeoutMs,
    maxTotalTimeout: timeoutMs,
  };
  await client.connect(transport, requestOptions);
  return {
    listTools: (options = requestOptions) => client.listTools({}, options),
    callTool: (params, options = requestOptions) =>
      client.callTool(params, undefined, options),
    close: () => client.close(),
  };
}

export class BailianWebSearchClient {
  constructor(config = {}, options = {}) {
    this.provider = compactText(config.provider || 'bailian-mcp', 100);
    this.enabled = config.enabled === true;
    this.endpoint = String(config.endpoint || '').trim();
    this.apiKey = String(config.apiKey || '').trim();
    this.timeoutMs = boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 300_000);
    this.resultCount = boundedInteger(
      config.resultCount,
      DEFAULT_RESULT_COUNT,
      1,
      MAX_RESULT_COUNT,
    );
    this.maxResultsPerDomain = boundedInteger(
      config.maxResultsPerDomain,
      MAX_RESULTS_PER_DOMAIN,
      1,
      MAX_RESULT_COUNT,
    );
    this.maxContextChars = boundedInteger(
      config.maxContextChars,
      DEFAULT_MAX_CONTEXT_CHARS,
      128,
      200_000,
    );
    this.sessionFactory = options.sessionFactory || createSdkSession;
  }

  publicStatus() {
    const endpoint = endpointState(this.endpoint);
    const configured = endpoint.valid && Boolean(this.apiKey);
    return {
      provider: this.provider,
      enabled: this.enabled,
      configured,
      ready: this.enabled && configured,
      endpointConfigured: endpoint.configured,
      apiKeyConfigured: Boolean(this.apiKey),
      timeoutMs: this.timeoutMs,
      resultCount: this.resultCount,
      maxResultsPerDomain: this.maxResultsPerDomain,
      maxContextChars: this.maxContextChars,
    };
  }

  async openSession(options = {}) {
    if (!this.enabled) {
      throw new BailianWebSearchError('Web search is disabled.', 'BAILIAN_WEB_SEARCH_DISABLED');
    }
    const endpoint = endpointState(this.endpoint);
    if (!endpoint.valid || !this.apiKey) {
      throw new BailianWebSearchError(
        'Web search requires the fixed official HTTPS endpoint and an API key.',
        'BAILIAN_WEB_SEARCH_NOT_CONFIGURED',
      );
    }
    const signal = options.signal;
    if (signal?.aborted) throw abortError(signal);
    const requestOptions = {
      signal,
      timeout: this.timeoutMs,
      maxTotalTimeout: this.timeoutMs,
    };
    let session;
    try {
      session = await this.sessionFactory({
        provider: this.provider,
        endpoint: this.endpoint,
        apiKey: this.apiKey,
        timeoutMs: this.timeoutMs,
        signal,
      });
      if (
        !session || typeof session.listTools !== 'function' ||
        typeof session.callTool !== 'function'
      ) {
        throw new BailianWebSearchError(
          'The MCP session factory returned an invalid session.',
          'BAILIAN_WEB_SEARCH_SESSION_INVALID',
        );
      }
      const bounds = validateSearchTool(await session.listTools(requestOptions));
      let closed = false;
      const handle = {
        owner: this,
        session,
        bounds,
        requestOptions,
        searchMany: (queries, childOptions = {}) => this.searchMany(queries, {
          ...childOptions,
          signal: childOptions.signal || signal,
          session: handle,
        }),
        close: async () => {
          if (closed) return;
          closed = true;
          try { await session.close?.(); } catch {
            // Closing is best effort and must not trigger a reconnect or retry.
          }
        },
      };
      return handle;
    } catch (error) {
      try { await session?.close?.(); } catch {}
      if (signal?.aborted || error?.name === 'AbortError') throw abortError(signal);
      const safe = safeError(error, this.apiKey, 'BAILIAN_WEB_SEARCH_SESSION_ERROR');
      throw new BailianWebSearchError(safe.message, safe.code, { cause: error });
    }
  }

  async searchMany(queries, options = {}) {
    const unique = uniqueQueries(queries);
    const output = {
      results: [],
      candidates: [],
      // Private server-side evidence retains bounded summaries so the research
      // pipeline can apply entity and authority ranking after all queries finish.
      // It is never copied into SSE candidate metadata or audit records.
      evidenceCandidates: [],
      attempts: [],
      errors: [],
      queryCount: unique.length,
      filterStats: emptyFilterStats(),
    };
    if (!unique.length) return output;

    const { signal, onActivity } = options;
    const total = unique.length;
    const setupError = (code, message) => {
      const record = { queryIndex: null, code, message };
      output.errors.push(record);
      return emitActivity(onActivity, {
        stage: 'error', index: null, total, ...record,
      });
    };
    if (!this.enabled) {
      await setupError('BAILIAN_WEB_SEARCH_DISABLED', 'Web search is disabled.');
      return output;
    }
    const endpoint = endpointState(this.endpoint);
    if (!endpoint.valid || !this.apiKey) {
      await setupError(
        'BAILIAN_WEB_SEARCH_NOT_CONFIGURED',
        'Web search requires an HTTPS endpoint and an API key.',
      );
      return output;
    }
    if (signal?.aborted) {
      throw abortError(signal);
    }

    let handle = options.session?.owner === this ? options.session : null;
    let ownsSession = false;
    try {
      if (!handle) {
        handle = await this.openSession({ signal });
        ownsSession = true;
      }
      const { session, bounds, requestOptions } = handle;
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
      const count = Math.min(
        bounds.countMaximum,
        Math.max(bounds.countMinimum, requestedResultCount),
      );
      const seenUrls = new Set();
      const acceptedForSimilarity = [];
      const domainCounts = new Map();

      for (const [index, item] of unique.entries()) {
        if (signal?.aborted) {
          throw abortError(signal);
        }
        if (
          item.query.length < bounds.queryMinimum ||
          item.query.length > bounds.queryMaximum
        ) {
          const record = {
            queryIndex: item.queryIndex,
            code: 'BAILIAN_WEB_SEARCH_QUERY_INVALID',
            message: 'Web search query does not satisfy the MCP tool schema.',
          };
          output.errors.push(record);
          await emitActivity(onActivity, {
            stage: 'error', index, total, ...record,
          });
          continue;
        }

        await emitActivity(onActivity, {
          stage: 'start', index, total, queryIndex: item.queryIndex, query: item.query,
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
        try {
          const response = await session.callTool({
            name: TOOL_NAME,
            arguments: { query: item.query, count },
          }, requestOptions);
          const pages = pagesFromToolResponse(response);
          let candidateCount = 0;
          let acceptedCount = 0;
          const queryResults = [];
          const inspectLimit = Math.min(
            pages.length,
            Math.max(count * 4, count),
            MAX_PAGES_INSPECTED,
          );
          for (let index = 0; index < inspectLimit && candidateCount < count; index += 1) {
            const candidate = normalizePage(pages[index], item.queryIndex);
            if (!candidate) {
              incrementFilterStat(output.filterStats, attempt.filterStats, 'invalid');
              continue;
            }
            if (seenUrls.has(candidate.url)) {
              incrementFilterStat(output.filterStats, attempt.filterStats, 'duplicateUrl');
              continue;
            }
            seenUrls.add(candidate.url);
            const candidateRecord = candidateMetadata(candidate);
            output.candidates.push(candidateRecord);
            output.evidenceCandidates.push({ ...candidate });
            candidateCount += 1;

            const domain = domainKey(candidate.url);
            if (domain && (domainCounts.get(domain) || 0) >= maxResultsPerDomain) {
              candidateRecord.selectionReason = 'domain_limit';
              incrementFilterStat(output.filterStats, attempt.filterStats, 'domainLimit');
              continue;
            }
            if (isNearDuplicate(candidate, acceptedForSimilarity)) {
              candidateRecord.selectionReason = 'near_duplicate';
              incrementFilterStat(output.filterStats, attempt.filterStats, 'nearDuplicate');
              continue;
            }
            const fitted = fitWithinContext(
              queryResults,
              candidate,
              this.maxContextChars,
            );
            if (!fitted) {
              candidateRecord.selectionReason = 'context_limit';
              incrementFilterStat(output.filterStats, attempt.filterStats, 'contextLimit');
              continue;
            }
            queryResults.push(fitted);
            output.results.push(fitted);
            acceptedForSimilarity.push(candidate);
            if (domain) domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
            candidateRecord.selected = true;
            candidateRecord.selectionReason = 'selected';
            acceptedCount += 1;
          }
          attempt.status = 'completed';
          attempt.resultCount = candidateCount;
          attempt.acceptedResultCount = acceptedCount;
          attempt.durationMs = Math.max(0, Date.now() - startedAt);
          await emitActivity(onActivity, {
            stage: 'complete',
            index,
            total,
            queryIndex: item.queryIndex,
            resultCount: candidateCount,
            acceptedResultCount: acceptedCount,
            filterStats: { ...attempt.filterStats },
          });
        } catch (error) {
          const safe = safeError(error, this.apiKey, 'BAILIAN_WEB_SEARCH_TOOL_ERROR');
          attempt.status = 'failed';
          attempt.durationMs = Math.max(0, Date.now() - startedAt);
          attempt.errorCode = safe.code;
          const record = { queryIndex: item.queryIndex, ...safe };
          output.errors.push(record);
          await emitActivity(onActivity, {
            stage: 'error', index, total, ...record,
          });
          if (signal?.aborted || error?.name === 'AbortError') throw abortError(signal);
        }
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw abortError(signal);
      const safe = safeError(error, this.apiKey, 'BAILIAN_WEB_SEARCH_SESSION_ERROR');
      await setupError(safe.code, safe.message);
    } finally {
      if (ownsSession) await handle?.close?.();
    }
    return output;
  }
}
