import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProviderRequestPolicy,
  legacyV2ProviderFields,
  listModelProviders,
  modelProviderRegistryInternals,
  normalizeProviderModelId,
  providerAuthHeaders,
  providerModelOutputLimit,
  providerModelReasoningPolicy,
  providerUniversalReasoningPolicy,
  providerOutputFields,
  providerReasoningFields,
  resolveModelReasoningPolicy,
  resolveModelProvider,
  universalReasoningPolicy,
} from '../src/model-provider-registry.mjs';

const API_KEY = ['provider', 'registry', 'fixture', 'credential'].join('-');

test('registry exposes the five provider choices without secrets or mutable internals', () => {
  const providers = listModelProviders();
  assert.deepEqual(providers.map((entry) => entry.id), [
    'bailian', 'deepseek', 'glm', 'kimi', 'custom',
  ]);
  assert.equal(new Set(providers.map((entry) => entry.id)).size, providers.length);
  assert.equal(JSON.stringify(providers).includes(API_KEY), false);
  providers[0].protocols.push('fixture-mutation');
  assert.equal(listModelProviders()[0].protocols.includes('fixture-mutation'), false);
  const safeLimits = new Map([
    ['bailian', 16_384], ['deepseek', 8_192], ['glm', 4_095],
    ['kimi', 8_192], ['custom', 4_096],
  ]);
  for (const provider of providers) {
    assert.equal(provider.outputPolicy.applicationSafetyMaximumTokens, safeLimits.get(provider.id));
    assert.equal(provider.outputPolicy.applicationSafetyMaximumResponseBytes, 8 * 1024 * 1024);
  }
});

test('built-in providers resolve protocol, endpoint, authentication, and legacy v2 defaults', () => {
  const fixtures = [
    {
      input: { providerId: 'bailian' },
      expected: {
        protocol: 'anthropic-messages',
        endpoint: 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages',
        authMode: 'x-api-key',
        requestProfile: 'anthropic-standard',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'xhigh',
      },
    },
    {
      input: { providerId: 'deepseek' },
      expected: {
        protocol: 'openai-chat-completions',
        endpoint: 'https://api.deepseek.com/chat/completions',
        authMode: 'bearer',
        requestProfile: 'deepseek-openai',
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
      },
    },
    {
      input: { providerId: 'glm' },
      expected: {
        protocol: 'openai-chat-completions',
        endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        authMode: 'bearer',
        requestProfile: 'glm-openai',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    },
    {
      input: { providerId: 'kimi' },
      expected: {
        protocol: 'openai-chat-completions',
        endpoint: 'https://api.moonshot.cn/v1/chat/completions',
        authMode: 'bearer',
        requestProfile: 'kimi-openai',
        efforts: ['default'],
        defaultEffort: 'default',
      },
    },
  ];

  for (const { input, expected } of fixtures) {
    const adapter = resolveModelProvider(input);
    assert.equal(adapter.protocol, expected.protocol);
    assert.equal(adapter.endpoint, expected.endpoint);
    assert.equal(adapter.authMode, expected.authMode);
    const legacy = legacyV2ProviderFields(input);
    assert.equal(legacy.protocol, expected.protocol);
    assert.equal(legacy.authMode, expected.authMode);
    assert.equal(legacy.requestProfile, expected.requestProfile);
    assert.deepEqual(legacy.efforts, expected.efforts);
    assert.equal(legacy.defaultEffort, expected.defaultEffort);
    assert.equal(legacy.endpointPreview, expected.endpoint);
    assert.match(legacy.docsUrl, /^https:\/\//u);
  }
});

test('Bailian API Base path selects Anthropic or OpenAI-compatible transport without ambiguity', () => {
  const anthropic = resolveModelProvider({
    providerId: 'bailian',
    apiBase: 'https://region.example.com/apps/anthropic/v1',
  });
  assert.equal(anthropic.protocol, 'anthropic-messages');
  assert.equal(anthropic.authMode, 'x-api-key');
  assert.equal(anthropic.endpoint, 'https://region.example.com/apps/anthropic/v1/messages');
  assert.equal(anthropic.requestProfile, 'anthropic-standard');

  const openai = resolveModelProvider({
    providerId: 'bailian',
    apiBase: 'https://region.example.com/compatible-mode/v1',
  });
  assert.equal(openai.protocol, 'openai-chat-completions');
  assert.equal(openai.authMode, 'bearer');
  assert.equal(openai.endpoint, 'https://region.example.com/compatible-mode/v1/chat/completions');
  assert.equal(openai.requestProfile, 'bailian-openai');
  assert.deepEqual(openai.reasoningEfforts, ['low', 'high']);

  assert.throws(
    () => resolveModelProvider({ providerId: 'bailian', apiBase: 'https://region.example.com/v1' }),
    { code: 'BAILIAN_API_VARIANT_UNKNOWN' },
  );
  assert.throws(
    () => resolveModelProvider({
      providerId: 'bailian',
      apiBase: 'https://region.example.com/apps/anthropic',
      protocol: 'openai-chat-completions',
    }),
    { code: 'MODEL_PROVIDER_PROTOCOL_CONFLICT' },
  );
});

test('authentication headers use only the registered scheme and validate credentials', () => {
  const anthropic = resolveModelProvider({ providerId: 'bailian' });
  const deepseek = resolveModelProvider({ providerId: 'deepseek' });
  assert.deepEqual(providerAuthHeaders(anthropic, API_KEY), { 'x-api-key': API_KEY });
  assert.deepEqual(providerAuthHeaders(deepseek, API_KEY), { Authorization: `Bearer ${API_KEY}` });

  const noAuth = resolveModelProvider({
    providerId: 'custom',
    apiBase: 'https://models.example.com/v1',
    protocol: 'openai-chat-completions',
    authMode: 'none',
  });
  assert.deepEqual(providerAuthHeaders(noAuth), {});
  assert.throws(() => providerAuthHeaders(deepseek, ''), { code: 'MODEL_PROVIDER_KEY_REQUIRED' });
  assert.throws(() => providerAuthHeaders(deepseek, 'bad\nkey'), { code: 'MODEL_PROVIDER_KEY_REQUIRED' });
  assert.throws(
    () => resolveModelProvider({ providerId: 'deepseek', authMode: 'x-api-key' }),
    { code: 'MODEL_PROVIDER_AUTH_CONFLICT' },
  );
});

test('reasoning parameters are provider-controlled and unknown custom models stay conservative', () => {
  const bailianAnthropic = resolveModelProvider({ providerId: 'bailian' });
  assert.deepEqual(providerReasoningFields(bailianAnthropic, 'xhigh'), {
    output_config: { effort: 'xhigh' },
  });

  const bailianOpenAi = resolveModelProvider({
    providerId: 'bailian',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  });
  assert.deepEqual(providerReasoningFields(bailianOpenAi, 'high'), { enable_thinking: true });
  assert.deepEqual(providerReasoningFields(bailianOpenAi, 'low'), { enable_thinking: false });

  for (const providerId of ['deepseek', 'glm']) {
    const adapter = resolveModelProvider({ providerId });
    if (providerId === 'deepseek') {
      assert.deepEqual(providerReasoningFields(adapter, 'max'), {
        thinking: { type: 'enabled' }, reasoning_effort: 'max',
      });
      assert.deepEqual(providerReasoningFields(adapter, 'low'), {
        thinking: { type: 'enabled' }, reasoning_effort: 'low',
      });
    } else {
      assert.deepEqual(providerReasoningFields(adapter, 'max'), { thinking: { type: 'enabled' } });
      assert.deepEqual(providerReasoningFields(adapter, 'low'), { thinking: { type: 'disabled' } });
    }
  }

  assert.deepEqual(
    providerReasoningFields(resolveModelProvider({ providerId: 'kimi' }), 'max'),
    { reasoning_effort: 'max' },
  );

  for (const adapter of [
    resolveModelProvider({
      providerId: 'custom',
      apiBase: 'https://unknown.example.com/v1',
      protocol: 'openai-chat-completions',
    }),
    resolveModelProvider({
      providerId: 'custom',
      apiBase: 'https://unknown.example.com/anthropic',
      protocol: 'anthropic-messages',
    }),
  ]) {
    const fields = providerReasoningFields(adapter, 'max');
    assert.deepEqual(fields, {});
    assert.equal(Object.hasOwn(fields, 'thinking'), false);
    assert.equal(Object.hasOwn(fields, 'reasoning_effort'), false);
    assert.equal(Object.hasOwn(fields, 'output_config'), false);
    assert.equal(Object.hasOwn(fields, 'enable_thinking'), false);
  }
});

test('registered model families derive their selectable reasoning policy server-side', () => {
  const bailian = resolveModelProvider({ providerId: 'bailian' });
  assert.deepEqual(providerModelReasoningPolicy(bailian, 'qwen3.8-max-0902'), {
    efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh',
  });
  assert.deepEqual(providerModelReasoningPolicy(bailian, 'kimi-k3'), {
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium',
  });
  assert.deepEqual(providerModelReasoningPolicy(bailian, 'deepseek-v4-pro-0813'), {
    efforts: ['high', 'max'], defaultEffort: 'high',
  });
  assert.deepEqual(providerModelReasoningPolicy(resolveModelProvider({ providerId: 'kimi' }), 'kimi-k3'), {
    efforts: ['low', 'high', 'max'], defaultEffort: 'max',
  });
  assert.deepEqual(providerModelReasoningPolicy(resolveModelProvider({ providerId: 'kimi' }), 'moonshot-v1'), {
    efforts: ['default'], defaultEffort: 'default',
  });
});

test('all providers expose five stable tiers with deterministic effective mappings', () => {
  const qwen = providerUniversalReasoningPolicy(
    resolveModelProvider({ providerId: 'bailian' }),
    'qwen3.8-max-0902',
  );
  assert.deepEqual(qwen.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(qwen.effortMapping, {
    low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh',
  });
  const deepseek = providerUniversalReasoningPolicy(
    resolveModelProvider({ providerId: 'deepseek' }),
    'deepseek-v4-pro',
  );
  assert.deepEqual(deepseek.effortMapping, {
    low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max',
  });
  const glm = providerUniversalReasoningPolicy(
    resolveModelProvider({ providerId: 'glm' }),
    'glm-5',
  );
  assert.deepEqual(glm.effortMapping, {
    low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'high',
  });
  const bailianKimi = providerUniversalReasoningPolicy(
    resolveModelProvider({ providerId: 'bailian' }),
    'kimi-k3',
  );
  assert.deepEqual(bailianKimi.effortMapping, {
    low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  });
  const directKimi = providerUniversalReasoningPolicy(
    resolveModelProvider({ providerId: 'kimi' }),
    'kimi-k3',
  );
  assert.deepEqual(directKimi.effortMapping, {
    low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max',
  });
  const bailianDeepSeek = providerUniversalReasoningPolicy(
    resolveModelProvider({ providerId: 'bailian' }),
    'deepseek-v4-pro-0813',
  );
  assert.deepEqual(bailianDeepSeek.effortMapping, {
    low: 'high', medium: 'high', high: 'high', xhigh: 'max', max: 'max',
  });
  const noControl = universalReasoningPolicy({ efforts: ['default'], defaultEffort: 'default' });
  assert.equal(noControl.defaultEffort, 'medium');
  assert.deepEqual(new Set(Object.values(noControl.effortMapping)), new Set(['default']));
});

test('manual five-tier reasoning mappings are projected through provider capabilities', () => {
  const policy = resolveModelReasoningPolicy(
    resolveModelProvider({ providerId: 'kimi' }),
    'kimi-k3',
    {
      mode: 'manual',
      tiers: {
        low: 'default', medium: 'low', high: 'medium', xhigh: 'xhigh', max: 'max',
      },
    },
  );
  assert.deepEqual(policy.effortMapping, {
    low: 'default', medium: 'low', high: 'high', xhigh: 'max', max: 'max',
  });
  assert.throws(() => resolveModelReasoningPolicy(
    resolveModelProvider({ providerId: 'kimi' }),
    'kimi-k3',
    { mode: 'manual', tiers: { low: 'low' } },
  ), { code: 'MODEL_PROVIDER_EFFORT_MAPPING_INVALID' });
});

test('DeepSeek legacy model alias is exact and scoped to the DeepSeek adapter', () => {
  const deepseek = resolveModelProvider({ providerId: 'deepseek' });
  const bailian = resolveModelProvider({ providerId: 'bailian' });
  const custom = resolveModelProvider({
    providerId: 'custom', apiBase: 'https://models.example.com/v1',
  });
  assert.equal(
    normalizeProviderModelId(deepseek, 'deepseek-v4-pro-0813'),
    'deepseek-v4-pro',
  );
  assert.equal(
    normalizeProviderModelId(bailian, 'deepseek-v4-pro-0813'),
    'deepseek-v4-pro-0813',
  );
  assert.equal(
    normalizeProviderModelId(custom, 'deepseek-v4-pro-0813'),
    'deepseek-v4-pro-0813',
  );
  assert.equal(
    normalizeProviderModelId(deepseek, 'DeepSeek-v4-pro-0813'),
    'DeepSeek-v4-pro-0813',
  );
});

test('output tokens are bounded by an application safety ceiling, not advertised as model capability', () => {
  const bailian = resolveModelProvider({ providerId: 'bailian' });
  const deepseek = resolveModelProvider({ providerId: 'deepseek' });
  const glm = resolveModelProvider({ providerId: 'glm' });
  const kimi = resolveModelProvider({ providerId: 'kimi' });
  const custom = resolveModelProvider({
    providerId: 'custom', apiBase: 'https://models.example.com/v1',
  });
  assert.equal(providerModelOutputLimit(bailian, 'qwen3.8-max-0902'), 131_072);
  assert.equal(providerModelOutputLimit(deepseek, 'deepseek-v4-pro-0813'), 131_072);
  assert.equal(providerModelOutputLimit(glm, 'glm-5'), 131_072);
  assert.equal(providerModelOutputLimit(glm, 'glm-4.5'), 98_304);
  assert.equal(providerModelOutputLimit(glm, 'glm-4'), 4_095);
  assert.equal(providerModelOutputLimit(kimi, 'kimi-k3'), 8_192);
  assert.equal(providerModelOutputLimit(custom, 'qwen3.8-max-0902'), 4_096);
  assert.deepEqual(providerOutputFields(bailian, 999_999, 'qwen3.8-max-0902'), {
    max_tokens: 131_072,
  });
  assert.deepEqual(providerOutputFields(custom, 999_999, 'qwen3.8-max-0902'), {
    max_tokens: 4_096,
  });
  assert.equal(modelProviderRegistryInternals.APPLICATION_MAX_OUTPUT_TOKENS, 131_072);
  assert.throws(
    () => providerOutputFields(deepseek, 0),
    { code: 'MODEL_PROVIDER_OUTPUT_LIMIT_INVALID' },
  );
});

test('custom endpoints derive from explicit protocol and never opt into vendor reasoning by model name', () => {
  const openai = buildProviderRequestPolicy({
    providerId: 'custom',
    apiBase: 'https://gateway.example.com/v1',
    protocol: 'openai-chat-completions',
    authMode: 'bearer',
    apiKey: API_KEY,
    effort: 'max',
    maxOutputTokens: 512,
    actualModel: 'deepseek-or-qwen-looking-name',
  });
  assert.equal(openai.endpoint, 'https://gateway.example.com/v1/chat/completions');
  assert.deepEqual(openai.headers, { Authorization: `Bearer ${API_KEY}` });
  assert.deepEqual(openai.bodyFields, { max_tokens: 512 });

  const anthropic = resolveModelProvider({
    providerId: 'custom',
    apiBase: 'https://gateway.example.com/v1',
    protocol: 'anthropic-messages',
    authMode: 'x-api-key',
  });
  assert.equal(anthropic.endpoint, 'https://gateway.example.com/v1/messages');
  assert.equal(legacyV2ProviderFields({
    providerId: 'custom',
    apiBase: 'https://gateway.example.com/v1',
    protocol: 'anthropic-messages',
  }).requestProfile, 'default');
});

test('registry rejects unknown providers and unsafe API Base shapes before request assembly', () => {
  assert.throws(() => resolveModelProvider({ providerId: 'unknown' }), {
    code: 'MODEL_PROVIDER_NOT_REGISTERED',
  });
  for (const apiBase of [
    'http://models.example.com/v1',
    'https://user:password@models.example.com/v1',
    'https://models.example.com:8443/v1',
    'https://models.example.com/v1?token=secret',
    'https://models.example.com/v1#fragment',
    'https://127.0.0.1/v1',
    'https://models.internal/v1',
  ]) {
    assert.throws(
      () => resolveModelProvider({ providerId: 'custom', apiBase }),
      { code: 'MODEL_PROVIDER_BASE_INVALID' },
    );
  }
});
