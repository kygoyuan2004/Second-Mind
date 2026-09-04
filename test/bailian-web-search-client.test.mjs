import assert from 'node:assert/strict';
import test from 'node:test';
import { BailianWebSearchClient } from '../src/bailian-web-search-client.mjs';

function baseConfig(overrides = {}) {
  return {
    provider: 'bailian-web-search-mcp',
    enabled: true,
    endpoint: 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp',
    apiKey: 'fixture-bailian-secret',
    timeoutMs: 1_000,
    resultCount: 3,
    maxContextChars: 2_000,
    ...overrides,
  };
}

function validTool(overrides = {}) {
  return {
    name: 'bailian_web_search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 1_000 },
        count: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
    ...overrides,
  };
}

function toolResult(pages, status = 0) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ status, pages }) }],
  };
}

test('public status reports readiness without exposing endpoint or API key', () => {
  const config = baseConfig();
  const client = new BailianWebSearchClient(config, {
    sessionFactory: async () => { throw new Error('must not connect'); },
  });
  assert.deepEqual(client.publicStatus(), {
    provider: 'bailian-web-search-mcp',
    enabled: true,
    configured: true,
    ready: true,
    endpointConfigured: true,
    apiKeyConfigured: true,
    timeoutMs: 1_000,
    resultCount: 3,
    maxResultsPerDomain: 2,
    maxContextChars: 2_000,
  });
  const serialized = JSON.stringify(client.publicStatus());
  assert.equal(serialized.includes(config.endpoint), false);
  assert.equal(serialized.includes(config.apiKey), false);
});

test('only the fixed official MCP endpoint is accepted', async () => {
  let sessions = 0;
  const client = new BailianWebSearchClient(baseConfig({
    endpoint: 'https://attacker.example/mcp',
  }), {
    sessionFactory: async () => {
      sessions += 1;
      throw new Error('must not connect');
    },
  });
  assert.equal(client.publicStatus().configured, false);
  const result = await client.searchMany(['safe query']);
  assert.equal(sessions, 0);
  assert.equal(result.errors[0].code, 'BAILIAN_WEB_SEARCH_NOT_CONFIGURED');
});

test('one session serves unique queries sequentially and results are bounded and deduplicated', async () => {
  const calls = [];
  const activities = [];
  let sessions = 0;
  let closes = 0;
  let inFlight = false;
  const maxContextChars = 4_500;
  const client = new BailianWebSearchClient(baseConfig({ maxContextChars }), {
    sessionFactory: async () => {
      sessions += 1;
      return {
        listTools: async () => ({ tools: [validTool()] }),
        callTool: async (request) => {
          assert.equal(inFlight, false, 'calls must not overlap');
          inFlight = true;
          calls.push(request);
          await Promise.resolve();
          inFlight = false;
          if (request.arguments.query === 'First query') {
            return toolResult([
              {
                title: 'Primary result',
                url: 'https://example.com/article#section',
                snippet: 'a'.repeat(10_000),
                hostname: 'Example News',
                publish_time: '2026-08-31',
              },
              {
                title: 'Rejected HTTP result',
                url: 'http://example.com/insecure',
                snippet: 'not accepted',
              },
            ]);
          }
          return toolResult([
            {
              title: 'Duplicate result',
              url: 'https://example.com/article#another-fragment',
              snippet: 'duplicate',
            },
            {
              title: 'Second source',
              url: 'https://second.example.org/news',
              summary: 'second summary',
              source: { name: 'Second Publisher' },
              publishedAt: '2026-09-01T08:00:00Z',
            },
          ]);
        },
        close: async () => { closes += 1; },
      };
    },
  });

  const outcome = await client.searchMany(
    ['  First   query  ', 'Second query', 'first query'],
    { onActivity: (event) => activities.push(event) },
  );

  assert.equal(sessions, 1);
  assert.equal(closes, 1);
  assert.equal(outcome.queryCount, 2);
  assert.equal(outcome.attempts.length, 2);
  assert.deepEqual(outcome.attempts.map((attempt) => attempt.status), [
    'completed', 'completed',
  ]);
  assert.deepEqual(outcome.attempts.map((attempt) => attempt.resultCount), [1, 1]);
  assert.equal(outcome.attempts.every((attempt) => /^[a-f0-9]{64}$/.test(attempt.queryHash)), true);
  assert.equal(JSON.stringify(outcome.attempts).includes('First query'), false);
  assert.deepEqual(outcome.errors, []);
  assert.deepEqual(calls.map((call) => call.arguments), [
    { query: 'First query', count: 3 },
    { query: 'Second query', count: 3 },
  ]);
  assert.equal(calls.every((call) => call.name === 'bailian_web_search'), true);
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.candidates.length, 2);
  assert.equal(outcome.candidates.every((candidate) => !('snippet' in candidate)), true);
  assert.equal(outcome.candidates.every((candidate) => candidate.selected), true);
  assert.deepEqual(outcome.results.map((result) => result.queryIndex), [0, 1]);
  assert.equal(outcome.results[0].url, 'https://example.com/article');
  assert.equal(outcome.results[0].source, 'Example News');
  assert.equal(outcome.results[0].publishedAt, '2026-08-31');
  assert.equal(outcome.results[0].snippet.length, 4_000);
  assert.equal(outcome.results[1].source, 'Second Publisher');
  assert.equal(outcome.results.every((result) => result.url.startsWith('https://')), true);
  for (const queryIndex of [0, 1]) {
    assert.ok(
      JSON.stringify(outcome.results.filter((result) => result.queryIndex === queryIndex)).length <=
        maxContextChars,
    );
  }
  assert.deepEqual(activities.map((event) => event.stage), [
    'start', 'complete', 'start', 'complete',
  ]);
  assert.deepEqual(activities.map((event) => [event.index, event.total]), [
    [0, 2], [0, 2], [1, 2], [1, 2],
  ]);
});

test('an explicit task session connects and validates tools once across feedback rounds', async () => {
  let sessions = 0;
  let lists = 0;
  let closes = 0;
  const calls = [];
  const client = new BailianWebSearchClient(baseConfig(), {
    sessionFactory: async () => {
      sessions += 1;
      return {
        listTools: async () => {
          lists += 1;
          return { tools: [validTool()] };
        },
        callTool: async (request) => {
          calls.push(request.arguments.query);
          return toolResult([]);
        },
        close: async () => { closes += 1; },
      };
    },
  });

  const session = await client.openSession();
  await session.searchMany(['initial anchored query']);
  await session.searchMany(['feedback anchored query']);
  await session.close();
  await session.close();

  assert.equal(sessions, 1);
  assert.equal(lists, 1);
  assert.equal(closes, 1);
  assert.deepEqual(calls, ['initial anchored query', 'feedback anchored query']);
});

test('each query keeps an independent result budget for downstream round-robin selection', async () => {
  const maxContextChars = 900;
  const client = new BailianWebSearchClient(baseConfig({
    resultCount: 2,
    maxContextChars,
  }), {
    sessionFactory: async () => ({
      listTools: async () => ({ tools: [validTool()] }),
      callTool: async ({ arguments: { query } }) => toolResult(query === 'first facet'
        ? [
            {
              title: 'First facet primary source',
              url: 'https://first-facet.test/primary',
              snippet: 'first facet evidence '.repeat(300),
              source: 'First Publisher',
            },
            {
              title: 'First facet overflow source',
              url: 'https://first-overflow.test/secondary',
              snippet: 'different overflow evidence '.repeat(300),
              source: 'Overflow Publisher',
            },
          ]
        : [{
            title: 'Later facet remains available',
            url: 'https://later-facet.test/source',
            snippet: 'later facet evidence '.repeat(300),
            source: 'Later Publisher',
          }]),
      close: async () => {},
    }),
  });

  const outcome = await client.searchMany(['first facet', 'later facet']);
  const byQuery = [0, 1].map((queryIndex) => (
    outcome.results.filter((result) => result.queryIndex === queryIndex)
  ));

  assert.deepEqual(byQuery.map((results) => results.length), [1, 1]);
  assert.equal(JSON.stringify(outcome.results).length > maxContextChars, true);
  assert.equal(byQuery.every((results) => JSON.stringify(results).length <= maxContextChars), true);
  assert.deepEqual(outcome.attempts.map((attempt) => attempt.resultCount), [2, 1]);
  assert.deepEqual(outcome.attempts.map((attempt) => attempt.acceptedResultCount), [1, 1]);
  assert.equal(outcome.attempts[0].filterStats.contextLimit, 1);
  assert.equal(outcome.attempts[1].filterStats.contextLimit, 0);
  assert.equal(outcome.candidates.find((candidate) => candidate.queryIndex === 1)?.selected, true);
});

test('per-call resultCount overrides config and remains clamped by tool schema', async (t) => {
  for (const fixture of [
    { name: 'normal override', override: 15, schemaMaximum: 20, expected: 15 },
    { name: 'schema clamp', override: 15, schemaMaximum: 6, expected: 6 },
    { name: 'invalid override falls back to config', override: 'invalid', schemaMaximum: 20, expected: 3 },
  ]) {
    await t.test(fixture.name, async () => {
      const calls = [];
      const client = new BailianWebSearchClient(baseConfig(), {
        sessionFactory: async () => ({
          listTools: async () => ({
            tools: [validTool({
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', minLength: 2, maxLength: 1_000 },
                  count: { type: 'integer', minimum: 1, maximum: fixture.schemaMaximum },
                },
                required: ['query'],
              },
            })],
          }),
          callTool: async (request) => {
            calls.push(request);
            return toolResult([]);
          },
          close: async () => {},
        }),
      });

      await client.searchMany(['override query'], { resultCount: fixture.override });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].arguments.count, fixture.expected);
      assert.equal(client.publicStatus().resultCount, 3, 'an override must not mutate config');
    });
  }
});

test('candidates preserve bounded metadata while results enforce domain and near-duplicate quality', async () => {
  const pages = [
    {
      title: 'Qwen 发布重要模型更新',
      url: 'https://one.test/first',
      snippet: '第一条独立摘要，包含足够具体的信息。'.repeat(4),
      source: 'Example One',
    },
    {
      title: 'Qwen 发布重要模型更新｜媒体报道',
      url: 'https://two.test/title-duplicate',
      snippet: '另一段内容，用于证明标题相近时仍会过滤。'.repeat(4),
      source: 'Example Two',
    },
    {
      title: '另一项独立进展',
      url: 'https://three.test/snippet-original',
      snippet: '这是一段会在不同标点与空格下保持相同含义的长摘要内容。'.repeat(4),
      source: 'Example Three',
    },
    {
      title: '摘要重复的另一标题',
      url: 'https://four.test/snippet-duplicate',
      snippet: '这是一段会在不同标点、与 空格下保持相同含义的长摘要内容！'.repeat(4),
      source: 'Example Four',
    },
    {
      title: '同域结果一',
      url: 'https://baike.baidu.com/one',
      snippet: '同一域名下第一条内容。'.repeat(5),
      source: 'Same Domain',
    },
    {
      title: '同域结果二',
      url: 'https://tashuo.baidu.com/two',
      snippet: '同一域名下第二条不同内容。'.repeat(5),
      source: 'Same Domain',
    },
    {
      title: '同域结果三',
      url: 'https://news.baidu.com/three',
      snippet: '同一域名下第三条不同内容。'.repeat(5),
      source: 'Same Domain',
    },
  ];
  const client = new BailianWebSearchClient(baseConfig({
    resultCount: pages.length,
    maxResultsPerDomain: 3,
    maxContextChars: 20_000,
  }), {
    sessionFactory: async () => ({
      listTools: async () => ({ tools: [validTool()] }),
      callTool: async () => toolResult(pages),
      close: async () => {},
    }),
  });

  const outcome = await client.searchMany(['quality query'], { maxResultsPerDomain: 2 });

  assert.equal(outcome.candidates.length, pages.length);
  assert.equal(outcome.candidates.every((candidate) => !('snippet' in candidate)), true);
  assert.equal(outcome.attempts[0].resultCount, pages.length);
  assert.equal(outcome.attempts[0].acceptedResultCount, 4);
  assert.equal(outcome.results.length, 4);
  assert.deepEqual(outcome.results.map((result) => result.url), [
    'https://one.test/first',
    'https://three.test/snippet-original',
    'https://baike.baidu.com/one',
    'https://tashuo.baidu.com/two',
  ]);
  assert.equal(outcome.filterStats.nearDuplicate, 2);
  assert.equal(outcome.filterStats.domainLimit, 1);
  assert.deepEqual(outcome.attempts[0].filterStats, outcome.filterStats);
  assert.deepEqual(outcome.candidates.map(({ selected, selectionReason }) => ({
    selected,
    selectionReason,
  })), [
    { selected: true, selectionReason: 'selected' },
    { selected: false, selectionReason: 'near_duplicate' },
    { selected: true, selectionReason: 'selected' },
    { selected: false, selectionReason: 'near_duplicate' },
    { selected: true, selectionReason: 'selected' },
    { selected: true, selectionReason: 'selected' },
    { selected: false, selectionReason: 'domain_limit' },
  ]);
});

test('tools/list requires the bare tool name and compatible query/count schema', async (t) => {
  for (const fixture of [
    {
      name: 'prefixed name',
      tools: [validTool({ name: 'mcp__WebSearch__bailian_web_search' })],
      code: 'BAILIAN_WEB_SEARCH_TOOL_NOT_FOUND',
    },
    {
      name: 'missing count schema',
      tools: [validTool({
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      })],
      code: 'BAILIAN_WEB_SEARCH_TOOL_SCHEMA_INVALID',
    },
  ]) {
    await t.test(fixture.name, async () => {
      let calls = 0;
      let closes = 0;
      const client = new BailianWebSearchClient(baseConfig(), {
        sessionFactory: async () => ({
          listTools: async () => ({ tools: fixture.tools }),
          callTool: async () => { calls += 1; },
          close: async () => { closes += 1; },
        }),
      });
      const outcome = await client.searchMany(['valid query']);
      assert.deepEqual(outcome.attempts, []);
      assert.equal(calls, 0);
      assert.equal(closes, 1);
      assert.equal(outcome.errors.length, 1);
      assert.equal(outcome.errors[0].queryIndex, null);
      assert.equal(outcome.errors[0].code, fixture.code);
    });
  }
});

test('tool response failures keep stable error codes separate from messages', async (t) => {
  for (const fixture of [
    {
      name: 'provider failure status',
      response: toolResult([], 'failed'),
      code: 'BAILIAN_WEB_SEARCH_TOOL_ERROR',
      message: 'The WebSearch MCP response reported a failure.',
    },
    {
      name: 'missing pages array',
      response: { structuredContent: { status: 0 } },
      code: 'BAILIAN_WEB_SEARCH_INVALID_RESPONSE',
      message: 'The WebSearch MCP response did not contain a pages array.',
    },
  ]) {
    await t.test(fixture.name, async () => {
      const client = new BailianWebSearchClient(baseConfig(), {
        sessionFactory: async () => ({
          listTools: async () => ({ tools: [validTool()] }),
          callTool: async () => fixture.response,
          close: async () => {},
        }),
      });

      const outcome = await client.searchMany(['response error']);

      assert.equal(outcome.errors.length, 1);
      assert.equal(outcome.errors[0].code, fixture.code);
      assert.equal(outcome.errors[0].message, fixture.message);
      assert.notEqual(outcome.errors[0].code, fixture.message);
      assert.equal(outcome.attempts[0].errorCode, fixture.code);
    });
  }
});

test('setup HTTP failures use stable, redacted diagnostics without recording a search attempt', async () => {
  const activities = [];
  const secret = 'fixture-never-leak';
  const client = new BailianWebSearchClient(baseConfig({ apiKey: secret }), {
    sessionFactory: async () => {
      const error = new Error(`provider rejected Bearer ${secret}`);
      error.code = 404;
      throw error;
    },
  });

  const outcome = await client.searchMany(['current news'], {
    onActivity: (event) => activities.push(event),
  });

  assert.deepEqual(outcome.attempts, []);
  assert.equal(outcome.errors.length, 1);
  assert.equal(outcome.errors[0].queryIndex, null);
  assert.equal(outcome.errors[0].code, 'BAILIAN_WEB_SEARCH_NOT_ACTIVATED');
  assert.equal(JSON.stringify(outcome).includes(secret), false);
  assert.deepEqual(activities.map(({ stage, index, code }) => ({ stage, index, code })), [{
    stage: 'error', index: null, code: 'BAILIAN_WEB_SEARCH_NOT_ACTIVATED',
  }]);
});

test('a failed query is attempted once, emits error activity, and does not block the next query', async () => {
  const calls = [];
  const activities = [];
  const secret = 'fixture-never-leak';
  const client = new BailianWebSearchClient(baseConfig({ apiKey: secret }), {
    sessionFactory: async () => ({
      listTools: async () => ({ tools: [validTool()] }),
      callTool: async (request) => {
        calls.push(request.arguments.query);
        if (request.arguments.query === 'failing query') {
          const error = new Error(`provider rejected Bearer ${secret}`);
          error.code = 'REMOTE_FAILURE';
          throw error;
        }
        return toolResult([{
          title: 'Recovered result',
          url: 'https://example.net/recovered',
          snippet: 'grounded',
          source: 'Example',
        }]);
      },
      close: async () => {},
    }),
  });

  const outcome = await client.searchMany(['failing query', 'working query'], {
    onActivity: (event) => activities.push(event),
  });

  assert.deepEqual(calls, ['failing query', 'working query']);
  assert.equal(outcome.attempts.length, 2);
  assert.deepEqual(outcome.attempts.map((attempt) => attempt.status), [
    'failed', 'completed',
  ]);
  assert.equal(outcome.attempts[0].errorCode, 'REMOTE_FAILURE');
  assert.equal(outcome.attempts[1].resultCount, 1);
  assert.equal(outcome.errors.length, 1);
  assert.equal(outcome.errors[0].code, 'REMOTE_FAILURE');
  assert.equal(JSON.stringify(outcome).includes(secret), false);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].queryIndex, 1);
  assert.deepEqual(activities.map((event) => event.stage), [
    'start', 'error', 'start', 'complete',
  ]);
});

test('disabled, unconfigured, and pre-aborted searches never create a session', async () => {
  let sessions = 0;
  const factory = async () => {
    sessions += 1;
    throw new Error('must not connect');
  };
  const disabled = new BailianWebSearchClient(baseConfig({ enabled: false }), {
    sessionFactory: factory,
  });
  const disabledResult = await disabled.searchMany(['current news']);
  assert.equal(disabledResult.errors[0].code, 'BAILIAN_WEB_SEARCH_DISABLED');

  const unconfigured = new BailianWebSearchClient(baseConfig({ apiKey: '' }), {
    sessionFactory: factory,
  });
  const unconfiguredResult = await unconfigured.searchMany(['current news']);
  assert.equal(unconfiguredResult.errors[0].code, 'BAILIAN_WEB_SEARCH_NOT_CONFIGURED');

  const controller = new AbortController();
  controller.abort();
  const aborted = new BailianWebSearchClient(baseConfig(), { sessionFactory: factory });
  await assert.rejects(
    aborted.searchMany(['current news'], { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(sessions, 0);
});

test('cancellation during a tool call is rethrown after the session closes', async () => {
  const controller = new AbortController();
  let closes = 0;
  let calls = 0;
  const client = new BailianWebSearchClient(baseConfig(), {
    sessionFactory: async () => ({
      listTools: async () => ({ tools: [validTool()] }),
      callTool: async () => {
        calls += 1;
        controller.abort();
        throw controller.signal.reason;
      },
      close: async () => { closes += 1; },
    }),
  });

  await assert.rejects(
    client.searchMany(['cancelled query', 'must not run'], { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
  assert.equal(closes, 1);
});
