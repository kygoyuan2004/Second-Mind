import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatModelClient, assertSafeProviderUrl } from '../src/llm-client.mjs';

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

test('OpenAI-compatible streaming response is emitted incrementally', async () => {
  const calls = [];
  const chunks = [
    'data: {"choices":[{"delta":{"content":"grounded "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
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
    (error) => error.code === 'LLM_API_ERROR' &&
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
