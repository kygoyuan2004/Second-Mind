import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversationStore } from '../src/conversation-store.mjs';
import { ChatModelClient } from '../src/llm-client.mjs';
import { TaskManager, taskManagerInternals } from '../src/task-manager.mjs';
import { temporaryProject } from './helpers.mjs';

function truncatedError(usage, stopReason = 'max_tokens') {
  const error = new Error('fixture output limit');
  error.code = 'LLM_OUTPUT_TRUNCATED';
  error.stopReason = stopReason;
  error.usage = usage;
  error.retryable = false;
  return error;
}

async function taskFixture(t, generate) {
  const project = await temporaryProject('vaultmind-task-usage-');
  t.after(project.cleanup);
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 0, chunks: 0, semanticAvailable: false }),
    search: async () => ({ results: [], diagnostics: {} }),
    close: async () => {},
  };
  const store = { ready: Promise.resolve(), cleanupDrafts: async () => {} };
  const config = {
    ...project.config,
    appName: 'Fixture',
    vaultLabel: 'Fixture Vault',
    timezone: 'UTC',
    llm: {
      provider: 'anthropic',
      model: 'fixture-model',
      maxOutputTokens: 100_000,
      temperature: 0,
    },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 3, maxContextChars: 2_000 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
    research: { contextualizerEnabled: false },
    deep: { enabled: true, topK: 6 },
  };
  const manager = new TaskManager(config, {
    index,
    store,
    conversations,
    llm: { generate },
  });
  t.after(() => manager.close());
  await manager.ready;
  return { manager, conversations };
}

test('final answer uses one bounded continuation, preserves legacy streaming, and reports per-call usage', async (t) => {
  const calls = [];
  const firstUsage = {
    inputTokens: 100,
    outputTokens: 16_384,
    cacheReadInputTokens: 20,
    cacheCreationInputTokens: null,
    reasoningTokens: 2_000,
    totalTokens: 16_484,
  };
  const secondUsage = {
    inputTokens: 16_520,
    outputTokens: 24,
    cacheReadInputTokens: 16_000,
    cacheCreationInputTokens: null,
    reasoningTokens: null,
    totalTokens: 16_544,
  };
  const fixture = await taskFixture(t, async (messages, options) => {
    calls.push({ messages, options });
    if (calls.length === 1) {
      assert.equal(options.maxOutputTokens, 16_384);
      options.onToken?.('partial answer ');
      await options.onAssistantMessage?.({
        role: 'assistant',
        content: 'partial answer ',
        reasoning_content: 'private transient reasoning',
      });
      await options.onUsage?.({
        phase: 'final',
        protocol: 'anthropic-messages',
        stopReason: 'max_tokens',
        usage: { ...firstUsage, privatePrompt: 'must-not-escape' },
      });
      throw truncatedError(firstUsage);
    }
    assert.equal(calls.length, 2, 'only one continuation call is allowed');
    assert.equal(options.effort, 'low');
    assert.equal(options.maxOutputTokens, 8_192);
    assert.deepEqual(messages.at(-2), {
      role: 'assistant',
      content: 'partial answer ',
      reasoning_content: 'private transient reasoning',
    });
    assert.match(messages.at(-1).content, /only the missing suffix/i);
    assert.match(messages.at(-1).content, /Finish every open sentence/i);
    options.onToken?.('finished.');
    await options.onUsage?.({
      phase: 'final',
      protocol: 'anthropic-messages',
      stopReason: 'end_turn',
      usage: secondUsage,
    });
    return 'finished.';
  });

  const created = await fixture.manager.createTask('admin', {
    kind: 'qa',
    prompt: 'fixture private question',
    taskMode: 'normal',
  });
  const task = fixture.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(calls[0].options, 'includeUsage'), false,
    'TaskManager must not force stream_options on compatible providers');
  assert.equal(task.events.filter((event) => event.type === 'text')
    .map((event) => event.data.text).join(''), 'partial answer finished.');
  assert.ok(task.events.some((event) => (
    event.type === 'activity' && event.data.title === '回答达到输出上限，正在续写'
  )));
  assert.ok(task.events.some((event) => (
    event.type === 'activity' && event.data.title === '回答续写完成'
  )));

  const measured = task.events.filter((event) => event.type === 'usage' && event.data.usage);
  assert.deepEqual([...new Set(measured.map((event) => event.data.callId))], ['model-1', 'model-2']);
  assert.deepEqual([...new Set(measured.map((event) => event.data.purpose))], [
    'final_answer',
    'final_answer_continuation',
  ]);
  assert.deepEqual(measured.find((event) => event.data.callId === 'model-1').data.usage, firstUsage);
  assert.equal(JSON.stringify(measured).includes('must-not-escape'), false);
  assert.equal(JSON.stringify(measured).includes('fixture private question'), false);
  assert.equal(JSON.stringify(task.events).includes('private transient reasoning'), false);

  const stored = fixture.conversations.get('admin', created.conversationId);
  assert.equal(stored.messages.at(-1).role, 'assistant');
  assert.equal(stored.messages.at(-1).content, 'partial answer finished.');
  assert.equal(JSON.stringify(stored).includes('private transient reasoning'), false);
});

test('a failed or truncated continuation makes the task fail without persisting partial output', async (t) => {
  let calls = 0;
  const usage = {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    reasoningTokens: null,
    totalTokens: 15,
  };
  const fixture = await taskFixture(t, async (_messages, options) => {
    calls += 1;
    options.onToken?.(calls === 1 ? 'first partial' : 'second partial');
    await options.onUsage?.({
      phase: 'final', protocol: 'anthropic-messages', stopReason: 'max_tokens', usage,
    });
    throw truncatedError(usage);
  });

  const created = await fixture.manager.createTask('admin', {
    kind: 'qa', prompt: 'must not persist partial', taskMode: 'normal',
  });
  const task = fixture.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(calls, 2, 'a second continuation must never be attempted');
  assert.equal(task.status, 'failed');
  assert.ok(task.events.some((event) => (
    event.type === 'activity' && event.data.title === '回答续写失败'
  )));
  assert.ok(task.events.some((event) => (
    event.type === 'task_error' && event.data.code === 'LLM_OUTPUT_TRUNCATED'
  )));
  assert.deepEqual(
    fixture.conversations.get('admin', created.conversationId).messages.map((message) => message.role),
    ['user'],
  );
  const serializedConversation = JSON.stringify(
    fixture.conversations.get('admin', created.conversationId),
  );
  assert.equal(serializedConversation.includes('first partial'), false);
  assert.equal(serializedConversation.includes('second partial'), false);
});

test('Normal and Deep final generation ceilings are 16384 and 32768 tokens', async (t) => {
  const fixture = await taskFixture(t, async () => 'unused');
  const common = {
    kind: 'qa',
    model: { actualModel: 'fixture-model' },
    effort: 'high',
  };
  assert.equal(fixture.manager.generationOptions({
    ...common, taskMode: { id: 'normal' },
  }).maxOutputTokens, 16_384);
  assert.equal(fixture.manager.generationOptions({
    ...common, taskMode: { id: 'deep' },
  }).maxOutputTokens, 32_768);
});

test('dynamic model leases receive the requested effort exactly once', async (t) => {
  const fixture = await taskFixture(t, async () => 'unused');
  const task = {
    kind: 'qa',
    taskMode: { id: 'normal' },
    model: {
      actualModel: 'fixture-model',
      defaultEffort: 'high',
      effortMapping: {
        low: 'max', medium: 'low', high: 'high', xhigh: 'max', max: 'max',
      },
    },
    effort: 'medium',
    effectiveEffort: 'low',
    llmClient: { mapsRequestedEffort: true },
  };
  assert.equal(fixture.manager.generationOptions(task).effort, 'medium');
  assert.equal(fixture.manager.auxiliaryGenerationOptions(task, 256).effort, 'low');

  const legacyTask = { ...task, llmClient: null };
  assert.equal(fixture.manager.generationOptions(legacyTask).effort, 'low');
  assert.equal(fixture.manager.auxiliaryGenerationOptions(legacyTask, 256).effort, 'low');
});

test('a truncated Kimi stream replays private reasoning only to its one continuation', async (t) => {
  const bodies = [];
  const client = new ChatModelClient({
    provider: 'kimi',
    protocol: 'openai-chat-completions',
    requestProfile: 'kimi-openai',
    authMode: 'bearer',
    apiBase: 'https://api.moonshot.cn/v1',
    apiKey: 'fixture-kimi-key',
    model: 'kimi-k3',
    maxOutputTokens: 32_768,
    timeoutMs: 1_000,
  }, {
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return new Response([
          'data: {"choices":[{"delta":{"reasoning_content":"private chain","content":"partial answer "}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response([
        'data: {"choices":[{"delta":{"content":"finished."},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const fixture = await taskFixture(t, client.generate.bind(client));
  const created = await fixture.manager.createTask('admin', {
    kind: 'qa', prompt: 'fixture Kimi continuation', taskMode: 'normal',
  });
  const task = fixture.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(bodies.length, 2);
  const replay = bodies[1].messages.at(-2);
  assert.deepEqual(replay, {
    role: 'assistant', content: 'partial answer ', reasoning_content: 'private chain',
  });
  assert.equal(JSON.stringify(task.events).includes('private chain'), false);
  assert.equal(JSON.stringify(fixture.conversations.get('admin', created.conversationId))
    .includes('private chain'), false);
});

test('continuation merge removes only a meaningful exact overlap', () => {
  const { mergeContinuationText } = taskManagerInternals;
  const repeated = 'This paragraph is repeated by the compatible provider.';
  assert.equal(
    mergeContinuationText(`Start. ${repeated}`, `${repeated} Finish.`),
    `Start. ${repeated} Finish.`,
  );
  assert.equal(
    mergeContinuationText('Short end.', 'end. Continue.'),
    'Short end.end. Continue.',
    'tiny overlaps must not erase legitimate repeated punctuation or words',
  );
});
