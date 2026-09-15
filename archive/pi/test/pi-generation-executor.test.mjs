import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFauxCore,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai';

import { generateWithPi } from '../src/pi-generation-executor.mjs';

function binding(overrides = {}) {
  return {
    protocol: 'openai-chat-completions',
    providerId: 'fixture',
    requestProfile: 'openai-standard',
    authMode: 'bearer',
    apiBase: 'https://models.example.test/v1',
    apiKey: 'fixture-secret',
    actualModel: 'fixture-model',
    maxOutputTokens: 4_096,
    contextWindow: 262_144,
    fetch: async () => assert.fail('The faux Pi provider must not use network.'),
    ...overrides,
  };
}

function singleResponseStreams(capture, response = fauxAssistantMessage('一次完成')) {
  return (api) => {
    const faux = createFauxCore({
      api,
      provider: 'single-generation-test',
      models: [{ id: 'fixture-model' }],
    });
    faux.setResponses([
      (context) => {
        capture.calls += 1;
        capture.context = context;
        return response;
      },
    ]);
    return {
      stream: faux.stream,
      streamSimple(model, context, options) {
        capture.options = options;
        return faux.streamSimple(model, context, options);
      },
    };
  };
}

test('Pi executes exactly one pre-planned generation with an empty tool set', async () => {
  const capture = { calls: 0 };
  const tokens = [];
  const answer = await generateWithPi(binding(), [
    { role: 'system', content: '固定系统指令' },
    { role: 'user', content: '固定用户输入' },
  ], {
    effort: 'high',
    maxOutputTokens: 768,
    timeoutMs: 5_000,
    maxRetries: 99,
    streamFactory: singleResponseStreams(capture),
    onToken: (value) => tokens.push(value),
  });

  assert.equal(answer, '一次完成');
  assert.equal(capture.calls, 1);
  assert.deepEqual(capture.context.tools, []);
  assert.equal(capture.context.systemPrompt, '固定系统指令');
  assert.equal(capture.context.messages.length, 1);
  assert.equal(capture.options.maxTokens, 768);
  assert.equal(capture.options.maxRetries, 0);
  assert.equal(capture.options.cacheRetention, 'none');
  assert.equal(capture.options.reasoning, 'high');
  assert.equal(tokens.join(''), '一次完成');
});

test('Pi never turns a token-limited result into an autonomous continuation', async () => {
  const capture = { calls: 0 };
  await assert.rejects(
    generateWithPi(binding(), [{ role: 'user', content: '只调用一次' }], {
      maxOutputTokens: 128,
      streamFactory: singleResponseStreams(
        capture,
        fauxAssistantMessage('未完成', { stopReason: 'length' }),
      ),
    }),
    { code: 'LLM_OUTPUT_TRUNCATED' },
  );
  assert.equal(capture.calls, 1);
});

test('concurrent single generations keep their contexts and provider responses isolated', { timeout: 5_000 }, async () => {
  let started = 0;
  let release;
  const bothStarted = new Promise((resolve) => { release = resolve; });
  const captures = [];
  const run = (label) => generateWithPi(binding(), [{ role: 'user', content: label }], {
    timeoutMs: 3_000,
    streamFactory: (api) => {
      const faux = createFauxCore({ api, provider: 'concurrent-single-generation-test', models: [{ id: 'fixture-model' }] });
      faux.setResponses([async (context) => {
        captures.push({ label, context });
        started += 1;
        if (started === 2) release();
        await bothStarted;
        return fauxAssistantMessage(`answer-${label}`);
      }]);
      return { stream: faux.stream, streamSimple(model, context, options) {
        assert.equal(options.maxRetries, 0);
        assert.deepEqual(context.tools, []);
        return faux.streamSimple(model, context, options);
      } };
    },
  });
  assert.deepEqual(await Promise.all([run('batch-A'), run('batch-B')]), ['answer-batch-A', 'answer-batch-B']);
  assert.equal(captures.length, 2);
  for (const { label, context } of captures) {
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0].content, label);
  }
});

test('Pi classifies its own request deadline as a timeout and never retries', async () => {
  let calls = 0;
  await assert.rejects(generateWithPi(binding(), [{ role: 'user', content: '合成超时测试' }], {
    timeoutMs: 1_000,
    adapterFactory: async () => ({
      model: { id: 'fixture', maxTokens: 100 },
      thinkingLevelFor: () => 'xhigh',
      modelRuntime: { async *streamSimple(model, context, options) {
        calls += 1;
        assert.deepEqual(context.tools, []);
        assert.equal(options.maxRetries, 0);
        await new Promise((resolve) => {
          const keepAlive = setTimeout(resolve, 2_000);
          options.signal.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            resolve();
          }, { once: true });
        });
        yield { type: 'error', error: { errorMessage: 'Request aborted', stopReason: 'error' } };
      } },
    }),
  }), { code: 'LLM_TIMEOUT', status: 504 });
  assert.equal(calls, 1);
});
