import assert from 'node:assert/strict';
import test from 'node:test';

import {
  modelConnectionBindingRevision,
  RuntimeChatModelRouter,
  validateAllEnabled,
} from '../src/runtime-chat-model-router.mjs';

const CATALOG_REVISION = 'a'.repeat(64);

function connection(overrides = {}) {
  return {
    id: 'primary',
    label: 'Primary',
    protocol: 'openai-chat-completions',
    apiBase: 'https://models.example.com/v1',
    authMode: 'bearer',
    apiKey: 'fixture-runtime-model-key',
    ...overrides,
  };
}

function model(overrides = {}) {
  return {
    id: 'main',
    displayName: 'Main model',
    connectionId: 'primary',
    actualModel: 'provider-model-v1',
    requestProfile: 'openai-standard',
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    enabled: true,
    available: true,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    version: 2,
    revision: 'runtime-r1',
    modelCatalogRevision: CATALOG_REVISION,
    defaultModelId: 'main',
    connections: [connection()],
    models: [model()],
    ...overrides,
  };
}

function openAiStreamResponse(content = 'OK', finishReason = 'stop') {
  const chunks = [
    {
      id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    },
    {
      id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
  ];
  return new Response(`${chunks.map((entry) => `data: ${JSON.stringify(entry)}`).join('\n\n')}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function anthropicStreamResponse(content = 'OK') {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }],
    ['content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content },
    }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(`${events.map(([event, data]) => (
    `event: ${event}\ndata: ${JSON.stringify(data)}`
  )).join('\n\n')}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('task leases bind an immutable client snapshot and force the configured actual model', async () => {
  const calls = [];
  const runtime = snapshot();
  const registry = {
    async refresh() {},
    runtimeSnapshot: () => runtime,
  };
  const router = new RuntimeChatModelRouter({
    registry,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return openAiStreamResponse('ok');
    },
  });
  const lease = await router.acquireForTask({
    modelId: 'main',
    expectedCatalogRevision: CATALOG_REVISION,
  });
  runtime.connections[0].apiKey = 'rotated-after-task-started';
  runtime.models[0].actualModel = 'provider-model-v2';

  assert.equal(await lease.generate([{ role: 'user', content: 'hello' }], {
    model: 'caller-must-not-override', effort: 'high', stream: false,
  }), 'ok');
  assert.equal(calls[0].body.model, 'provider-model-v1');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer fixture-runtime-model-key');
  assert.equal(lease.actualModel, 'provider-model-v1');
  assert.equal(lease.mapsRequestedEffort, true);
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(Object.isFrozen(lease.model), true);
  assert.equal(Object.isFrozen(lease.client.config), true);
  assert.equal(JSON.stringify(lease).includes('fixture-runtime-model-key'), false);
  assert.equal(JSON.stringify(lease.client).includes('fixture-runtime-model-key'), false);
  assert.throws(() => { lease.model.actualModel = 'mutated'; }, TypeError);
});

test('Pi bindings use the configured instance context window and suppress Kimi temperature', () => {
  const router = new RuntimeChatModelRouter({
    baseConfig: { temperature: 0.65 },
    fetch: async () => assert.fail('Binding inspection must not perform provider I/O.'),
  });
  const genericBinding = router.createLease(snapshot(), 'main').piBinding();
  assert.equal(genericBinding.contextWindow, 1_000_000);
  assert.equal(genericBinding.temperature, 0.65);

  const kimiBinding = router.createLease(snapshot({
    connections: [connection({
      providerId: 'kimi',
      apiBase: 'https://api.moonshot.cn/v1',
    })],
    models: [model({
      actualModel: 'kimi-k3',
      requestProfile: 'kimi-openai',
    })],
  }), 'main').piBinding();
  assert.equal(kimiBinding.contextWindow, 1_000_000);
  assert.equal(kimiBinding.temperature, null);
  assert.equal(kimiBinding.requiresCompleteAssistantReplay, true);
  assert.equal(kimiBinding.assistantReasoningField, 'reasoning_content');

  const overridden = new RuntimeChatModelRouter({
    baseConfig: { contextWindow: 131_072 },
    fetch: async () => assert.fail('Binding inspection must not perform provider I/O.'),
  }).createLease(snapshot(), 'main').piBinding();
  assert.equal(overridden.contextWindow, 131_072);

  const deepseekBinding = router.createLease(snapshot({
    connections: [connection({
      providerId: 'deepseek',
      apiBase: 'https://api.deepseek.com',
    })],
    models: [model({
      actualModel: 'deepseek-reasoner',
      requestProfile: 'deepseek-openai',
    })],
  }), 'main').piBinding();
  assert.equal(deepseekBinding.requiresCompleteAssistantReplay, true);
  assert.equal(deepseekBinding.assistantReasoningField, 'reasoning_content');
});

test('model binding revision excludes credentials but changes with transport or model identity', () => {
  const first = connection({ apiKey: 'fixture-key-one' });
  const rotated = connection({ apiKey: 'fixture-key-two' });
  const changedBase = connection({ apiKey: 'fixture-key-one', apiBase: 'https://other.example.com/v1' });
  const changedProvider = connection({ apiKey: 'fixture-key-one', providerId: 'deepseek' });
  assert.equal(modelConnectionBindingRevision(first, model()), modelConnectionBindingRevision(rotated, model()));
  assert.notEqual(modelConnectionBindingRevision(first, model()), modelConnectionBindingRevision(changedBase, model()));
  assert.notEqual(modelConnectionBindingRevision(first, model()), modelConnectionBindingRevision(changedProvider, model()));
  assert.notEqual(
    modelConnectionBindingRevision(first, model()),
    modelConnectionBindingRevision(first, model({ actualModel: 'provider-model-v2' })),
  );
});

test('DeepSeek task leases repair only the provider-scoped exact legacy model alias', async () => {
  const bodies = [];
  const router = new RuntimeChatModelRouter({
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return openAiStreamResponse('ok');
    },
  });
  const deepseekConnection = connection({
    providerId: 'deepseek',
    apiBase: 'https://api.deepseek.com',
  });
  const legacyModel = model({
    actualModel: 'deepseek-v4-pro-0813',
    requestProfile: 'deepseek-openai',
  });
  const deepseekLease = router.createLease(snapshot({
    connections: [deepseekConnection],
    models: [legacyModel],
  }), 'main');
  assert.equal(deepseekLease.actualModel, 'deepseek-v4-pro');
  await deepseekLease.generate([{ role: 'user', content: 'fixture' }], {
    effort: 'high', stream: false,
  });
  assert.equal(bodies[0].model, 'deepseek-v4-pro');
  assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
  assert.equal(bodies[0].reasoning_effort, 'high');

  const officialModel = model({
    actualModel: 'deepseek-v4-pro',
    requestProfile: 'deepseek-openai',
  });
  assert.equal(
    modelConnectionBindingRevision(deepseekConnection, legacyModel),
    modelConnectionBindingRevision(deepseekConnection, officialModel),
  );
  const customLease = router.createLease(snapshot({
    connections: [connection({ providerId: 'custom' })],
    models: [legacyModel],
  }), 'main');
  assert.equal(customLease.actualModel, 'deepseek-v4-pro-0813');
});

test('task leases retain universal tiers while sending only mapped provider controls', async () => {
  const bodies = [];
  const router = new RuntimeChatModelRouter({
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return openAiStreamResponse('ok');
    },
  });
  const deepseekLease = router.createLease(snapshot({
    connections: [connection({
      providerId: 'deepseek', apiBase: 'https://api.deepseek.com',
    })],
    models: [model({
      actualModel: 'deepseek-v4-pro', requestProfile: 'deepseek-openai',
      efforts: ['low', 'high', 'max'], defaultEffort: 'high',
    })],
  }), 'main');
  assert.deepEqual(deepseekLease.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(deepseekLease.effortMapping.medium, 'high');
  await deepseekLease.generate([{ role: 'user', content: 'fixture' }], {
    effort: 'medium', stream: false,
  });
  assert.equal(bodies[0].reasoning_effort, 'high');

  const kimiLease = router.createLease(snapshot({
    connections: [connection({
      providerId: 'kimi', apiBase: 'https://api.moonshot.cn/v1',
    })],
    models: [model({
      actualModel: 'kimi-k3', requestProfile: 'kimi-openai',
      efforts: ['low', 'high', 'max'], defaultEffort: 'max',
    })],
  }), 'main');
  assert.equal(kimiLease.defaultEffort, 'max');
  assert.deepEqual(kimiLease.effortMapping, {
    low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max',
  });
  await kimiLease.generate([{ role: 'user', content: 'fixture' }], {
    effort: 'max', stream: false,
  });
  assert.equal(bodies[1].reasoning_effort, 'max');
  assert.equal(Object.hasOwn(bodies[1], 'temperature'), false);

  const manualKimiLease = router.createLease(snapshot({
    connections: [connection({
      providerId: 'kimi', apiBase: 'https://api.moonshot.cn/v1',
    })],
    models: [model({
      actualModel: 'kimi-k3', requestProfile: 'kimi-openai',
      efforts: ['low', 'high', 'max'], defaultEffort: 'max',
      reasoningMapping: {
        mode: 'manual',
        tiers: { low: 'max', medium: 'low', high: 'high', xhigh: 'max', max: 'max' },
      },
    })],
  }), 'main');
  assert.equal(manualKimiLease.effortMapping.medium, 'low');
  assert.equal(manualKimiLease.effortMapping.low, 'max');
  await manualKimiLease.generate([{ role: 'user', content: 'fixture' }], {
    effort: 'medium', stream: false,
  });
  assert.equal(bodies[2].reasoning_effort, 'low',
    'a semantic tier must be projected exactly once');

  const unknownKimiLease = router.createLease(snapshot({
    connections: [connection({
      providerId: 'kimi', apiBase: 'https://api.moonshot.cn/v1',
    })],
    models: [model({
      actualModel: 'moonshot-v1', requestProfile: 'kimi-openai',
      efforts: ['default'], defaultEffort: 'default',
    })],
  }), 'main');
  await unknownKimiLease.generate([{ role: 'user', content: 'fixture' }], {
    effort: 'max', stream: false,
  });
  assert.equal(Object.hasOwn(bodies[3], 'reasoning_effort'), false);
});

test('formal generations clamp output tokens to the selected provider and model safety limit', async () => {
  const bodies = [];
  const router = new RuntimeChatModelRouter({
    baseConfig: { maxOutputTokens: 131_072 },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return openAiStreamResponse('ok');
    },
  });
  const lease = router.createLease(snapshot(), 'main');
  assert.equal(lease.maxOutputTokens, 4_096);
  await lease.generate([{ role: 'user', content: 'hello' }], {
    maxOutputTokens: 131_072,
    effort: 'high',
    stream: false,
  });
  assert.equal(bodies[0].max_tokens, 4_096);

  const qwenSnapshot = snapshot({
    connections: [connection({
      providerId: 'bailian', protocol: 'anthropic-messages', authMode: 'x-api-key',
      apiBase: 'https://dashscope.aliyuncs.com/apps/anthropic',
    })],
    models: [model({
      actualModel: 'qwen3.8-max-0902', requestProfile: 'anthropic-standard',
    })],
  });
  const qwenLease = router.createLease(qwenSnapshot, 'main');
  assert.equal(qwenLease.maxOutputTokens, 131_072);
});

test('a stale model catalog revision is rejected before a provider call', async () => {
  let calls = 0;
  const router = new RuntimeChatModelRouter({
    registry: { async refresh() {}, runtimeSnapshot: () => snapshot() },
    fetch: async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: 'unexpected' } }] });
    },
  });
  await assert.rejects(
    () => router.acquireForTask({ modelId: 'main', expectedCatalogRevision: 'b'.repeat(64) }),
    { code: 'MODEL_CATALOG_CHANGED', status: 409 },
  );
  assert.equal(calls, 0);
});

test('production validation performs one Pi generation with no Agent or tool capability path', async () => {
  const calls = [];
  const router = new RuntimeChatModelRouter({
    fetch: async () => assert.fail('The injected one-shot Pi executor owns provider I/O'),
    async piGenerate(modelBinding, messages, options) {
      calls.push({ modelBinding, messages, options });
      options.onToken?.('OK');
      return 'OK';
    },
  });

  const result = await router.validateAllEnabled(snapshot());
  assert.equal(result.results[0].code, 'PI_GENERATION_VERIFIED');
  assert.equal(result.results[0].capability, 'pi-single-generation');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].modelBinding.actualModel, 'provider-model-v1');
  assert.equal(typeof calls[0].modelBinding.fetch, 'function');
  assert.equal(Object.keys(calls[0].modelBinding).includes('apiKey'), false);
  assert.deepEqual(calls[0].messages, [
    { role: 'system', content: 'Connectivity check. Return a short response.' },
    { role: 'user', content: 'Reply with OK.' },
  ]);
  assert.equal(calls[0].options.maxOutputTokens, 64);
});

test('validation tests every enabled model once with fixed non-private input and concurrency at most two', async () => {
  const runtime = snapshot({
    connections: [
      connection({ id: 'openai' }),
      connection({
        id: 'anthropic', protocol: 'anthropic-messages', authMode: 'x-api-key',
        apiBase: 'https://anthropic.example.com', apiKey: 'fixture-anthropic-key',
      }),
    ],
    models: [
      model({ id: 'one', connectionId: 'openai', actualModel: 'model-one' }),
      model({
        id: 'two', connectionId: 'anthropic', actualModel: 'model-two',
        requestProfile: 'anthropic-standard',
      }),
      model({ id: 'three', connectionId: 'openai', actualModel: 'model-three' }),
      model({ id: 'off', connectionId: 'openai', actualModel: 'model-off', enabled: false }),
    ],
  });
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  const result = await validateAllEnabled(runtime, {
    toolProbe: null,
    fetch: async (url, init) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return url.endsWith('/v1/messages')
        ? anthropicStreamResponse('OK')
        : openAiStreamResponse('OK');
    },
    concurrency: 99,
  });
  assert.equal(result.checked, 3);
  assert.equal(calls.length, 3);
  assert.equal(maximumActive, 2);
  assert.deepEqual(calls.map((entry) => entry.body.model).sort(), ['model-one', 'model-three', 'model-two']);
  for (const call of calls) {
    assert.equal(call.body.stream, true);
    assert.equal(call.body.max_tokens, 64);
    assert.equal(Object.hasOwn(call.body, 'thinking'), false);
    assert.equal(Object.hasOwn(call.body, 'reasoning_effort'), false);
    assert.equal(Object.hasOwn(call.body, 'enable_thinking'), false);
    assert.equal(Object.hasOwn(call.body, 'output_config'), false);
    assert.equal(JSON.stringify(call.body).includes('Reply with OK.'), true);
  }
});

test('connection probe accepts non-empty token-limited output without retrying', async () => {
  for (const stopReason of ['length', 'max_tokens']) {
    let calls = 0;
    let requestBody;
    const router = new RuntimeChatModelRouter({
      toolProbe: null,
      fetch: async (_url, init) => {
        calls += 1;
        requestBody = JSON.parse(init.body);
        return openAiStreamResponse('OK, connectivity confirmed.', stopReason);
      },
    });

    const result = await router.validateAllEnabled(snapshot());

    assert.equal(result.ok, true);
    assert.equal(result.checked, 1);
    assert.equal(calls, 1, `the ${stopReason} probe must not be retried`);
    assert.equal(requestBody.stream, true);
    assert.equal(requestBody.max_tokens, 64);
    assert.deepEqual(requestBody.messages, [
      { role: 'system', content: 'Connectivity check. Return a short response.' },
      { role: 'user', content: 'Reply with OK.' },
    ]);
  }
});

test('connection probe accepts a structurally valid token-limited response when reasoning uses the visible-output budget', async () => {
  let calls = 0;
  const router = new RuntimeChatModelRouter({
    toolProbe: null,
    fetch: async () => {
      calls += 1;
      return openAiStreamResponse('   ', 'length');
    },
  });

  const result = await router.validateAllEnabled(snapshot());

  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test('connection probe still rejects a completed response with no usable output', async () => {
  let calls = 0;
  const router = new RuntimeChatModelRouter({
    toolProbe: null,
    fetch: async () => {
      calls += 1;
      return openAiStreamResponse('   ', 'stop');
    },
  });

  await assert.rejects(
    () => router.validateAllEnabled(snapshot()),
    (error) => {
      assert.equal(error.code, 'LLM_VALIDATION_FAILED');
      assert.equal(error.results[0].code, 'LLM_EMPTY_RESPONSE');
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('ordinary task generation still rejects the same non-empty token-limited response', async () => {
  let calls = 0;
  const router = new RuntimeChatModelRouter({
    fetch: async () => {
      calls += 1;
      return openAiStreamResponse('partial answer', 'length');
    },
  });
  const lease = router.createLease(snapshot(), 'main');

  await assert.rejects(
    () => lease.generate([{ role: 'user', content: 'normal task' }], { stream: false }),
    { code: 'LLM_OUTPUT_TRUNCATED' },
  );
  assert.equal(calls, 1);
});

test('DeepSeek validation uses the canonical model, 64 tokens, and no thinking controls', async () => {
  let body;
  const runtime = snapshot({
    connections: [connection({
      providerId: 'deepseek', apiBase: 'https://api.deepseek.com',
    })],
    models: [model({
      actualModel: 'deepseek-v4-pro-0813',
      requestProfile: 'deepseek-openai',
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    })],
  });
  const result = await validateAllEnabled(runtime, {
    toolProbe: null,
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return openAiStreamResponse('OK');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.equal(body.max_tokens, 64);
  assert.equal(Object.hasOwn(body, 'thinking'), false);
  assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
});

test('validation returns actionable redacted DeepSeek billing, model, and auth failures', async () => {
  const secret = 'fixture-deepseek-secret-value';
  for (const fixture of [
    [402, 'Insufficient Balance', 'LLM_PAYMENT_REQUIRED', 'insufficient balance'],
    [400, 'Model Not Exist', 'LLM_MODEL_NOT_FOUND', 'model ID'],
    [401, `Authentication Fails: api_key=${secret}`, 'LLM_AUTH_FAILED', 'API Key'],
  ]) {
    const [status, providerMessage, expectedCode, expectedText] = fixture;
    const runtime = snapshot({
      connections: [connection({
        providerId: 'deepseek', apiBase: 'https://api.deepseek.com', apiKey: secret,
      })],
      models: [model({ requestProfile: 'deepseek-openai' })],
    });
    await assert.rejects(
      () => validateAllEnabled(runtime, {
        toolProbe: null,
        fetch: async () => Response.json(
          { error: { message: providerMessage } },
          { status },
        ),
      }),
      (error) => {
        const failure = error.results[0];
        assert.equal(failure.code, expectedCode);
        assert.match(failure.message, new RegExp(expectedText, 'iu'));
        assert.equal(failure.message.includes(secret), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      },
    );
  }
});

test('validation reports all attempted models, never retries, and redacts credentials', async () => {
  const secret = 'fixture-secret-must-not-leak';
  const runtime = snapshot({
    connections: [connection({ apiKey: secret })],
    models: [
      model({ id: 'good', actualModel: 'model-good' }),
      model({ id: 'bad', actualModel: 'model-bad' }),
    ],
  });
  const counts = new Map();
  const router = new RuntimeChatModelRouter({
    toolProbe: null,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      counts.set(body.model, (counts.get(body.model) || 0) + 1);
      return body.model === 'model-bad'
        ? Response.json({ error: { message: `rejected ${secret}` } }, { status: 401 })
        : openAiStreamResponse('OK');
    },
  });
  await assert.rejects(
    () => router.validateAllEnabled(runtime),
    (error) => {
      assert.equal(error.code, 'LLM_VALIDATION_FAILED');
      assert.equal(error.results.length, 2);
      const failed = error.results.find((entry) => entry.modelId === 'bad');
      assert.equal(failed.ok, false);
      assert.match(failed.message, /API Key/i);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
  assert.deepEqual(Object.fromEntries(counts), { 'model-good': 1, 'model-bad': 1 });
});

test('provider-scoped validation tests only the explicitly selected enabled models', async () => {
  const calls = [];
  const runtime = snapshot({
    models: [
      model({ id: 'selected', actualModel: 'selected-model' }),
      model({ id: 'other', actualModel: 'other-model' }),
    ],
  });
  const router = new RuntimeChatModelRouter({
    async piGenerate(binding, _messages, options) {
      calls.push(binding.actualModel);
      options.onToken?.('OK');
      return 'OK';
    },
  });
  const result = await router.validateAllEnabled(runtime, { modelIds: ['selected'] });
  assert.deepEqual(calls, ['selected-model']);
  assert.deepEqual(result.results.map((entry) => entry.modelId), ['selected']);
  await assert.rejects(
    () => router.validateAllEnabled(runtime, { modelIds: ['missing'] }),
    { code: 'MODEL_VALIDATION_TARGET_EMPTY', status: 400 },
  );
});

test('missing credentials fail validation without making any network request', async () => {
  let calls = 0;
  const runtime = snapshot({ connections: [connection({ apiKey: '' })] });
  const router = new RuntimeChatModelRouter({
    fetch: async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: 'unexpected' } }] });
    },
  });
  await assert.rejects(
    () => router.validateSnapshot(runtime),
    (error) => error.code === 'LLM_VALIDATION_FAILED' &&
      error.results[0].code === 'MODEL_CONNECTION_INCOMPLETE',
  );
  assert.equal(calls, 0);
});
