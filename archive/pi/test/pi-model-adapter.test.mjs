import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFauxCore,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai';

import {
  PiModelAdapterError,
  PiToolProbeError,
  createPiModelAdapter,
  probePiToolCalling,
} from '../src/pi-model-adapter.mjs';

function modelBinding(overrides = {}) {
  return {
    protocol: 'openai-chat-completions',
    providerId: 'custom-provider',
    requestProfile: 'default',
    apiBase: 'https://models.example/v1',
    apiKey: 'configured-secret',
    authMode: 'bearer',
    actualModel: 'example-model',
    maxOutputTokens: 8_192,
    contextWindow: 64_000,
    temperature: 0.35,
    ...overrides,
  };
}

function userContext(text = 'hello') {
  return {
    messages: [{ role: 'user', content: text, timestamp: Date.now() }],
  };
}

function openAiStream(text = 'OK') {
  return [
    `data: ${JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'example-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })}`,
    `data: ${JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'example-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
}

function anthropicStream(text = 'OK') {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fixture', type: 'message', role: 'assistant', model: 'example-model',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }],
    ['content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
    }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return `${events.map(([event, data]) => (
    `event: ${event}\ndata: ${JSON.stringify(data)}`
  )).join('\n\n')}\n\n`;
}

async function capturePublishedRequest(overrides = {}, completeOptions = {}, context = userContext()) {
  let request;
  const binding = modelBinding(overrides);
  const adapter = await createPiModelAdapter(binding, {
    fetch: async (url, init) => {
      request = { url, init };
      return new Response(
        binding.protocol === 'anthropic-messages' ? anthropicStream() : openAiStream(),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const response = await adapter.modelRuntime.completeSimple(
    adapter.model,
    context,
    completeOptions,
  );
  return {
    adapter,
    request,
    payload: JSON.parse(String(request.init.body)),
    response,
  };
}

function capturingStreams(api, capture) {
  const faux = createFauxCore({
    api,
    provider: 'adapter-test',
    models: [{ id: 'example-model' }],
  });
  faux.setResponses([fauxAssistantMessage('ok')]);
  return {
    stream: faux.stream,
    streamSimple(model, context, options) {
      capture.options = options;
      return faux.streamSimple(model, context, options);
    },
  };
}

test('Claude 1M context selector is not sent as a Bailian model ID', async () => {
  for (const actualModel of ['qwen3.8-max[1M]', 'kimi-k3[1M]']) {
    const { adapter, payload } = await capturePublishedRequest({
      protocol: 'anthropic-messages', providerId: 'bailian',
      requestProfile: 'anthropic-standard', actualModel, contextWindow: 1_000_000,
    }, { reasoning: 'xhigh', maxTokens: 8_192 });
    assert.equal(payload.model, actualModel.replace('[1M]', ''));
    assert.equal(adapter.model.contextWindow, 1_000_000);
    assert.equal(adapter.model.id, actualModel);
    assert.equal(payload.output_config.effort, 'xhigh');
  }
  const custom = await capturePublishedRequest({ actualModel: 'custom[1M]' });
  assert.equal(custom.payload.model, 'custom[1M]');
});

test('maps Anthropic bindings and injects only the configured x-api-key into pinned fetch', async () => {
  const capture = {};
  const requests = [];
  const pinnedFetch = async (url, init) => {
    requests.push({ url, init });
    return new Response('{}', { status: 200 });
  };
  const adapter = await createPiModelAdapter(modelBinding({
    protocol: 'anthropic-messages',
    requestProfile: 'anthropic-standard',
    authMode: 'x-api-key',
  }), {
    fetch: pinnedFetch,
    timeoutMs: 5_000,
    streamFactory: (api) => capturingStreams(api, capture),
  });

  await adapter.modelRuntime.completeSimple(adapter.model, userContext());
  assert.equal(adapter.model.api, 'anthropic-messages');
  assert.equal(adapter.model.baseUrl, 'https://models.example');
  assert.equal(adapter.model.contextWindow, 64_000);
  assert.equal(adapter.model.maxTokens, 8_192);
  assert.equal(adapter.thinkingLevelFor('high'), 'high');
  assert.equal(capture.options.apiKey, 'second-mind-keyless-transport');
  assert.equal(capture.options.cacheRetention, 'none');
  assert.equal(capture.options.temperature, 0.35);
  assert.equal(capture.options.fetch === pinnedFetch, false);

  await capture.options.fetch('https://models.example/v1/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer sdk-default',
      'x-api-key': 'sdk-default',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://models.example/v1/messages');
  assert.equal(new Headers(requests[0].init.headers).get('x-api-key'), 'configured-secret');
  assert.equal(new Headers(requests[0].init.headers).has('authorization'), false);
  assert.equal(requests[0].init.signal instanceof AbortSignal, true);

  const resolvedAuth = await adapter.modelRuntime.getAuth(adapter.model);
  assert.equal(resolvedAuth.auth.apiKey, 'second-mind-keyless-transport');
});

test('missing binding metadata uses the original one-million-token context default', async () => {
  const adapter = await createPiModelAdapter(modelBinding({ contextWindow: undefined }), {
    fetch: async () => new Response('{}', { status: 200 }),
    timeoutMs: 5_000,
  });

  assert.equal(adapter.model.contextWindow, 1_000_000);
});

test('maps OpenAI-compatible profiles to conservative Pi compatibility flags', async () => {
  const adapter = await createPiModelAdapter(modelBinding({
    requestProfile: 'kimi-openai',
    requiresCompleteAssistantReplay: true,
    assistantReasoningField: 'reasoning_content',
  }), {
    fetch: async () => new Response('{}'),
    streamFactory: (api) => capturingStreams(api, {}),
  });

  assert.equal(adapter.model.api, 'openai-completions');
  assert.equal(adapter.model.compat.supportsStore, false);
  assert.equal(adapter.model.compat.supportsDeveloperRole, false);
  assert.equal(adapter.model.compat.supportsUsageInStreaming, false);
  assert.equal(adapter.model.compat.supportsStrictMode, false);
  assert.equal(adapter.model.compat.thinkingFormat, 'deepseek');
  assert.equal(adapter.model.compat.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(adapter.thinkingLevelFor('xhigh'), 'xhigh');
  assert.equal(adapter.thinkingLevelFor('default'), 'off');
});

test('preserves the configured 128-token application output ceiling', async () => {
  const adapter = await createPiModelAdapter(modelBinding({ maxOutputTokens: 128 }), {
    fetch: async () => new Response('{}'),
    streamFactory: (api) => capturingStreams(api, {}),
  });

  assert.equal(adapter.model.maxTokens, 128);
});

test('custom default profile does not claim reasoning and bearer auth is authoritative', async () => {
  const capture = {};
  let request;
  const adapter = await createPiModelAdapter(modelBinding(), {
    fetch: async (url, init) => {
      request = { url, init };
      return new Response('{}');
    },
    streamFactory: (api) => capturingStreams(api, capture),
  });
  await adapter.modelRuntime.completeSimple(adapter.model, userContext());
  assert.equal(adapter.model.reasoning, false);
  assert.equal(adapter.thinkingLevelFor('high'), 'off');

  await capture.options.fetch('https://models.example/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-api-key': 'sdk-default' },
    body: '{}',
  });
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer configured-secret');
  assert.equal(headers.has('x-api-key'), false);
});

test('keyless mode removes provider SDK credentials before pinned transport', async () => {
  const capture = {};
  let request;
  const adapter = await createPiModelAdapter(modelBinding({
    authMode: 'none',
    apiKey: '',
  }), {
    fetch: async (url, init) => {
      request = { url, init };
      return new Response('{}');
    },
    streamFactory: (api) => capturingStreams(api, capture),
  });
  await adapter.modelRuntime.completeSimple(adapter.model, userContext());
  await capture.options.fetch('https://models.example/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer placeholder',
      'x-api-key': 'placeholder',
    },
    body: '{}',
  });
  const headers = new Headers(request.init.headers);
  assert.equal(headers.has('authorization'), false);
  assert.equal(headers.has('x-api-key'), false);
});

test('the published Pi OpenAI adapter performs its HTTP call through pinned fetch', async () => {
  let request;
  const adapter = await createPiModelAdapter(modelBinding(), {
    fetch: async (url, init) => {
      request = { url, init };
      const events = [
        'data: {"id":"probe","object":"chat.completion.chunk","created":1,"model":"example-model","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
        'data: {"id":"probe","object":"chat.completion.chunk","created":1,"model":"example-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(events, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const response = await adapter.modelRuntime.completeSimple(adapter.model, userContext());

  assert.equal(request.url, 'https://models.example/v1/chat/completions');
  assert.equal(new Headers(request.init.headers).get('authorization'), 'Bearer configured-secret');
  assert.equal(response.content.map((part) => part.text || '').join(''), 'OK');
  const payload = JSON.parse(String(request.init.body));
  assert.equal(payload.model, 'example-model');
  assert.equal(payload.stream, true);
});

test('published Pi provider bodies preserve every managed reasoning-profile contract', async () => {
  const fixtures = [
    {
      profile: 'default', reasoning: 'max', expected: {},
    },
    {
      profile: 'openai-standard', reasoning: 'xhigh',
      expected: { reasoning_effort: 'xhigh' },
    },
    {
      profile: 'bailian-openai', reasoning: 'low',
      expected: { enable_thinking: false },
    },
    {
      profile: 'deepseek-openai', reasoning: 'max',
      expected: { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    },
    {
      profile: 'glm-openai', reasoning: 'low',
      expected: { thinking: { type: 'disabled' } },
    },
    {
      profile: 'kimi-openai', reasoning: 'max',
      expected: { reasoning_effort: 'max' },
    },
  ];
  const reasoningFields = ['thinking', 'reasoning_effort', 'enable_thinking', 'output_config'];
  for (const fixture of fixtures) {
    const captured = await capturePublishedRequest({
      requestProfile: fixture.profile,
      providerId: fixture.profile.split('-')[0],
      requiresCompleteAssistantReplay: ['deepseek-openai', 'kimi-openai']
        .includes(fixture.profile),
    }, { reasoning: fixture.reasoning });
    const actual = Object.fromEntries(reasoningFields
      .filter((field) => Object.hasOwn(captured.payload, field))
      .map((field) => [field, captured.payload[field]]));
    assert.deepEqual(actual, fixture.expected, fixture.profile);
    assert.equal(JSON.stringify(captured.payload).includes('cache_control'), false, fixture.profile);
    assert.equal(Object.hasOwn(captured.payload, 'prompt_cache_key'), false, fixture.profile);
    assert.equal(Object.hasOwn(captured.payload, 'prompt_cache_retention'), false, fixture.profile);
    if (fixture.profile === 'kimi-openai') {
      assert.equal(Object.hasOwn(captured.payload, 'temperature'), false);
    }
  }
});

test('published Pi Anthropic body keeps xhigh effort without cache or OAuth-key heuristics', async () => {
  const oauthLikeKey = ['prefix', 'sk', 'ant', 'oat', 'explicit', 'bearer', 'fixture'].join('-');
  const captured = await capturePublishedRequest({
    protocol: 'anthropic-messages',
    providerId: 'bailian',
    requestProfile: 'anthropic-standard',
    authMode: 'bearer',
    apiKey: oauthLikeKey,
  }, { reasoning: 'xhigh' }, {
    systemPrompt: 'Expected system prompt.',
    messages: userContext().messages,
  });

  assert.equal(captured.response.content.map((part) => part.text || '').join(''), 'OK');
  assert.deepEqual(captured.payload.output_config, { effort: 'xhigh' });
  assert.equal(Object.hasOwn(captured.payload, 'thinking'), false);
  assert.equal(JSON.stringify(captured.payload).includes('cache_control'), false);
  assert.equal(JSON.stringify(captured.payload).includes('Claude Code'), false);
  assert.deepEqual(captured.payload.system, [{ type: 'text', text: 'Expected system prompt.' }]);
  const headers = new Headers(captured.request.init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${oauthLikeKey}`);
  assert.equal(headers.has('x-api-key'), false);
  assert.equal(headers.has('anthropic-beta'), false);
  assert.equal(headers.has('x-app'), false);
});

test('the published Pi Kimi adapter never sends temperature from binding or request options', async () => {
  let request;
  const adapter = await createPiModelAdapter(modelBinding({
    providerId: 'kimi',
    requestProfile: 'kimi-openai',
    temperature: 0.35,
  }), {
    fetch: async (url, init) => {
      request = { url, init };
      const events = [
        'data: {"id":"kimi","object":"chat.completion.chunk","created":1,"model":"example-model","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
        'data: {"id":"kimi","object":"chat.completion.chunk","created":1,"model":"example-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(events, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  await adapter.modelRuntime.completeSimple(adapter.model, userContext(), { temperature: 1.2 });
  const payload = JSON.parse(String(request.init.body));
  assert.equal(request.url, 'https://models.example/v1/chat/completions');
  assert.equal(Object.hasOwn(payload, 'temperature'), false);
});

test('rejects unsupported protocols and missing pinned transports with stable codes', async () => {
  await assert.rejects(
    createPiModelAdapter(modelBinding({ protocol: 'text-only' }), { fetch: async () => {} }),
    (error) => error instanceof PiModelAdapterError && error.code === 'PI_MODEL_PROTOCOL_UNSUPPORTED',
  );
  await assert.rejects(
    createPiModelAdapter(modelBinding()),
    (error) => error instanceof PiModelAdapterError && error.code === 'PI_MODEL_PINNED_FETCH_REQUIRED',
  );
});

test('legacy Pi tool probes are fail-closed and cannot start an Agent loop', async () => {
  await assert.rejects(
    probePiToolCalling(modelBinding()),
    (error) => error instanceof PiToolProbeError && error.code === 'PI_TOOL_PROBE_DISABLED',
  );
});
