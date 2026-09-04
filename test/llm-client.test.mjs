import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  ChatModelClient,
  assertSafeProviderUrl,
  createPinnedModelFetch,
  llmInternals,
} from '../src/llm-client.mjs';

function baseConfig(overrides = {}) {
  return {
    provider: 'openai-compatible',
    apiBase: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    model: 'local-test-model',
    timeoutMs: 2_000,
    maxOutputTokens: 100,
    temperature: 0,
    allowInsecureHttp: false,
    ...overrides,
  };
}

test('provider HTTP failures are classified for actionable browser guidance', () => {
  const classify = llmInternals.classifyProviderResponseError;
  assert.equal(classify(401, 'invalid api key'), 'LLM_AUTH_FAILED');
  assert.equal(classify(400, 'Authentication Fails'), 'LLM_AUTH_FAILED');
  assert.equal(classify(402, 'Insufficient Balance'), 'LLM_PAYMENT_REQUIRED');
  assert.equal(classify(404, 'missing route'), 'LLM_ENDPOINT_NOT_FOUND');
  assert.equal(classify(400, 'model does not exist'), 'LLM_MODEL_NOT_FOUND');
  assert.equal(classify(400, 'Model Not Exist'), 'LLM_MODEL_NOT_FOUND');
  assert.equal(classify(400, 'unsupported parameter thinking'), 'LLM_REQUEST_INCOMPATIBLE');
  assert.equal(classify(422, 'Invalid Parameters'), 'LLM_REQUEST_INCOMPATIBLE');
  assert.equal(classify(429, 'quota exceeded'), 'LLM_RATE_LIMITED');
  assert.equal(classify(503, 'temporarily unavailable'), 'LLM_PROVIDER_UNAVAILABLE');
});

test('OpenAI-compatible streaming response is emitted incrementally', async () => {
  const calls = [];
  const chunks = [
    'data: {"choices":[{"delta":{"content":"grounded "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const client = new ChatModelClient(baseConfig(), {
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const tokens = [];
  const answer = await client.generate([{ role: 'user', content: 'question' }], {
    onToken: (token) => tokens.push(token),
  });
  assert.equal(answer, 'grounded answer');
  assert.deepEqual(tokens, ['grounded ', 'answer']);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].body.model, 'local-test-model');
});

test('OpenAI streaming exposes cumulative usage and a verified normal finish without content in telemetry', async () => {
  let requestBody;
  const usageEvents = [];
  const progressEvents = [];
  const client = new ChatModelClient(baseConfig(), {
    fetch: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response([
        'data: {"choices":[{"delta":{"content":"measured "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":8,"total_tokens":28,"prompt_tokens_details":{"cached_tokens":6},"completion_tokens_details":{"reasoning_tokens":4}}}\n\n',
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const answer = await client.generate([{ role: 'user', content: 'private prompt' }], {
    includeUsage: true,
    onUsage: async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      usageEvents.push(event);
    },
    onProgress: async (event) => {
      await Promise.resolve();
      progressEvents.push(event);
    },
  });
  assert.equal(answer, 'measured answer');
  assert.deepEqual(requestBody.stream_options, { include_usage: true });
  assert.deepEqual(usageEvents.at(-1), {
    type: 'model_usage',
    phase: 'final',
    protocol: 'openai-chat-completions',
    stopReason: 'stop',
    usageAvailable: true,
    usage: {
      inputTokens: 20,
      outputTokens: 8,
      cacheReadInputTokens: 6,
      cacheCreationInputTokens: null,
      reasoningTokens: 4,
      totalTokens: 28,
    },
    cumulativeUsage: {
      inputTokens: 20,
      outputTokens: 8,
      cacheReadInputTokens: 6,
      cacheCreationInputTokens: null,
      reasoningTokens: 4,
      totalTokens: 28,
    },
  });
  assert.equal(progressEvents.at(-1).stage, 'complete');
  assert.equal(progressEvents.at(-1).outputCharacters, 15);
  assert.equal(JSON.stringify({ usageEvents, progressEvents }).includes('private prompt'), false);
  assert.equal(JSON.stringify({ usageEvents, progressEvents }).includes('measured answer'), false);
});

test('OpenAI streaming rejects a provider length finish instead of returning a partial answer', async () => {
  const tokens = [];
  const progressEvents = [];
  const client = new ChatModelClient(baseConfig(), {
    fetch: async () => new Response([
      'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":11,"completion_tokens":100,"total_tokens":111}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }),
  });
  await assert.rejects(
    () => client.generate([{ role: 'user', content: 'question' }], {
      onToken: (token) => tokens.push(token),
      onProgress: (event) => progressEvents.push(event),
    }),
    (error) => {
      assert.equal(error.code, 'LLM_OUTPUT_TRUNCATED');
      assert.equal(error.stopReason, 'length');
      assert.equal(error.outputCharacters, 14);
      assert.equal(error.retryable, false);
      assert.equal(error.usage.outputTokens, 100);
      assert.equal(JSON.stringify(error).includes('partial answer'), false);
      return true;
    },
  );
  assert.deepEqual(tokens, ['partial answer']);
  assert.equal(progressEvents.at(-1).stage, 'truncated');
  assert.equal(progressEvents.at(-1).truncated, true);
});

test('OpenAI streaming rejects clean EOF without a finish reason', async () => {
  const tokens = [];
  const client = new ChatModelClient(baseConfig(), {
    fetch: async () => new Response(
      'data: {"choices":[{"delta":{"content":"cut off"}}]}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  });
  await assert.rejects(
    () => client.generate([{ role: 'user', content: 'question' }], {
      onToken: (token) => tokens.push(token),
    }),
    (error) => error.code === 'LLM_STREAM_INCOMPLETE' &&
      error.stopReason === null && error.outputCharacters === 7 && error.retryable === false,
  );
  assert.deepEqual(tokens, ['cut off']);
});

test('OpenAI streaming parses a final SSE block that ends exactly at EOF', async () => {
  const client = new ChatModelClient(baseConfig(), {
    fetch: async () => new Response([
      'data: {"choices":[{"delta":{"content":"complete"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.equal(
    await client.generate([{ role: 'user', content: 'question' }]),
    'complete',
  );
});

test('blocked and unsupported stop reasons never become completed answers', async () => {
  for (const [finishReason, code] of [
    ['content_filter', 'LLM_RESPONSE_BLOCKED'],
    ['tool_calls', 'LLM_UNSUPPORTED_STOP_REASON'],
  ]) {
    const client = new ChatModelClient(baseConfig(), {
      fetch: async () => Response.json({
        choices: [{ message: { content: 'partial' }, finish_reason: finishReason }],
      }),
    });
    await assert.rejects(
      () => client.generate([{ role: 'user', content: 'question' }], { stream: false }),
      { code, stopReason: finishReason },
    );
  }
});

test('OpenAI non-streaming normalizes usage and rejects max-token aliases', async () => {
  const usageEvents = [];
  const client = new ChatModelClient(baseConfig(), {
    fetch: async () => Response.json({
      choices: [{ message: { content: 'unfinished' }, finish_reason: 'max_tokens' }],
      usage: {
        input_tokens: 9,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        output_tokens_details: { reasoning_tokens: 1 },
      },
    }),
  });
  await assert.rejects(
    () => client.generate([{ role: 'user', content: 'question' }], {
      stream: false,
      onUsage: (event) => usageEvents.push(event),
    }),
    { code: 'LLM_OUTPUT_TRUNCATED', stopReason: 'max_tokens' },
  );
  assert.deepEqual(usageEvents.at(-1).usage, {
    inputTokens: 9,
    outputTokens: 7,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 2,
    reasoningTokens: 1,
    totalTokens: 16,
  });
});

test('telemetry leaves unavailable usage null and rejects unrecognized provider stop metadata', async () => {
  const progressEvents = [];
  const client = new ChatModelClient(baseConfig(), {
    fetch: async () => Response.json({
      choices: [{
        message: { content: 'ok' },
        finish_reason: 'unsafe reflected prompt content',
      }],
    }),
  });
  await assert.rejects(
    () => client.generate([{ role: 'user', content: 'private value' }], {
      stream: false,
      onProgress: async (event) => progressEvents.push(event),
    }),
    { code: 'LLM_UNSUPPORTED_STOP_REASON', stopReason: 'unknown' },
  );
  assert.deepEqual(progressEvents, [{
    type: 'model_progress',
    stage: 'unsupported',
    protocol: 'openai-chat-completions',
    stopReason: 'unknown',
    truncated: false,
    outputCharacters: 2,
    usageAvailable: false,
    usage: null,
    cumulativeUsage: null,
  }]);
  assert.equal(JSON.stringify(progressEvents).includes('private value'), false);
  assert.equal(JSON.stringify(progressEvents).includes('reflected prompt'), false);
});

test('provider key is sent in a header but never included in request JSON', async () => {
  const secret = 'test-provider-key-value';
  let captured;
  const client = new ChatModelClient(baseConfig({ apiKey: secret }), {
    fetch: async (_url, init) => {
      captured = init;
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  assert.equal(await client.generate([{ role: 'user', content: 'hello' }]), 'ok');
  assert.equal(captured.headers.Authorization, `Bearer ${secret}`);
  assert.equal(captured.body.includes(secret), false);
});

test('plain HTTP is rejected for a remote provider unless explicitly allowed', () => {
  assert.throws(() => assertSafeProviderUrl('http://models.example.com/v1', false), {
    code: 'LLM_INSECURE_ENDPOINT',
  });
  assert.doesNotThrow(() => assertSafeProviderUrl('https://models.example.com/v1', false));
  assert.doesNotThrow(() => assertSafeProviderUrl('http://models.internal:8000/v1', true));
  assert.throws(() => assertSafeProviderUrl('https://user:secret@models.example.com/v1', false), {
    code: 'LLM_INVALID_ENDPOINT',
  });
});

test('provider error messages redact the configured API key', async () => {
  const apiKey = 'fixture-super-secret-provider-key';
  const client = new ChatModelClient(baseConfig({ apiKey }), {
    fetch: async () => Response.json(
      { error: { message: `Rejected credential ${apiKey}` } },
      { status: 401 },
    ),
  });
  await assert.rejects(
    () => client.generate([{ role: 'user', content: 'hello' }]),
    (error) => error.code === 'LLM_AUTH_FAILED' && error.status === 401 &&
      error.message.includes('[redacted]') && !error.message.includes(apiKey),
  );
});

test('timeout remains active while an SSE response body is streaming', async () => {
  const client = new ChatModelClient(baseConfig({ timeoutMs: 20 }), {
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const guard = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      () => client.generate([{ role: 'user', content: 'never-ending stream' }]),
      { code: 'LLM_TIMEOUT' },
    );
  } finally {
    clearTimeout(guard);
  }
});

test('a per-call timeout can shorten but cannot extend the configured timeout ceiling', async () => {
  assert.equal(llmInternals.requestTimeoutMs({}, { timeoutMs: 200 }), 200);
  assert.equal(llmInternals.requestTimeoutMs({ timeoutMs: 25 }, { timeoutMs: 200 }), 25);
  assert.equal(llmInternals.requestTimeoutMs({ timeoutMs: 500 }, { timeoutMs: 200 }), 200);
  assert.throws(
    () => llmInternals.requestTimeoutMs({ timeoutMs: 0 }, { timeoutMs: 200 }),
    { code: 'LLM_INVALID_TIMEOUT' },
  );

  const client = new ChatModelClient(baseConfig({ timeoutMs: 500 }), {
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  });
  const started = Date.now();
  const guard = setTimeout(() => {}, 300);
  try {
    await assert.rejects(
      () => client.generate([{ role: 'user', content: 'short timeout' }], { timeoutMs: 20 }),
      { code: 'LLM_TIMEOUT' },
    );
    assert.ok(Date.now() - started < 250);
  } finally {
    clearTimeout(guard);
  }
});

test('streaming output is bounded independently from provider behavior', async () => {
  const oversized = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(5_000) } }] })}\n\n`;
  const client = new ChatModelClient(baseConfig({ maxOutputTokens: 1 }), {
    fetch: async () => new Response(oversized, { headers: { 'content-type': 'text/event-stream' } }),
  });
  await assert.rejects(
    () => client.generate([{ role: 'user', content: 'too much output' }]),
    { code: 'LLM_OUTPUT_TOO_LARGE' },
  );
});

test('unterminated provider streams are bounded before an SSE event is parsed', async () => {
  const client = new ChatModelClient(baseConfig({ maxOutputTokens: 1 }), {
    fetch: async () => new Response('x'.repeat(100_000), {
      headers: { 'content-type': 'text/event-stream' },
    }),
  });
  await assert.rejects(
    () => client.generate([{ role: 'user', content: 'malformed stream' }]),
    { code: 'LLM_RESPONSE_TOO_LARGE' },
  );
});

test('Anthropic adapter separates system text and parses content block SSE deltas', async () => {
  const calls = [];
  const client = new ChatModelClient(baseConfig({
    provider: 'anthropic',
    apiBase: 'https://api.anthropic.com',
    apiKey: 'fixture-anthropic-key',
    model: 'fixture-anthropic-model',
  }), {
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"grounded "}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ].join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const output = await client.generate([
    { role: 'system', content: 'Use supplied sources only.' },
    { role: 'user', content: 'Question' },
  ]);
  assert.equal(output, 'grounded answer');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'fixture-anthropic-key');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].body.system, 'Use supplied sources only.');
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'Question' }]);
});

test('Anthropic streaming merges message-start and message-delta usage snapshots', async () => {
  const usageEvents = [];
  const progressEvents = [];
  const client = new ChatModelClient(baseConfig({
    protocol: 'anthropic-messages',
    authMode: 'x-api-key',
    requestProfile: 'anthropic-standard',
  }), {
    fetch: async () => new Response([
      'data: {"type":"message_start","message":{"stop_reason":null,"usage":{"input_tokens":30,"output_tokens":0,"cache_creation_input_tokens":4,"cache_read_input_tokens":5}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"complete"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.equal(await client.generate([{ role: 'user', content: 'question' }], {
    onUsage: (event) => usageEvents.push(event),
    onProgress: (event) => progressEvents.push(event),
  }), 'complete');
  assert.deepEqual(usageEvents.at(-1).usage, {
    inputTokens: 30,
    outputTokens: 7,
    cacheReadInputTokens: 5,
    cacheCreationInputTokens: 4,
    reasoningTokens: null,
    totalTokens: 46,
  });
  assert.equal(usageEvents.at(-1).stopReason, 'end_turn');
  assert.equal(progressEvents.at(-1).stage, 'complete');
});

test('Anthropic streaming rejects max_tokens and emits final measured usage', async () => {
  const usageEvents = [];
  const client = new ChatModelClient(baseConfig({
    protocol: 'anthropic-messages',
    authMode: 'x-api-key',
    requestProfile: 'anthropic-standard',
  }), {
    fetch: async () => new Response([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"cut here"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":100}}\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }),
  });
  await assert.rejects(
    () => client.generate([{ role: 'user', content: 'question' }], {
      onUsage: (event) => usageEvents.push(event),
    }),
    (error) => error.code === 'LLM_OUTPUT_TRUNCATED' &&
      error.stopReason === 'max_tokens' && error.usage.totalTokens === 112,
  );
  assert.equal(usageEvents.at(-1).phase, 'final');
  assert.equal(usageEvents.at(-1).usage.outputTokens, 100);
});

test('Anthropic streaming requires both a stop reason and message_stop', async () => {
  const client = new ChatModelClient(baseConfig({
    protocol: 'anthropic-messages',
    authMode: 'x-api-key',
    requestProfile: 'anthropic-standard',
  }), {
    fetch: async () => new Response([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }),
  });
  await assert.rejects(
    () => client.generate([{ role: 'user', content: 'question' }]),
    { code: 'LLM_STREAM_INCOMPLETE', stopReason: 'end_turn' },
  );
});

test('Anthropic non-streaming reports cache usage and a normal stop reason', async () => {
  const progressEvents = [];
  const client = new ChatModelClient(baseConfig({
    protocol: 'anthropic-messages',
    authMode: 'x-api-key',
    requestProfile: 'anthropic-standard',
  }), {
    fetch: async () => Response.json({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 8,
        output_tokens: 2,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 3,
      },
    }),
  });
  assert.equal(await client.generate([{ role: 'user', content: 'question' }], {
    stream: false,
    onProgress: (event) => progressEvents.push(event),
  }), 'ok');
  assert.equal(progressEvents.at(-1).stopReason, 'end_turn');
  assert.equal(progressEvents.at(-1).usage.totalTokens, 14);
  assert.equal(progressEvents.at(-1).usage.cacheReadInputTokens, 3);
});

test('Anthropic API bases that already end in v1 do not duplicate the version segment', async () => {
  let calledUrl = '';
  const client = new ChatModelClient(baseConfig({
    protocol: 'anthropic-messages',
    authMode: 'x-api-key',
    requestProfile: 'anthropic-standard',
    apiBase: 'https://api.anthropic.com/v1',
    apiKey: 'fixture-anthropic-key',
  }), {
    fetch: async (url) => {
      calledUrl = url;
      return Response.json({ content: [{ type: 'text', text: 'ok' }] });
    },
  });
  await client.generate([{ role: 'user', content: 'hello' }], { stream: false });
  assert.equal(calledUrl, 'https://api.anthropic.com/v1/messages');
});

test('Anthropic adapter preserves an explicit model and effort while omitting provider-default temperature', async () => {
  let captured;
  const client = new ChatModelClient(baseConfig({
    provider: 'anthropic',
    apiBase: 'https://dashscope.aliyuncs.com/apps/anthropic',
    apiKey: 'fixture-anthropic-key',
    model: 'qwen3.8-max',
    temperature: null,
    maxOutputTokens: 131_072,
  }), {
    fetch: async (_url, init) => {
      captured = JSON.parse(init.body);
      return Response.json({ content: [{ type: 'text', text: 'ok' }] });
    },
  });

  assert.equal(await client.generate([{ role: 'user', content: 'Question' }], {
    model: 'qwen3.8-max',
    effort: 'xhigh',
    temperature: null,
    maxOutputTokens: 131_072,
  }), 'ok');
  assert.equal(captured.model, 'qwen3.8-max');
  assert.equal(captured.max_tokens, 131_072);
  assert.deepEqual(captured.output_config, { effort: 'xhigh' });
  assert.equal(Object.hasOwn(captured, 'temperature'), false);
});

test('dynamic protocols support explicit bearer and x-api-key authentication without putting secrets in JSON', async () => {
  const calls = [];
  for (const fixture of [
    {
      protocol: 'openai-chat-completions', authMode: 'x-api-key', requestProfile: 'default',
      expectedHeader: 'x-api-key', response: { choices: [{ message: { content: 'ok' } }] },
    },
    {
      protocol: 'anthropic-messages', authMode: 'bearer', requestProfile: 'anthropic-standard',
      expectedHeader: 'Authorization', response: { content: [{ type: 'text', text: 'ok' }] },
    },
  ]) {
    const apiKey = `fixture-${fixture.protocol}-credential`;
    const client = new ChatModelClient(baseConfig({
      provider: undefined,
      protocol: fixture.protocol,
      authMode: fixture.authMode,
      requestProfile: fixture.requestProfile,
      apiBase: 'https://models.example.com/v1',
      apiKey,
    }), {
      fetch: async (url, init) => {
        calls.push({ fixture, url, init, body: JSON.parse(init.body), apiKey });
        return Response.json(fixture.response);
      },
    });
    assert.equal(await client.generate([{ role: 'user', content: 'hello' }], { stream: false }), 'ok');
  }
  assert.equal(calls[0].init.headers['x-api-key'], calls[0].apiKey);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${calls[1].apiKey}`);
  assert.equal(calls[1].init.headers['x-api-key'], undefined);
  for (const call of calls) assert.equal(call.init.body.includes(call.apiKey), false);
});

test('request profiles map effort only to fields declared by that provider profile', async () => {
  const bodies = new Map();
  for (const fixture of [
    ['openai-standard', 'high'],
    ['bailian-openai', 'high'],
    ['deepseek-openai', 'max'],
    ['glm-openai', 'low'],
    ['kimi-openai', 'max'],
    ['default', 'xhigh'],
  ]) {
    const [requestProfile, effort] = fixture;
    const client = new ChatModelClient(baseConfig({
      protocol: 'openai-chat-completions',
      authMode: 'bearer',
      requestProfile,
      apiBase: 'https://models.example.com/v1',
    }), {
      fetch: async (_url, init) => {
        bodies.set(requestProfile, JSON.parse(init.body));
        return Response.json({ choices: [{ message: { content: 'ok' } }] });
      },
    });
    await client.generate([{ role: 'user', content: 'hello' }], { effort, stream: false });
  }
  assert.equal(bodies.get('openai-standard').reasoning_effort, 'high');
  assert.equal(Object.hasOwn(bodies.get('openai-standard'), 'thinking'), false);
  assert.equal(bodies.get('bailian-openai').enable_thinking, true);
  assert.equal(Object.hasOwn(bodies.get('bailian-openai'), 'reasoning_effort'), false);
  assert.deepEqual(bodies.get('deepseek-openai').thinking, { type: 'enabled' });
  assert.equal(bodies.get('deepseek-openai').reasoning_effort, 'max');
  assert.deepEqual(bodies.get('glm-openai').thinking, { type: 'disabled' });
  assert.equal(bodies.get('kimi-openai').reasoning_effort, 'max');
  assert.equal(Object.hasOwn(bodies.get('kimi-openai'), 'temperature'), false);
  assert.equal(Object.hasOwn(bodies.get('default'), 'reasoning_effort'), false);
  assert.equal(Object.hasOwn(bodies.get('default'), 'thinking'), false);
});

test('default effort never emits optional reasoning controls for any request profile', async () => {
  for (const requestProfile of [
    'anthropic-standard', 'openai-standard', 'bailian-openai', 'deepseek-openai', 'glm-openai',
    'kimi-openai',
  ]) {
    const protocol = requestProfile === 'anthropic-standard'
      ? 'anthropic-messages'
      : 'openai-chat-completions';
    let body;
    const client = new ChatModelClient(baseConfig({
      protocol,
      authMode: protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer',
      requestProfile,
      apiBase: 'https://models.example.com/v1',
    }), {
      fetch: async (_url, init) => {
        body = JSON.parse(init.body);
        return protocol === 'anthropic-messages'
          ? Response.json({ content: [{ type: 'text', text: 'ok' }] })
          : Response.json({ choices: [{ message: { content: 'ok' } }] });
      },
    });
    await client.generate([{ role: 'user', content: 'hello' }], {
      effort: 'default', stream: false,
    });
    for (const field of ['thinking', 'reasoning_effort', 'enable_thinking', 'output_config']) {
      assert.equal(Object.hasOwn(body, field), false, `${requestProfile} emitted ${field}`);
    }
  }
});

test('Kimi assistant reasoning is replayed only through the private assistant-message callback', async () => {
  let requestBody;
  let assistantMessage;
  const client = new ChatModelClient(baseConfig({
    protocol: 'openai-chat-completions',
    authMode: 'bearer',
    requestProfile: 'kimi-openai',
    apiBase: 'https://api.moonshot.cn/v1',
  }), {
    fetch: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({
        choices: [{
          message: { content: 'visible answer', reasoning_content: 'private reasoning' },
          finish_reason: 'stop',
        }],
      });
    },
  });

  const result = await client.generate([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'prior answer', reasoning_content: 'prior private reasoning' },
    { role: 'user', content: 'continue' },
  ], {
    stream: false,
    effort: 'high',
    onAssistantMessage: (message) => { assistantMessage = message; },
  });

  assert.equal(result, 'visible answer');
  assert.equal(requestBody.messages[1].reasoning_content, 'prior private reasoning');
  assert.deepEqual(assistantMessage, {
    role: 'assistant', content: 'visible answer', reasoning_content: 'private reasoning',
  });
});

test('assistant reasoning fields are never forwarded to a non-Kimi compatible provider', async () => {
  let requestBody;
  let assistantMessage;
  const client = new ChatModelClient(baseConfig({
    protocol: 'openai-chat-completions',
    authMode: 'bearer',
    requestProfile: 'openai-standard',
  }), {
    fetch: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({
        choices: [{
          message: { content: 'visible answer', reasoning_content: 'untrusted provider field' },
          finish_reason: 'stop',
        }],
      });
    },
  });

  await client.generate([
    { role: 'assistant', content: 'prior answer', reasoning_content: 'must stay private' },
    { role: 'user', content: 'continue' },
  ], {
    stream: false,
    onAssistantMessage: (message) => { assistantMessage = message; },
  });
  assert.equal(Object.hasOwn(requestBody.messages[0], 'reasoning_content'), false);
  assert.deepEqual(assistantMessage, { role: 'assistant', content: 'visible answer' });
});

function fakeRequest(calls, responseFixture = {}) {
  return (target, options, callback) => {
    const request = new EventEmitter();
    request.end = (body) => {
      let pinned;
      options.lookup(target.hostname, { all: false }, (error, address, family) => {
        if (error) throw error;
        pinned = { address, family };
      });
      calls.push({ target: target.href, options, pinned, body: Buffer.from(body).toString('utf8') });
      queueMicrotask(() => {
        const responseBody = Buffer.from(responseFixture.body || '{"choices":[{"message":{"content":"ok"}}]}');
        const response = Readable.from([responseBody]);
        response.statusCode = responseFixture.statusCode || 200;
        response.statusMessage = 'OK';
        response.headers = {
          'content-type': 'application/json',
          'content-length': String(responseBody.byteLength),
          ...(responseFixture.headers || {}),
        };
        callback(response);
      });
    };
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    return request;
  };
}

test('pinned model transport rejects private or mixed DNS and pins public HTTPS without trusting injected Host', async () => {
  for (const answers of [
    [{ address: '10.1.2.3', family: 4 }],
    [{ address: '100.64.0.8', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }],
  ]) {
    const fetchFn = createPinnedModelFetch({ lookup: async () => answers });
    await assert.rejects(
      () => fetchFn('https://models.example.com/v1/chat/completions', {
        method: 'POST', body: '{}',
      }),
      { code: 'LLM_DESTINATION_DENIED' },
    );
  }

  const calls = [];
  const fetchFn = createPinnedModelFetch({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpsRequest: fakeRequest(calls),
  });
  const response = await fetchFn('https://models.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { Host: 'attacker.invalid', Authorization: 'Bearer fixture' },
    body: '{"hello":"world"}',
  });
  assert.equal((await response.json()).choices[0].message.content, 'ok');
  assert.deepEqual(calls[0].pinned, { address: '93.184.216.34', family: 4 });
  assert.equal(calls[0].options.servername, 'models.example.com');
  assert.equal(calls[0].options.agent, false);
  assert.equal(Object.hasOwn(calls[0].options.headers, 'host'), false);
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture');
});

test('pinned model transport denies redirects, IP literals, and non-443 public endpoints', async () => {
  const redirectFetch = createPinnedModelFetch({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpsRequest: fakeRequest([], { statusCode: 302, headers: { location: 'https://elsewhere.example/' } }),
  });
  await assert.rejects(
    () => redirectFetch('https://models.example.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    { code: 'LLM_REDIRECT_DENIED' },
  );
  const fetchFn = createPinnedModelFetch({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  await assert.rejects(
    () => fetchFn('https://93.184.216.34/chat/completions', { method: 'POST', body: '{}' }),
    { code: 'LLM_DESTINATION_DENIED' },
  );
  await assert.rejects(
    () => fetchFn('https://models.example.com:8443/chat/completions', { method: 'POST', body: '{}' }),
    { code: 'LLM_INVALID_ENDPOINT' },
  );
});

test('pinned model transport resolves every request and blocks a rebinding answer before connecting', async () => {
  let resolutions = 0;
  const calls = [];
  const fetchFn = createPinnedModelFetch({
    lookup: async () => {
      resolutions += 1;
      return resolutions === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '192.168.1.8', family: 4 }];
    },
    httpsRequest: fakeRequest(calls),
  });
  const first = await fetchFn('https://models.example.com/chat/completions', {
    method: 'POST', body: '{}',
  });
  await first.text();
  await assert.rejects(
    () => fetchFn('https://models.example.com/chat/completions', { method: 'POST', body: '{}' }),
    { code: 'LLM_DESTINATION_DENIED' },
  );
  assert.equal(resolutions, 2);
  assert.equal(calls.length, 1);
});

test('pinned model transport cancellation interrupts DNS resolution without opening a request', async () => {
  let calls = 0;
  const controller = new AbortController();
  const fetchFn = createPinnedModelFetch({
    lookup: async () => new Promise(() => {}),
    httpsRequest: () => {
      calls += 1;
      throw new Error('must not connect');
    },
  });
  const pending = fetchFn('https://models.example.com/chat/completions', {
    method: 'POST', body: '{}', signal: controller.signal,
  });
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 0);
});
