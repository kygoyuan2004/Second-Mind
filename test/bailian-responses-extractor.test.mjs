import assert from 'node:assert/strict';
import test from 'node:test';
import { BailianResponsesExtractor } from '../src/bailian-responses-extractor.mjs';

const SK_WS_PREFIX = ['sk', 'ws'].join('-');
const API_KEY = `${SK_WS_PREFIX}-fixture-responses-capable-key`;
const ENDPOINT = 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses';

function config(overrides = {}) {
  return {
    enabled: true,
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function sources() {
  return [
    {
      id: 'W1',
      url: 'https://gov.example.cn/appointment#fragment',
      title: 'Appointment notice',
      snippet: 'This untrusted snippet must not be sent to Responses.',
      localPath: '/private/vault/secret.md',
    },
    {
      id: 'W2',
      url: 'https://exchange.example.cn/filing.pdf',
      title: 'Exchange filing',
    },
  ];
}

function successResponse(overrides = {}) {
  return {
    statusCode: 200,
    body: {
      id: 'response-fixture',
      output_text: 'The appointment notice directly states the current role.',
      output: [
        { type: 'web_search_call', id: 'search-1' },
        {
          type: 'web_extractor_call',
          id: 'extract-1',
          urls: ['https://gov.example.cn/appointment'],
        },
      ],
      usage: {
        x_tools: {
          web_search: { count: 1 },
          web_extractor: { count: 1 },
        },
      },
      ...overrides,
    },
  };
}

test('public status accepts a Responses-capable sk-ws key without endpoint or API key disclosure', () => {
  const extractor = new BailianResponsesExtractor(config(), {
    request: async () => { throw new Error('must not request'); },
  });
  assert.deepEqual(extractor.publicStatus(), {
    enabled: true,
    configured: true,
    provider: 'bailian-responses',
    fallbackConfigured: true,
  });
  const serialized = JSON.stringify(extractor.publicStatus());
  assert.equal(serialized.includes(API_KEY), false);
  assert.equal(serialized.includes(ENDPOINT), false);
});

test('public status accepts the current global DashScope Responses endpoint', () => {
  const extractor = new BailianResponsesExtractor(config({
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/responses',
  }), {
    request: async () => { throw new Error('must not request'); },
  });
  assert.equal(extractor.publicStatus().configured, true);
});

test('uses fixed qwen3.8-max Responses tools and sends only verified URLs, goal, and anchors', async () => {
  let captured;
  const activities = [];
  const extractor = new BailianResponsesExtractor(config(), {
    request: async (request) => {
      captured = request;
      return successResponse();
    },
  });
  const outcome = await extractor.extract({
    sources: sources(),
    sourceIds: ['W1'],
    goal: 'Determine the current administrative rank',
    anchors: ['测试人物甲', '甲州', '投控集团'],
    onActivity: (event) => activities.push(event),
  });

  assert.equal(captured.endpoint, ENDPOINT);
  assert.equal(captured.apiKey, API_KEY);
  assert.equal(captured.body.model, 'qwen3.8-max');
  assert.equal(captured.body.store, false);
  assert.deepEqual(captured.body.reasoning, { effort: 'low' });
  assert.equal(captured.body.enable_thinking, true);
  assert.deepEqual(captured.body.tools, [
    { type: 'web_search' },
    { type: 'web_extractor' },
  ]);
  const input = JSON.parse(captured.body.input);
  assert.deepEqual(input.verifiedUrls, ['https://gov.example.cn/appointment']);
  assert.equal(input.goal, 'Determine the current administrative rank');
  assert.deepEqual(input.requiredEntityAnchors, ['测试人物甲', '甲州', '投控集团']);
  assert.equal(captured.body.input.includes('untrusted snippet'), false);
  assert.equal(captured.body.input.includes('/private/vault'), false);
  assert.equal(outcome.text, 'The appointment notice directly states the current role.');
  assert.deepEqual(outcome.extractedSourceIds, ['W1']);
  assert.deepEqual(outcome.toolCounts, { webSearch: 1, webExtractor: 1 });
  assert.equal(outcome.attempted, true);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.attempts.length, 1);
  assert.equal(outcome.attempts[0].status, 'completed');
  assert.deepEqual(outcome.attempts[0].toolCounts, { webSearch: 1, webExtractor: 1 });
  assert.deepEqual(activities.map((event) => event.stage), ['start', 'complete']);
  assert.equal(activities.every((event) => event.billable), true);
});

test('discards all extracted text if web_extractor reports a URL outside the allowlist', async () => {
  const extractor = new BailianResponsesExtractor(config(), {
    request: async () => successResponse({
      output: [
        {
          type: 'web_extractor_call',
          urls: [
            'https://gov.example.cn/appointment',
            'https://attacker.example.net/injected',
          ],
        },
      ],
    }),
  });
  const outcome = await extractor.extract({
    sources: sources(),
    sourceIds: ['W1'],
    goal: 'Extract the role',
    anchors: ['测试人物甲'],
  });
  assert.equal(outcome.text, '');
  assert.deepEqual(outcome.extractedSourceIds, []);
  assert.equal(outcome.errors[0].code, 'BAILIAN_EXTRACTOR_URL_NOT_ALLOWED');
});

test('invalid extractor URL entries cannot disappear during allowlist validation', async () => {
  const extractor = new BailianResponsesExtractor(config(), {
    request: async () => successResponse({
      output: [{
        type: 'web_extractor_call',
        urls: ['https://gov.example.cn/appointment', 'http://127.0.0.1/private'],
      }],
    }),
  });
  const outcome = await extractor.extract({
    sources: sources(), sourceIds: ['W1'], goal: 'goal', anchors: ['anchor'],
  });
  assert.equal(outcome.text, '');
  assert.equal(outcome.errors[0].code, 'BAILIAN_EXTRACTOR_URL_NOT_ALLOWED');
});

test('requires extractor call URL attribution and does not accept output-only claims', async (t) => {
  await t.test('missing extractor call', async () => {
    const extractor = new BailianResponsesExtractor(config(), {
      request: async () => successResponse({ output: [{ type: 'message' }] }),
    });
    const outcome = await extractor.extract({
      sources: sources(), sourceIds: ['W1'], goal: 'goal', anchors: ['anchor'],
    });
    assert.equal(outcome.text, '');
    assert.equal(outcome.errors[0].code, 'BAILIAN_EXTRACTOR_CALL_MISSING');
  });

  await t.test('missing URL attribution', async () => {
    const extractor = new BailianResponsesExtractor(config(), {
      request: async () => successResponse({
        output: [{ type: 'web_extractor_call', output: 'opaque output' }],
      }),
    });
    const outcome = await extractor.extract({
      sources: sources(), sourceIds: ['W1'], goal: 'goal', anchors: ['anchor'],
    });
    assert.equal(outcome.text, '');
    assert.equal(outcome.errors[0].code, 'BAILIAN_EXTRACTOR_URLS_MISSING');
  });
});

test('unknown source IDs, invalid URLs, disabled state, endpoint, and key never call Responses', async (t) => {
  for (const fixture of [
    {
      name: 'unknown source ID',
      overrides: {},
      sourceList: sources(),
      sourceIds: ['W9'],
      expected: 'BAILIAN_EXTRACTOR_SOURCE_NOT_ALLOWED',
    },
    {
      name: 'invalid source URL',
      overrides: {},
      sourceList: [{ id: 'W1', url: 'http://example.com/' }],
      sourceIds: ['W1'],
      expected: 'BAILIAN_EXTRACTOR_SOURCE_NOT_ALLOWED',
    },
    {
      name: 'disabled',
      overrides: { enabled: false },
      sourceList: sources(),
      sourceIds: ['W1'],
      expected: 'BAILIAN_EXTRACTOR_DISABLED',
    },
    {
      name: 'endpoint could exfiltrate key',
      overrides: { endpoint: 'https://attacker.example.net/responses' },
      sourceList: sources(),
      sourceIds: ['W1'],
      expected: 'BAILIAN_EXTRACTOR_NOT_CONFIGURED',
    },
    ...[
      { name: 'empty API key', apiKey: '' },
      { name: 'sk-ws API key shorter than eight characters', apiKey: `${SK_WS_PREFIX}-x` },
      { name: 'API key longer than 16384 characters', apiKey: 'x'.repeat(16_385) },
      { name: 'API key containing whitespace', apiKey: `${SK_WS_PREFIX}-valid key` },
      { name: 'API key containing an ASCII control character', apiKey: `${SK_WS_PREFIX}-valid\u0000key` },
    ].map(({ name, apiKey }) => ({
      name,
      overrides: { apiKey },
      sourceList: sources(),
      sourceIds: ['W1'],
      expected: 'BAILIAN_EXTRACTOR_NOT_CONFIGURED',
    })),
  ]) {
    await t.test(fixture.name, async () => {
      let calls = 0;
      const extractor = new BailianResponsesExtractor(config(fixture.overrides), {
        request: async () => {
          calls += 1;
          throw new Error('must not call');
        },
      });
      const outcome = await extractor.extract({
        sources: fixture.sourceList,
        sourceIds: fixture.sourceIds,
        goal: 'goal',
        anchors: ['anchor'],
      });
      assert.equal(calls, 0);
      assert.equal(outcome.errors.some((error) => error.code === fixture.expected), true);
    });
  }
});

test('provider failure is attempted once and redacts API keys and bearer tokens', async () => {
  let calls = 0;
  const extractor = new BailianResponsesExtractor(config(), {
    request: async () => {
      calls += 1;
      const error = new Error(`failed with Bearer ${API_KEY} and ${API_KEY}`);
      error.code = `SECRET_${API_KEY}`;
      throw error;
    },
  });
  const outcome = await extractor.extract({
    sources: sources(), sourceIds: ['W1'], goal: 'goal', anchors: ['anchor'],
  });
  assert.equal(calls, 1);
  assert.equal(outcome.attempts[0].status, 'failed');
  const serialized = JSON.stringify(outcome);
  assert.equal(serialized.includes(API_KEY), false);
  assert.match(serialized, /redacted/u);
});

test('redacts a long opaque API key from error code and message before truncation', async () => {
  const opaqueApiKey = [
    ['opaque', 'workspace', 'credential'].join('.'),
    'x'.repeat(160),
  ].join('.');
  const extractor = new BailianResponsesExtractor(config({ apiKey: opaqueApiKey }), {
    request: async () => {
      const error = new Error(`provider message ${opaqueApiKey} must stay private`);
      error.code = `${opaqueApiKey}:PROVIDER_FAILURE`;
      throw error;
    },
  });
  const outcome = await extractor.extract({
    sources: sources(), sourceIds: ['W1'], goal: 'goal', anchors: ['anchor'],
  });
  const serialized = JSON.stringify(outcome);
  assert.equal(serialized.includes(opaqueApiKey), false);
  assert.equal(serialized.includes(opaqueApiKey.slice(0, 80)), false);
  assert.equal(outcome.attempts[0].errorCode, '[redacted]:PROVIDER_FAILURE');
  assert.equal(outcome.errors[0].message, 'provider message [redacted] must stay private');
});

test('uses message output fallback and counts output items when usage counters are absent', async () => {
  const extractor = new BailianResponsesExtractor(config(), {
    request: async () => ({
      statusCode: 200,
      body: JSON.stringify({
        output: [
          { type: 'web_search_call' },
          { type: 'web_extractor_call', urls: ['https://exchange.example.cn/filing.pdf'] },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Directly stated filing fact.' }],
          },
        ],
      }),
    }),
  });
  const outcome = await extractor.extract({
    sources: sources(), sourceIds: ['W2'], goal: 'goal', anchors: ['anchor'],
  });
  assert.equal(outcome.text, 'Directly stated filing fact.');
  assert.deepEqual(outcome.extractedSourceIds, ['W2']);
  assert.deepEqual(outcome.toolCounts, { webSearch: 1, webExtractor: 1 });
});

test('rejects generated extraction text that contains an unknown external URL', async () => {
  const extractor = new BailianResponsesExtractor(config(), {
    request: async () => successResponse({
      output_text: 'Claim copied from https://attacker.example.net/unverified',
    }),
  });
  const outcome = await extractor.extract({
    sources: sources(), sourceIds: ['W1'], goal: 'goal', anchors: ['anchor'],
  });
  assert.equal(outcome.text, '');
  assert.deepEqual(outcome.extractedSourceIds, []);
  assert.equal(outcome.errors[0].code, 'BAILIAN_EXTRACTOR_TEXT_URL_NOT_ALLOWED');
});

test('rejects non-HTTPS URLs embedded in extracted text instead of silently dropping them', async () => {
  const extractor = new BailianResponsesExtractor(config(), {
    request: async () => successResponse({
      output_text: 'Untrusted claim from http://attacker.example.net/insecure',
    }),
  });
  const outcome = await extractor.extract({
    sources: sources(), sourceIds: ['W1'], goal: 'goal', anchors: ['anchor'],
  });
  assert.equal(outcome.text, '');
  assert.equal(outcome.errors[0].code, 'BAILIAN_EXTRACTOR_TEXT_URL_NOT_ALLOWED');
});

test('caller cancellation bounds an injected request that ignores AbortSignal', async () => {
  const controller = new AbortController();
  const extractor = new BailianResponsesExtractor(config(), {
    request: async () => new Promise(() => {}),
  });
  const pending = extractor.extract({
    sources: sources(),
    sourceIds: ['W1'],
    goal: 'goal',
    anchors: ['anchor'],
    signal: controller.signal,
  });
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
});
