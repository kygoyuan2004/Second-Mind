import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatModelClient } from '../src/llm-client.mjs';
import {
  AnthropicBenchmarkProxy,
  BENCHMARK_MODEL,
  BudgetLedger,
  assertAllowedUpstream,
  createInstrumentedAnthropicFetch,
  enforceAnthropicBenchmarkBody,
  estimateUsageCostCny,
  startAnthropicBenchmarkProxy,
} from '../scripts/lib/benchmark-runtime.mjs';

const ALLOWED_ORIGIN = 'https://benchmark-upstream.example';
const UPSTREAM_URL = `${ALLOWED_ORIGIN}/v1/messages`;

function successfulSse(answer = 'fixture answer') {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":2,"cache_read_input_tokens":3}}}',
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: answer } })}`,
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n');
}

function chunkedSseResponse(text) {
  const bytes = new TextEncoder().encode(text);
  const cuts = [1, 7, 19, 43, 101, bytes.length - 3, bytes.length];
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      const next = cuts.find((cut) => cut > offset) ?? bytes.length;
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, next));
      offset = next;
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

async function eventually(check, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}

async function startProxy(t, options = {}) {
  const proxy = await startAnthropicBenchmarkProxy({
    upstreamUrl: UPSTREAM_URL,
    allowedUpstreamOrigins: [ALLOWED_ORIGIN],
    upstreamApiKey: 'fixture-real-upstream-key',
    fetch: async () => new Response(successfulSse(), {
      headers: { 'content-type': 'text/event-stream' },
    }),
    ...options,
  });
  t.after(() => proxy.close());
  return proxy;
}

test('request egress fixes the fair model settings and fails closed on an unverified [1M] alias', () => {
  const normalized = enforceAnthropicBenchmarkBody({
    model: BENCHMARK_MODEL,
    messages: [{ role: 'user', content: 'private prompt' }],
    temperature: 0.9,
    max_tokens: 20_000,
    output_config: { effort: 'high', trace: false },
  });
  assert.equal(normalized.model, 'qwen3.8-max');
  assert.equal(normalized.temperature, 0);
  assert.equal(normalized.max_tokens, 3_000);
  assert.equal(normalized.output_config.effort, 'medium');
  assert.equal(normalized.output_config.trace, false);
  assert.equal(normalized.stream, true);

  const aliasBody = {
    model: '[1M]qwen3.8-max',
    messages: [{ role: 'user', content: 'question' }],
    max_tokens: 10,
  };
  assert.throws(() => enforceAnthropicBenchmarkBody(aliasBody), {
    code: 'MODEL_ALIAS_UNVERIFIED',
  });
  assert.equal(enforceAnthropicBenchmarkBody(aliasBody, {
    verifiedModelAliases: { '[1M]qwen3.8-max': 'qwen3.8-max' },
  }).model, 'qwen3.8-max');
  assert.throws(() => enforceAnthropicBenchmarkBody({ ...aliasBody, model: 'another-model' }), {
    code: 'MODEL_MISMATCH',
  });
});

test('request egress strips extra sampling knobs and rejects Web Search tools', () => {
  const locked = enforceAnthropicBenchmarkBody({
    model: BENCHMARK_MODEL,
    messages: [{ role: 'user', content: 'synthetic' }],
    top_p: 0.2,
    top_k: 3,
  });
  assert.equal(Object.hasOwn(locked, 'top_p'), false);
  assert.equal(Object.hasOwn(locked, 'top_k'), false);
  for (const tool of [
    { name: 'web_search', type: 'web_search_20250305' },
    { name: 'WebSearch' },
  ]) {
    assert.throws(() => enforceAnthropicBenchmarkBody({
      model: BENCHMARK_MODEL,
      messages: [{ role: 'user', content: 'synthetic' }],
      tools: [tool],
    }), (error) => error.code === 'WEB_SEARCH_DISABLED');
  }
});

test('BudgetLedger serializes concurrent starts and never releases an unknown-usage attempt', async () => {
  const ledger = new BudgetLedger({
    limits: { soft: 1, hard: 2 },
    pricing: { input: 1_000_000, output: 0, cacheCreation: 1_000_000, cacheRead: 0 },
  });
  const starts = await Promise.allSettled(Array.from({ length: 8 }, () => ledger.reserve({
    inputBytes: 1,
    maxOutputTokens: 1,
  })));
  const accepted = starts.filter((entry) => entry.status === 'fulfilled');
  const rejected = starts.filter((entry) => entry.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 7);
  assert.ok(rejected.every((entry) => entry.reason.code === 'BUDGET_SOFT_LIMIT'));

  await ledger.markUncertain(accepted[0].value);
  assert.deepEqual(await ledger.status(), {
    settledCny: 0,
    activeReservedCny: 0,
    uncertainCny: 1,
    committedCny: 1,
    remainingToSoftCny: 0,
    remainingToHardCny: 1,
    softLimitCny: 1,
    hardLimitCny: 2,
    canStart: false,
    hardExceeded: false,
    openReservations: 1,
  });

  const settlingLedger = new BudgetLedger({
    limits: { soft: 1, hard: 2 },
    pricing: { input: 1_000_000, output: 0, cacheCreation: 1_000_000, cacheRead: 0 },
  });
  const reservation = await settlingLedger.reserve({ inputBytes: 1, maxOutputTokens: 1 });
  await settlingLedger.settle(reservation, {});
  assert.equal((await settlingLedger.status()).canStart, true);
});

test('usage pricing includes input, output, cache creation, and cache read tokens', () => {
  assert.equal(estimateUsageCostCny({
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 2,
    cacheReadTokens: 3,
  }), 0.0003345);
});

test('loopback proxy and migrated instrumented fetch preserve SSE while logging metadata only', async (t) => {
  const privatePrompt = 'PRIVATE-NOTE-CONTENT-DO-NOT-LOG';
  const privateAnswer = 'PRIVATE-ANSWER-CONTENT-DO-NOT-LOG';
  const upstreamSecret = 'fixture-real-upstream-key';
  const callerSecret = 'fixture-caller-key-that-must-be-replaced';
  let captured;
  const proxy = await startProxy(t, {
    upstreamApiKey: upstreamSecret,
    fetch: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      const response = chunkedSseResponse(successfulSse(privateAnswer));
      response.headers.set('x-request-id', 'safe-request-id');
      return response;
    },
  });
  const instrumentedFetch = createInstrumentedAnthropicFetch({
    proxyUrl: proxy.url,
    clientToken: proxy.clientToken,
    anonymousId: 'Q001-migrated-normal',
  });
  const client = new ChatModelClient({
    provider: 'anthropic',
    apiBase: proxy.url,
    apiKey: callerSecret,
    model: BENCHMARK_MODEL,
    timeoutMs: 2_000,
    maxOutputTokens: 9_999,
    temperature: 0.8,
    allowInsecureHttp: false,
  }, { fetch: instrumentedFetch });
  assert.equal(await client.generate([
    { role: 'system', content: 'Use supplied evidence only.' },
    { role: 'user', content: privatePrompt },
  ]), privateAnswer);

  const records = await eventually(() => proxy.records().length === 1 && proxy.records());
  assert.equal(captured.url, UPSTREAM_URL);
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.headers['x-api-key'], upstreamSecret);
  assert.equal(captured.body.model, BENCHMARK_MODEL);
  assert.equal(captured.body.temperature, 0);
  assert.equal(captured.body.max_tokens, 3_000);
  assert.equal(captured.body.output_config.effort, 'medium');
  assert.equal(captured.body.stream, true);
  assert.equal(captured.init.body.includes(callerSecret), false);

  assert.deepEqual(records[0].usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 2,
    cacheReadTokens: 3,
  });
  assert.equal(records[0].anonymousId, 'Q001-migrated-normal');
  assert.equal(records[0].attempt, 1);
  assert.equal(records[0].errorCode, null);
  for (const field of ['ttfbMs', 'firstSseMs', 'firstVisibleTextMs', 'completedMs']) {
    assert.ok(Number.isFinite(records[0].timing[field]));
    assert.ok(records[0].timing[field] >= 0);
  }
  const serializedLogs = JSON.stringify(records);
  for (const forbidden of [privatePrompt, privateAnswer, upstreamSecret, callerSecret]) {
    assert.equal(serializedLogs.includes(forbidden), false);
  }
  const budget = await proxy.ledger.status();
  assert.equal(budget.settledCny, 0.0003345);
  assert.equal(budget.activeReservedCny, 0);
  assert.equal(budget.uncertainCny, 0);
});

test('each upstream retry is independently logged and a no-usage failure stays reserved', async (t) => {
  let calls = 0;
  const proxy = await startProxy(t, {
    maxUpstreamAttempts: 2,
    fetch: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      calls += 1;
      if (calls === 1) throw new TypeError('simulated connection reset');
      return new Response(successfulSse('recovered'), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const fetchThroughProxy = createInstrumentedAnthropicFetch({
    proxyUrl: proxy.url,
    clientToken: proxy.clientToken,
    anonymousId: 'Q002-agent-normal',
  });
  const response = await fetchThroughProxy('https://never-used.example/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: BENCHMARK_MODEL,
      messages: [{ role: 'user', content: 'retry-private-body' }],
      max_tokens: 20,
    }),
  });
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('recovered'));
  const records = await eventually(() => proxy.records().length === 2 && proxy.records());
  assert.deepEqual(records.map((entry) => entry.attempt), [1, 2]);
  assert.equal(records[0].errorCode, 'UPSTREAM_NETWORK_ERROR');
  assert.equal(records[0].usage, null);
  assert.equal(records[1].errorCode, null);
  const budget = await proxy.ledger.status();
  assert.ok(budget.uncertainCny > 0);
  assert.ok(budget.settledCny > 0);
});

test('an SSE stream without final output usage cannot release its reservation', async (t) => {
  const incomplete = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}',
    '',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
    '',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n');
  const proxy = await startProxy(t, {
    fetch: async () => new Response(incomplete, {
      headers: { 'content-type': 'text/event-stream' },
    }),
  });
  await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': proxy.clientToken,
      'x-benchmark-anonymous-id': 'Q003-incomplete',
    },
    body: JSON.stringify({
      model: BENCHMARK_MODEL,
      messages: [{ role: 'user', content: 'private incomplete request' }],
      max_tokens: 30,
    }),
  }).then((response) => response.text()).catch(() => {});
  const records = await eventually(() => proxy.records().length === 1 && proxy.records());
  assert.equal(records[0].errorCode, 'USAGE_INCOMPLETE');
  assert.equal(records[0].usage, null);
  const status = await proxy.ledger.status();
  assert.ok(status.uncertainCny > 0);
  assert.equal(status.settledCny, 0);
});

test('missing, empty, and all-zero mandatory Usage fields stay uncertain', async (t) => {
  const cases = [
    { name: 'empty usage objects', start: {}, delta: {} },
    { name: 'missing input_tokens', start: { cache_read_input_tokens: 2 }, delta: { output_tokens: 3 } },
    { name: 'missing output_tokens', start: { input_tokens: 3 }, delta: { input_tokens: 3 } },
    { name: 'all-zero mandatory usage', start: { input_tokens: 0 }, delta: { output_tokens: 0 } },
  ];
  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async (subtest) => {
      const sse = [
        `data: ${JSON.stringify({
          type: 'message_start',
          message: { usage: fixture.start },
        })}`,
        '',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
        '',
        `data: ${JSON.stringify({ type: 'message_delta', usage: fixture.delta })}`,
        '',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n');
      const proxy = await startProxy(subtest, {
        fetch: async () => new Response(sse, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      });
      await fetch(`${proxy.url}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': proxy.clientToken,
          'x-benchmark-anonymous-id': `Q-usage-${index}`,
        },
        body: JSON.stringify({
          model: BENCHMARK_MODEL,
          messages: [{ role: 'user', content: 'public usage fixture' }],
          max_tokens: 30,
        }),
      }).then((response) => response.text()).catch(() => {});
      const records = await eventually(() => proxy.records().length === 1 && proxy.records());
      assert.equal(records[0].errorCode, 'USAGE_INCOMPLETE');
      assert.equal(records[0].usage, null);
      const status = await proxy.ledger.status();
      assert.equal(status.settledCny, 0);
      assert.ok(status.uncertainCny > 0);
      assert.equal(status.openReservations, 1);
    });
  }
});

test('client completion waits for deferred ledger settlement and telemetry publication', async (t) => {
  let settleStartedResolve;
  let releaseSettlement;
  const settleStarted = new Promise((resolve) => { settleStartedResolve = resolve; });
  const settlementGate = new Promise((resolve) => { releaseSettlement = resolve; });
  class DeferredLedger extends BudgetLedger {
    async settle(reservation, usage) {
      settleStartedResolve();
      await settlementGate;
      return super.settle(reservation, usage);
    }
  }
  const ledger = new DeferredLedger();
  const proxy = await startProxy(t, { ledger });
  const instrumentedFetch = createInstrumentedAnthropicFetch({
    proxyUrl: proxy.url,
    clientToken: proxy.clientToken,
    anonymousId: 'Q-deferred-settle',
  });
  const client = new ChatModelClient({
    provider: 'anthropic',
    apiBase: proxy.url,
    apiKey: 'local-placeholder',
    model: BENCHMARK_MODEL,
    timeoutMs: 2_000,
    maxOutputTokens: 100,
    temperature: 0,
    allowInsecureHttp: true,
  }, { fetch: instrumentedFetch });
  let clientCompleted = false;
  const completion = client.generate([
    { role: 'user', content: 'public deferred settlement fixture' },
  ]).then((answer) => {
    clientCompleted = true;
    return answer;
  });
  await settleStarted;
  await Promise.resolve();
  assert.equal(clientCompleted, false);
  assert.deepEqual(proxy.records(), []);

  releaseSettlement();
  assert.equal(await completion, 'fixture answer');
  assert.equal(clientCompleted, true);
  assert.equal(proxy.records().length, 1);
  assert.equal(proxy.records()[0].errorCode, null);
  assert.ok((await ledger.status()).settledCny > 0);
});

test('proxy close aborts active requests and returns within a bounded timeout', async (t) => {
  let upstreamStartedResolve;
  const upstreamStarted = new Promise((resolve) => { upstreamStartedResolve = resolve; });
  let upstreamSignal;
  const proxy = await startProxy(t, {
    closeTimeoutMs: 30,
    fetch: async (_url, init) => {
      upstreamSignal = init.signal;
      upstreamStartedResolve();
      return new Promise(() => {});
    },
  });
  const pendingRequest = fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': proxy.clientToken,
      'x-benchmark-anonymous-id': 'Q-close-timeout',
    },
    body: JSON.stringify({
      model: BENCHMARK_MODEL,
      messages: [{ role: 'user', content: 'public close fixture' }],
      max_tokens: 30,
    }),
  }).then((response) => response.text()).catch((error) => error);
  await upstreamStarted;
  const startedAt = Date.now();
  await proxy.close();
  const elapsedMs = Date.now() - startedAt;
  assert.equal(upstreamSignal.aborted, true);
  assert.ok(elapsedMs < 500, `close took ${elapsedMs}ms`);
  const requestResult = await Promise.race([
    pendingRequest,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('client connection was not closed')),
      500,
    )),
  ]);
  assert.ok(requestResult instanceof Error || typeof requestResult === 'string');
});

test('redirects are rejected explicitly and upstream fetch is always redirect:error', async (t) => {
  let redirectMode;
  const proxy = await startProxy(t, {
    fetch: async (_url, init) => {
      redirectMode = init.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://not-allowed.example/steal' },
      });
    },
  });
  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': proxy.clientToken },
    body: JSON.stringify({
      model: BENCHMARK_MODEL,
      messages: [{ role: 'user', content: 'must not follow redirect' }],
      max_tokens: 10,
    }),
  });
  assert.equal(response.status, 502);
  assert.equal(redirectMode, 'error');
  const records = await eventually(() => proxy.records().length === 1 && proxy.records());
  assert.equal(records[0].errorCode, 'UPSTREAM_REDIRECT_REJECTED');
});

test('only fixed HTTPS allowlisted upstream origins and loopback listeners are accepted', async (t) => {
  assert.throws(() => assertAllowedUpstream('http://benchmark-upstream.example/v1/messages', [
    ALLOWED_ORIGIN,
  ]), { code: 'UPSTREAM_URL_REJECTED' });
  assert.throws(() => new AnthropicBenchmarkProxy({
    upstreamUrl: 'https://evil.example/v1/messages',
    allowedUpstreamOrigins: [ALLOWED_ORIGIN],
    upstreamApiKey: 'fixture',
  }), { code: 'UPSTREAM_HOST_REJECTED' });
  const proxy = await startProxy(t);
  assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});
