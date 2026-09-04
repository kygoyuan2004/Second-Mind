import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TAVILY_EXTRACT_ENDPOINT,
  TAVILY_SEARCH_ENDPOINT,
  TavilyExtractFallback,
  TavilyWebSearchClient,
  tavilyWebSearchInternals,
} from '../src/tavily-web-search-client.mjs';

const API_KEY = ['tvly', 'fixture', 'credential', 'only'].join('-');

function searchConfig(overrides = {}) {
  return {
    provider: 'tavily-rest',
    enabled: true,
    apiKey: API_KEY,
    timeoutMs: 1_000,
    resultCount: 6,
    maxResultsPerDomain: 2,
    maxContextChars: 20_000,
    ...overrides,
  };
}

test('the default Tavily transport uses a bearer header, rejects redirects, and bounds responses', async () => {
  let captured;
  const response = await tavilyWebSearchInternals.defaultRequest({
    endpoint: TAVILY_SEARCH_ENDPOINT,
    apiKey: API_KEY,
    body: { query: 'fixture' },
    signal: new AbortController().signal,
    maxResponseBytes: 1_024,
    kind: 'search',
    async fetchFn(endpoint, init) {
      captured = { endpoint, init };
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(captured.endpoint, TAVILY_SEARCH_ENDPOINT);
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.init.body), { query: 'fixture' });
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), { results: [] });

  await assert.rejects(
    tavilyWebSearchInternals.defaultRequest({
      endpoint: TAVILY_SEARCH_ENDPOINT,
      apiKey: API_KEY,
      body: { query: 'fixture' },
      signal: new AbortController().signal,
      maxResponseBytes: 1_024,
      kind: 'search',
      async fetchFn() {
        return new Response('{}', {
          status: 200,
          headers: { 'content-length': '2048' },
        });
      },
    }),
    (error) => error?.code === 'TAVILY_WEB_SEARCH_RESPONSE_TOO_LARGE',
  );
});

test('Tavily Search uses only the fixed official endpoint and normalizes its REST results', async () => {
  const calls = [];
  const activities = [];
  const client = new TavilyWebSearchClient(searchConfig({
    endpoint: 'https://credential-capture.invalid/search',
  }), {
    async request(request) {
      calls.push(request);
      return {
        statusCode: 200,
        body: {
          answer: 'provider answer must not enter evidence',
          results: [
            {
              title: 'Official documentation',
              url: 'https://docs.example.com/guide#section',
              content: 'A bounded search summary.',
              score: 0.99,
              raw_content: 'raw provider content must not be copied',
            },
            {
              title: 'Second source',
              url: 'https://news.example.org/item',
              content: 'A second summary.',
              published_date: '2026-09-03',
            },
          ],
        },
      };
    },
  });

  const output = await client.searchMany(['current provider behavior'], {
    resultCount: 6,
    onActivity: (event) => activities.push(event),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, TAVILY_SEARCH_ENDPOINT);
  assert.equal(calls[0].apiKey, API_KEY);
  assert.deepEqual(calls[0].body, {
    query: 'current provider behavior',
    search_depth: 'advanced',
    max_results: 6,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    topic: 'general',
  });
  assert.equal(output.results.length, 2);
  assert.deepEqual(output.results[0], {
    title: 'Official documentation',
    url: 'https://docs.example.com/guide',
    snippet: 'A bounded search summary.',
    source: 'docs.example.com',
    publishedAt: '',
    queryIndex: 0,
  });
  assert.equal(output.results[1].publishedAt, '2026-09-03');
  assert.equal(JSON.stringify(output).includes('provider answer'), false);
  assert.equal(JSON.stringify(output).includes('raw provider content'), false);
  assert.deepEqual(activities.map((event) => event.stage), ['start', 'complete']);
  assert.equal(activities.every((event) => event.provider === 'tavily-rest'), true);
});

test('Tavily Search keeps the shared candidate, filter, attempt, and error contract', async () => {
  const requests = [];
  const client = new TavilyWebSearchClient(searchConfig({ maxResultsPerDomain: 1 }), {
    async request(request) {
      requests.push(request.body.query);
      if (request.body.query === 'broken path') {
        return { statusCode: 429, body: { detail: `do not echo ${API_KEY}` } };
      }
      return {
        statusCode: 200,
        body: {
          results: [
            { title: 'One', url: 'https://one.example/a', content: 'First distinct summary.' },
            { title: 'Two', url: 'https://one.example/b', content: 'Second distinct summary.' },
            { title: 'Unsafe', url: 'http://unsafe.example/', content: 'Discard me.' },
          ],
        },
      };
    },
  });

  const output = await client.searchMany(['good path', 'good path', 'broken path']);

  assert.deepEqual(requests, ['good path', 'broken path']);
  assert.equal(output.queryCount, 2);
  assert.equal(output.results.length, 1);
  assert.equal(output.candidates.length, 2);
  assert.equal(output.evidenceCandidates.length, 2);
  assert.equal(output.filterStats.domainLimit, 1);
  assert.equal(output.filterStats.invalid, 1);
  assert.equal(output.attempts[0].status, 'completed');
  assert.equal(output.attempts[1].status, 'failed');
  assert.equal(output.errors[0].code, 'TAVILY_WEB_SEARCH_RATE_LIMITED');
  assert.equal(JSON.stringify(output).includes(API_KEY), false);
});

test('Tavily Search redacts its credential and treats caller cancellation as terminal', async () => {
  const controller = new AbortController();
  const client = new TavilyWebSearchClient(searchConfig(), {
    async request({ signal }) {
      controller.abort(new DOMException('cancelled by fixture', 'AbortError'));
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(
          Object.assign(new Error(`Bearer ${API_KEY}`), { code: 'FIXTURE_FAILURE' }),
        ), { once: true });
        setImmediate(resolve);
      });
      return { statusCode: 200, body: { results: [] } };
    },
  });

  await assert.rejects(
    client.searchMany(['cancel me'], { signal: controller.signal }),
    (error) => error?.name === 'AbortError' && !String(error?.message).includes(API_KEY),
  );
});

test('Tavily provider failures redact exact and bearer-form credentials before returning metadata', async () => {
  const client = new TavilyWebSearchClient(searchConfig(), {
    async request() {
      throw Object.assign(
        new Error(`provider rejected Bearer ${API_KEY}`),
        { code: `UPSTREAM_${API_KEY}` },
      );
    },
  });

  const output = await client.searchMany(['redaction fixture']);
  assert.equal(output.results.length, 0);
  assert.equal(output.errors.length, 1);
  assert.equal(JSON.stringify(output).includes(API_KEY), false);
  assert.match(output.errors[0].message, /\[redacted\]/u);
});

test('Tavily task sessions pin their client and stop accepting work after close', async () => {
  let calls = 0;
  const client = new TavilyWebSearchClient(searchConfig(), {
    async request() {
      calls += 1;
      return { statusCode: 200, body: { results: [] } };
    },
  });
  const session = await client.openSession();
  await session.searchMany(['one']);
  await session.close();
  assert.equal(calls, 1);
  await assert.rejects(
    session.searchMany(['two']),
    (error) => error?.code === 'TAVILY_WEB_SEARCH_SESSION_CLOSED',
  );
});

test('Tavily Extract sends only explicitly selected allowlist URLs and returns attributable documents', async () => {
  const calls = [];
  const fallback = new TavilyExtractFallback({
    enabled: true,
    apiKey: API_KEY,
    endpoint: 'https://credential-capture.invalid/extract',
    timeoutMs: 1_000,
  }, {
    async request(request) {
      calls.push(request);
      return {
        statusCode: 200,
        body: {
          results: [{
            url: 'https://allowed.example/article#ignored',
            raw_content: 'Verified extracted page text.',
          }],
          failed_results: [],
        },
      };
    },
  });

  const output = await fallback.extract({
    sources: [
      { id: 'W1', title: 'Allowed article', url: 'https://allowed.example/article' },
      { id: 'W2', title: 'Not selected', url: 'https://other.example/article' },
    ],
    sourceIds: ['W1', 'W404'],
    goal: 'this field is deliberately not sent',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, TAVILY_EXTRACT_ENDPOINT);
  assert.equal(calls[0].apiKey, API_KEY);
  assert.deepEqual(calls[0].body, {
    urls: ['https://allowed.example/article'],
    extract_depth: 'advanced',
    include_images: false,
    format: 'text',
  });
  assert.deepEqual(output.extractedSourceIds, ['W1']);
  assert.equal(output.documents[0].sourceId, 'W1');
  assert.equal(output.documents[0].extraction, 'tavily-extract-fallback');
  assert.deepEqual(output.toolCounts, { webSearch: 0, webExtractor: 1 });
  assert.equal(output.errors[0].code, 'TAVILY_EXTRACT_SOURCE_NOT_ALLOWED');
});

test('Tavily Extract rejects provider results outside the verified URL allowlist', async () => {
  const fallback = new TavilyExtractFallback({
    enabled: true,
    apiKey: API_KEY,
    timeoutMs: 1_000,
  }, {
    async request() {
      return {
        statusCode: 200,
        body: {
          results: [{ url: 'https://attacker.example/', raw_content: 'untrusted text' }],
        },
      };
    },
  });

  const output = await fallback.extract({
    sources: [{ id: 'W1', url: 'https://allowed.example/' }],
    sourceIds: ['W1'],
  });

  assert.equal(output.text, '');
  assert.deepEqual(output.documents, []);
  assert.deepEqual(output.extractedSourceIds, []);
  assert.equal(output.errors[0].code, 'TAVILY_EXTRACT_URL_NOT_ALLOWED');
  assert.equal(JSON.stringify(output).includes(API_KEY), false);
});

test('disabled or unconfigured Tavily adapters never issue a request', async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    return { statusCode: 200, body: { results: [] } };
  };
  const disabled = new TavilyWebSearchClient(searchConfig({ enabled: false }), { request });
  const unconfigured = new TavilyExtractFallback({ enabled: true, apiKey: '' }, { request });

  assert.equal((await disabled.searchMany(['query'])).errors[0].code, 'TAVILY_WEB_SEARCH_DISABLED');
  assert.equal((await unconfigured.extract({
    sources: [{ id: 'W1', url: 'https://allowed.example/' }],
    sourceIds: ['W1'],
  })).errors[0].code, 'TAVILY_EXTRACT_NOT_CONFIGURED');
  assert.equal(calls, 0);
});
