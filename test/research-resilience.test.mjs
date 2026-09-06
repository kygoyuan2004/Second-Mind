import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversationStore } from '../src/conversation-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { temporaryProject } from './helpers.mjs';

const QUESTION = '测试人物乙是谁';

function contextualizerOutput() {
  return JSON.stringify({
    standaloneQuestion: QUESTION,
    subject: { name: '测试人物乙', type: 'person', aliases: ['ARTIST_A'] },
    requiredAnchors: ['星光练习营'],
    intent: { label: '人物简介', terms: ['歌手', '独立训练生'] },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  });
}

function evaluatorOutput() {
  return JSON.stringify({
    sufficient: true,
    confidence: 0.9,
    claims: [],
    conflicts: [],
    gaps: [],
    nextQueries: [],
    readSourceIds: [],
  });
}

function classifyModelCall(messages) {
  const system = String(messages[0]?.content || '');
  if (system.includes('conversation contextualizer')) return 'contextualizer';
  if (system.includes('evidence evaluator')) return 'evaluator';
  return 'final';
}

async function fixture(t, {
  llmTimeoutMs = 1_000,
  llmMaxOutputTokens = 4_096,
  contextualizerEmpty = false,
  contextualizerResult = null,
  finalText = '测试人物乙是中国内地歌手。',
  webSearchEmpty = false,
  webSearchFailureAfterStart = false,
  vaultResultFactory = null,
  evaluatorResult = null,
  emitFinalTokens = false,
} = {}) {
  const project = await temporaryProject('research-resilience-');
  t.after(project.cleanup);

  const modelCalls = [];
  const vaultQueries = [];
  const webQueries = [];
  const readerCalls = [];
  const extractorCalls = [];
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 1, chunks: 1, semanticAvailable: false }),
    search: async (query) => {
      vaultQueries.push(query);
      return {
        route: 'hybrid',
        results: vaultResultFactory
          ? await vaultResultFactory(query)
          : [{
              path: 'people/测试人物乙.md',
              content: '测试人物乙曾以独立训练生身份参加《星光练习营》，从事歌手工作。',
              matchedTerms: ['测试人物乙', '星光练习营'],
            }],
        diagnostics: { embeddingUsed: false },
      };
    },
    close: async () => {},
  };
  const store = {
    ready: Promise.resolve(),
    cleanupDrafts: async () => {},
    auditBestEffort: async () => [],
  };
  const llm = {
    generate: async (messages, options = {}) => {
      const kind = classifyModelCall(messages);
      modelCalls.push({
        kind,
        messages: structuredClone(messages),
        options: { ...options, signal: undefined },
      });
      if (kind === 'contextualizer') {
        if (contextualizerEmpty) {
          const error = new Error('Model returned an empty response.');
          error.code = 'LLM_EMPTY_RESPONSE';
          throw error;
        }
        return contextualizerResult
          ? JSON.stringify(contextualizerResult)
          : contextualizerOutput();
      }
      if (kind === 'evaluator') {
        return evaluatorResult
          ? JSON.stringify(typeof evaluatorResult === 'function'
              ? evaluatorResult(modelCalls.filter((call) => call.kind === 'evaluator').length)
              : evaluatorResult)
          : evaluatorOutput();
      }
      if (emitFinalTokens) {
        const midpoint = Math.max(1, Math.floor(finalText.length / 2));
        options.onToken?.(finalText.slice(0, midpoint));
        options.onToken?.(finalText.slice(midpoint));
      }
      return finalText;
    },
  };
  const webSearch = {
    publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
    searchMany: async (queries, options = {}) => {
      webQueries.push(...queries);
      if (webSearchFailureAfterStart) {
        options.onActivity?.({ stage: 'start', index: 0, total: queries.length });
        const error = new Error('fixture WebSearch failure after start');
        error.code = 'WEB_SEARCH_FAILED';
        throw error;
      }
      if (webSearchEmpty) {
        for (const [index] of queries.entries()) {
          options.onActivity?.({ stage: 'start', index, total: queries.length });
          options.onActivity?.({ stage: 'complete', index, total: queries.length, resultCount: 0 });
        }
        return {
          results: [], candidates: [], evidenceCandidates: [],
          attempts: queries.map((_query, queryIndex) => ({
            queryHash: `fixture-empty-${queryIndex}`,
            queryIndex,
            status: 'completed',
            resultCount: 0,
            durationMs: 1,
          })),
          errors: [],
          queryCount: queries.length,
        };
      }
      const candidates = queries.map((_query, queryIndex) => ({
        title: '测试人物乙以独立训练生身份参加星光练习营',
        url: `https://example.com/fictional-artist-a-${queryIndex}`,
        snippet: '测试人物乙是歌手，曾以独立训练生身份参加星光练习营。',
        source: 'example.com',
        publishedAt: '2026-08-01',
        queryIndex,
      }));
      for (const [index] of queries.entries()) {
        options.onActivity?.({ stage: 'start', index, total: queries.length });
        options.onActivity?.({
          stage: 'complete', index, total: queries.length, resultCount: 1,
        });
      }
      return {
        results: candidates,
        candidates,
        evidenceCandidates: candidates,
        attempts: queries.map((_query, queryIndex) => ({
          queryHash: `fixture-${queryIndex}`,
          queryIndex,
          status: 'completed',
          resultCount: 1,
          durationMs: 1,
        })),
        errors: [],
        queryCount: queries.length,
      };
    },
  };
  const webReader = {
    publicStatus: () => ({ enabled: false, configured: false }),
    readMany: async (input) => {
      readerCalls.push(input);
      return { documents: [], attempts: [], errors: [] };
    },
  };
  const responsesExtractor = {
    publicStatus: () => ({ enabled: false, configured: false }),
    extract: async (input) => {
      extractorCalls.push(input);
      return { text: '', extractedSourceIds: [], attempts: [], errors: [], toolCounts: {} };
    },
  };
  const manager = new TaskManager({
    ...project.config,
    vaultLabel: 'Fixture Vault',
    modelCatalog: [{
      id: 'deepseek',
      label: 'DeepSeek fixture',
      actualModel: 'deepseek-v4-pro-0813',
      provider: 'fixture',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      available: true,
    }],
    llm: {
      provider: 'fixture',
      model: 'deepseek-v4-pro-0813',
      timeoutMs: llmTimeoutMs,
      maxOutputTokens: llmMaxOutputTokens,
      temperature: 0,
    },
    embedding: { provider: 'fixture', timeoutMs: 1_000 },
    retrieval: { topK: 8, maxContextChars: 20_000 },
    deep: { enabled: true, topK: 12 },
    research: { contextualizerEnabled: true, loopEnabled: true },
    webSearch: {
      enabled: true,
      resultCount: 15,
      deepResultCount: 6,
      maxResultsPerDomain: 2,
      modelSourceLimit: 10,
      maxContextChars: 30_000,
      timeoutMs: 1_000,
    },
    webReader: { enabled: false, normalMaxPages: 2, totalMaxChars: 40_000 },
    responsesFallback: { enabled: false, timeoutMs: 1_000 },
  }, {
    allowLegacyTestEngine: true,
    index,
    store,
    llm,
    webSearch,
    webReader,
    responsesExtractor,
    conversations,
  });
  t.after(() => manager.close());
  await manager.ready;
  return {
    manager,
    conversations,
    modelCalls,
    vaultQueries,
    webQueries,
    readerCalls,
    extractorCalls,
  };
}

async function runNormal(value, overrides = {}) {
  const created = await value.manager.createTask('admin', {
    kind: 'qa',
    prompt: QUESTION,
    taskMode: 'normal',
    model: 'deepseek',
    effort: 'max',
    webSearch: true,
    ...overrides,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;
  return { created, task };
}

test('Normal still runs its first Vault and Web paths with a 600-second LLM timeout', async (t) => {
  const value = await fixture(t, { llmTimeoutMs: 600_000 });
  const { task } = await runNormal(value);

  assert.equal(task.status, 'completed');
  assert.equal(value.vaultQueries.length, 1);
  assert.deepEqual(value.webQueries, value.vaultQueries);
  assert.match(value.vaultQueries[0], /测试人物乙/u);
  assert.equal(task.events.some((event) => (
    event.data?.toolName === 'research_deadline' &&
    event.data?.message === '已进入最终回答预留时间，不再启动新的检索路径。'
  )), false, 'the final-answer reserve must not suppress Normal\'s mandatory first pass');
});

test('structured research helpers do not inherit max effort from final generation', async (t) => {
  const value = await fixture(t, {
    contextualizerResult: {
      ...JSON.parse(contextualizerOutput()),
      temporal: { mode: 'current', asOf: null },
    },
  });
  const { task } = await runNormal(value);

  assert.equal(task.status, 'completed');
  const contextualizer = value.modelCalls.find((call) => call.kind === 'contextualizer');
  const evaluator = value.modelCalls.find((call) => call.kind === 'evaluator');
  const final = value.modelCalls.find((call) => call.kind === 'final');
  assert.ok(contextualizer, 'the contextualizer must run');
  assert.ok(evaluator, 'Normal evidence must receive one structured evaluation');
  assert.ok(final, 'the final answer must still be generated');
  assert.equal(contextualizer.options.effort, 'low');
  assert.equal(evaluator.options.effort, 'low');
  assert.equal(contextualizer.options.timeoutMs, 45_000);
  assert.equal(evaluator.options.timeoutMs, 60_000);
  assert.equal(final.options.effort, 'max');
  assert.equal(final.options.maxOutputTokens, 4_096);
  assert.equal(contextualizer.options.model, 'deepseek-v4-pro-0813');
  assert.equal(evaluator.options.model, 'deepseek-v4-pro-0813');
  assert.equal(final.options.model, 'deepseek-v4-pro-0813');
});

test('QA final-answer budgets bound oversized provider limits by task mode', async (t) => {
  const normalValue = await fixture(t, { llmMaxOutputTokens: 131_072 });
  const { task: normalTask } = await runNormal(normalValue, { webSearch: false });
  assert.equal(normalTask.status, 'completed');
  assert.equal(
    normalValue.modelCalls.find((call) => call.kind === 'final').options.maxOutputTokens,
    16_384,
  );
  assert.match(
    normalValue.modelCalls.find((call) => call.kind === 'final').messages[0].content,
    /do not repeat the same formulas/u,
  );
  assert.match(
    normalValue.modelCalls.find((call) => call.kind === 'final').messages[0].content,
    /cite only the minimum evidence needed/u,
  );
  assert.match(
    normalValue.modelCalls.find((call) => call.kind === 'final').messages[0].content,
    /never end with unfinished syntax/u,
  );

  const deepValue = await fixture(t, { llmMaxOutputTokens: 131_072 });
  const { task: deepTask } = await runNormal(deepValue, {
    taskMode: 'deep',
    webSearch: false,
  });
  assert.equal(deepTask.status, 'completed');
  assert.equal(
    deepValue.modelCalls.find((call) => call.kind === 'final').options.maxOutputTokens,
    32_768,
  );
  assert.doesNotMatch(
    deepValue.modelCalls.find((call) => call.kind === 'final').messages[0].content,
    /do not repeat the same formulas/u,
  );
});

test('a standalone technical Normal question skips model contextualization and redundant evidence evaluation', async (t) => {
  const question = '训练时候的显存占用和推理时候的显存占用怎么计算，请给公式？';
  const value = await fixture(t, {
    finalText: '训练显存由参数、梯度、优化器状态与激活值组成 [[notes/formula.md]]。',
    vaultResultFactory: async () => [{
      path: 'notes/formula.md',
      content: '训练显存 = 参数 + 梯度 + 优化器状态 + 激活值；推理显存 = 权重 + KV Cache。',
      matchedTerms: ['训练显存', '推理显存', '公式'],
    }],
  });
  const { task } = await runNormal(value, {
    prompt: question,
    webSearch: false,
  });

  assert.equal(task.status, 'completed');
  assert.deepEqual(value.vaultQueries, [question]);
  assert.deepEqual(value.modelCalls.map((call) => call.kind), ['final']);
  assert.ok(task.events.some((event) => (
    event.data?.toolName === 'conversation_contextualizer' &&
    event.data?.diagnostics?.deterministic === true
  )));
  assert.ok(task.events.some((event) => (
    event.data?.toolName === 'evidence_evaluator' && event.data?.stage === 'skipped'
  )));
});

test('a complete technical follow-up switches topic without clarification or helper model calls', async (t) => {
  const question = '告诉我训练的显存怎么计算';
  const value = await fixture(t, {
    webSearchEmpty: true,
    finalText: '训练显存由参数、梯度、优化器状态与激活值组成 [[notes/formula.md]]。',
    vaultResultFactory: async () => [{
      path: 'notes/formula.md',
      content: '训练显存 = 参数 + 梯度 + 优化器状态 + 激活值。',
      matchedTerms: ['训练显存', '计算'],
    }],
  });
  const prior = value.conversations.create('admin', 'qa', {
    title: '告诉我推理的显存怎么计算',
    model: 'deepseek', effort: 'max', taskMode: 'normal', webSearch: true,
    researchContext: {
      subject: { name: '', type: 'topic', aliases: [] },
      requiredAnchors: [],
      intent: { label: '推理显存计算', terms: ['KV Cache'] },
      temporal: { mode: 'unspecified', asOf: null },
      lastStandaloneQuestion: '告诉我推理的显存怎么计算',
      verifiedClaims: [], citedSources: [],
    },
  });
  prior.messages.push(
    { role: 'user', content: '告诉我推理的显存怎么计算' },
    { role: 'assistant', content: '推理显存主要由权重和 KV Cache 构成。' },
  );
  await value.conversations.save();

  const { task } = await runNormal(value, {
    prompt: question,
    conversationId: prior.id,
    webSearch: true,
  });

  assert.equal(task.status, 'completed');
  assert.deepEqual(value.vaultQueries, [question]);
  assert.deepEqual(value.webQueries, [question]);
  assert.deepEqual(value.modelCalls.map((call) => call.kind), ['final']);
  assert.equal(task.events.some((event) => event.data?.title === '追问需要消歧'), false);
});

test('research answers stream only Vault-safe text and finish with one canonical replacement', async (t) => {
  const finalText = '训练显存包含模型状态和激活值 [[notes/formula.md]]。';
  const value = await fixture(t, {
    finalText,
    emitFinalTokens: true,
    vaultResultFactory: async () => [{
      path: 'notes/formula.md',
      content: '训练显存包含模型状态和激活值。',
      matchedTerms: ['训练显存'],
    }],
  });
  const { task } = await runNormal(value, {
    prompt: '训练显存由什么组成？',
    webSearch: false,
  });

  assert.equal(task.status, 'completed');
  assert.equal(task.events.filter((event) => event.type === 'text')
    .map((event) => event.data.text).join(''), finalText);
  const replacements = task.events.filter((event) => event.type === 'text_replace');
  assert.equal(replacements.length, 1);
  assert.match(replacements[0].data.text, /\[未核验知识库来源\]/u);
  assert.notEqual(replacements[0].data.text, finalText,
    'the replacement contains the validated citation result rather than appending the raw body');
});

test('research answers with retained Web evidence stay buffered until citation validation', async (t) => {
  const value = await fixture(t, {
    finalText: '测试人物乙是歌手 [W1]。',
    emitFinalTokens: true,
  });
  const { task } = await runNormal(value, {
    prompt: QUESTION,
    webSearch: true,
  });

  assert.equal(task.status, 'completed');
  assert.equal(task.events.filter((event) => event.type === 'text_replace').length, 0);
  const textEvents = task.events.filter((event) => event.type === 'text');
  assert.equal(textEvents.length, 1,
    'Web-backed model chunks must not reach SSE before their source tokens are validated');
  assert.match(textEvents[0].data.text, /https:\/\/example\.com\/fictional-artist-a-0/u);
});

test('Deep stops after a feedback round that adds no evidence instead of repeatedly replanning', async (t) => {
  const value = await fixture(t, {
    vaultResultFactory: async () => [],
    evaluatorResult: {
      sufficient: false,
      confidence: 0,
      claims: [],
      conflicts: [],
      gaps: ['缺少证据'],
      nextQueries: ['测试人物乙 星光练习营 人物简介 补充资料'],
      readSourceIds: [],
    },
  });
  const created = await value.manager.createTask('admin', {
    kind: 'qa',
    prompt: QUESTION,
    taskMode: 'deep',
    model: 'deepseek',
    effort: 'max',
    webSearch: false,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(value.modelCalls.filter((call) => call.kind === 'evaluator').length, 2);
  assert.ok(value.vaultQueries.length >= 2);
  assert.ok(value.vaultQueries.length <= 5);
  assert.ok(task.events.some((event) => event.data?.title === '研究阶段已收敛'));
});

test('Deep keeps complementary training and inference memory formula evidence in the final prompt', async (t) => {
  const question = '训练时候的显存占用和推理时候的显存占用怎么计算，请给公式';
  const contextualizerResult = {
    standaloneQuestion: question,
    subject: {
      name: '深度学习模型训练与推理显存占用计算',
      type: 'concept',
      aliases: ['GPU 显存计算'],
    },
    requiredAnchors: ['训练', '推理', '显存占用', '计算公式'],
    intent: { label: '显存计算公式', terms: ['AdamW', '激活值', 'KV Cache'] },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [
      question,
      'AdamW 混合精度训练显存 参数 梯度 主权重 优化器状态 激活值',
      '推理显存 权重 量化 scale KV Cache 激活 workspace',
      'KV Cache 每 token 层数 KV头 head_dim dtype',
    ],
  };
  const value = await fixture(t, {
    contextualizerResult,
    finalText: [
      '训练显存约为 16Ψ 加激活值 [[learning/cs336.md]]。',
      '推理显存为权重、量化尺度、KV Cache、激活与工作区之和 [[learning/precision.md]]。',
      'ZeRO-3 将模型状态按卡数分片 [[learning/happy.md]]。',
    ].join('\n'),
    vaultResultFactory: async (query) => {
      if (/KV Cache 每 token/u.test(query)) return [{
        path: 'learning/precision.md', lineStart: 318, lineEnd: 339,
        content: 'M_KV/token = 2 × L × n_KV × d_h × b；再乘上下文长度与并发数。',
        matchedTerms: ['KV Cache', 'token'],
      }];
      if (/推理显存/u.test(query)) return [{
        path: 'learning/precision.md', lineStart: 228, lineEnd: 251,
        content: 'M_total = M_weights + M_scales + M_KV Cache + M_activations + M_workspace。',
        matchedTerms: ['推理显存', '权重'],
      }];
      if (/AdamW/u.test(query)) return [{
        path: 'learning/cs336.md', lineStart: 561, lineEnd: 713,
        content: 'BF16 参数 2、梯度 2、FP32 主权重 4、Adam m/v 各 4 字节，所以模型状态为 16Ψ；激活值另计。',
        matchedTerms: ['AdamW', '训练显存'],
      }];
      return [{
        path: 'learning/happy.md', lineStart: 158, lineEnd: 171,
        content: 'ZeRO-1/2/3 依次分片优化器状态、梯度和参数。',
        matchedTerms: ['训练', '显存'],
      }];
    },
  });
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: question, taskMode: 'deep', model: 'deepseek', effort: 'max', webSearch: false,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(value.vaultQueries.length, 4);
  const finalCall = value.modelCalls.find((call) => call.kind === 'final');
  const finalPrompt = finalCall.messages.at(-1).content;
  assert.match(finalPrompt, /16Ψ/u);
  assert.match(finalPrompt, /M_KV\/token/u);
  assert.match(finalPrompt, /M_total/u);
  assert.match(finalPrompt, /ZeRO-1\/2\/3/u);
  assert.doesNotMatch(finalPrompt, /No relevant Vault source/u);
});

test('an empty contextualizer response to a one-character follow-up clarifies without retrieval', async (t) => {
  const value = await fixture(t, { contextualizerEmpty: true });
  const prior = value.conversations.create('admin', 'qa', {
    title: QUESTION,
    model: 'deepseek',
    effort: 'max',
    taskMode: 'normal',
    webSearch: true,
    researchContext: {
      subject: { name: '测试人物乙', type: 'person', aliases: ['ARTIST_A'] },
      requiredAnchors: ['星光练习营', '歌手'],
      intent: { label: '人物简介', terms: ['歌手'] },
      temporal: { mode: 'unspecified', asOf: null },
      lastStandaloneQuestion: QUESTION,
      verifiedClaims: [],
      citedSources: [],
    },
  });
  prior.messages.push(
    { role: 'user', content: QUESTION, at: '2026-09-02T00:00:00.000Z' },
    {
      role: 'assistant',
      content: '测试人物乙是中国内地歌手。',
      at: '2026-09-02T00:00:01.000Z',
    },
  );
  await value.conversations.save();

  const { task, created } = await runNormal(value, {
    prompt: '灯',
    conversationId: prior.id,
  });

  assert.equal(task.status, 'completed');
  assert.deepEqual(value.vaultQueries, []);
  assert.deepEqual(value.webQueries, []);
  assert.deepEqual(value.readerCalls, []);
  assert.deepEqual(value.extractorCalls, []);
  assert.deepEqual(value.modelCalls.map((call) => call.kind), ['contextualizer']);
  const diagnostic = task.events.find((event) => (
    event.type === 'diagnostic' && event.data?.code === 'LLM_EMPTY_RESPONSE'
  ));
  assert.ok(diagnostic);
  assert.match(diagnostic.data.message, /未返回可用 JSON/u);
  const completed = value.conversations.get('admin', created.conversationId);
  const answer = completed.messages.at(-1).content;
  assert.match(answer, /请.*(?:补充|说明|确认)|指的是/u);
  assert.equal(completed.researchContext.subject.name, '测试人物乙');
  assert.equal(completed.researchContext.lastStandaloneQuestion, QUESTION);
});

test('a real context-switch confirmation persists privately and yes consumes it once', async (t) => {
  const switchedQuestion = '演员测试人物乙是什么级别';
  const value = await fixture(t, {
    contextualizerResult: {
      standaloneQuestion: '演员测试人物乙在星光练习营是什么行业地位',
      subject: { name: '测试人物乙', type: 'person', aliases: [] },
      requiredAnchors: ['演员', '星光练习营'],
      intent: { label: '行业地位', terms: ['演员', '行业地位'] },
      temporal: { mode: 'unspecified', asOf: null },
      ambiguous: false,
      clarificationQuestion: '',
      queries: [],
    },
    finalText: '当前证据不足以判断该行业地位。',
  });
  const prior = value.conversations.create('admin', 'qa', {
    title: QUESTION,
    model: 'deepseek', effort: 'max', taskMode: 'normal', webSearch: true,
    researchContext: {
      subject: { name: '测试人物乙', type: 'person', aliases: [] },
      requiredAnchors: ['星光练习营'],
      intent: { label: '人物简介', terms: ['歌手'] },
      temporal: { mode: 'unspecified', asOf: null },
      lastStandaloneQuestion: QUESTION,
      verifiedClaims: [], citedSources: [],
    },
  });
  prior.messages.push(
    { role: 'user', content: QUESTION },
    { role: 'assistant', content: '测试人物乙是歌手。' },
  );
  await value.conversations.save();

  const first = await runNormal(value, {
    prompt: switchedQuestion,
    conversationId: prior.id,
    webSearch: true,
  });
  assert.equal(first.task.status, 'completed');
  assert.deepEqual(value.vaultQueries, []);
  const afterClarification = value.conversations.get('admin', prior.id);
  assert.equal(afterClarification.researchContext.subject.name, '测试人物乙');
  assert.equal(afterClarification.researchContext.pendingClarification.kind, 'context_switch');
  assert.equal(
    afterClarification.researchContext.pendingClarification.proposedState.standaloneQuestion,
    switchedQuestion,
  );

  const second = await runNormal(value, {
    prompt: '是的',
    conversationId: prior.id,
    webSearch: true,
  });
  assert.equal(second.task.status, 'completed');
  assert.equal(value.modelCalls.filter((call) => call.kind === 'contextualizer').length, 1);
  assert.equal(value.vaultQueries.length, 1);
  assert.equal(value.webQueries.length, 1);
  const completed = value.conversations.get('admin', prior.id);
  assert.equal(Object.hasOwn(completed.researchContext, 'pendingClarification'), false);
  assert.equal(completed.researchContext.lastStandaloneQuestion, switchedQuestion);
});

test('a WebSearch failure after start is not reported as a skipped search', async (t) => {
  const value = await fixture(t, { webSearchFailureAfterStart: true });
  const { task, created } = await runNormal(value);

  assert.equal(task.status, 'completed');
  assert.equal(value.webQueries.length, 1);
  const completed = value.conversations.get('admin', created.conversationId);
  const answer = completed.messages.at(-1).content;
  assert.match(answer, /联网搜索调用失败/u);
  assert.doesNotMatch(answer, /本次未执行新的联网搜索/u);
});

test('same-entity follow-up cannot cite tangential prior Web sources absent a current supporting claim', async (t) => {
  const resolved = {
    standaloneQuestion: '测试人物乙与灯是什么网络梗',
    subject: { name: '测试人物乙', type: 'person', aliases: ['ARTIST_A'] },
    requiredAnchors: ['星光练习营'],
    intent: { label: '网络梗', terms: ['灯', '网络梗'] },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  };
  const value = await fixture(t, {
    contextualizerResult: resolved,
    webSearchEmpty: true,
    finalText: '没有当前关系证据，但旧简介称其是歌手 [W1]。',
  });
  const prior = value.conversations.create('admin', 'qa', {
    title: QUESTION,
    model: 'deepseek',
    effort: 'max',
    taskMode: 'normal',
    webSearch: true,
    researchContext: {
      subject: { name: '测试人物乙', type: 'person', aliases: ['ARTIST_A'] },
      requiredAnchors: ['星光练习营'],
      intent: { label: '人物简介', terms: ['歌手'] },
      temporal: { mode: 'unspecified', asOf: null },
      lastStandaloneQuestion: QUESTION,
      verifiedClaims: [{
        text: '测试人物乙是歌手。', sourceIds: ['W1'], direct: true, asOf: null,
      }],
      citedSources: [{
        id: 'W1', title: '测试人物乙人物简介', url: 'https://example.com/old-biography',
        source: 'example.com', publishedAt: '2020-01-01',
      }],
    },
  });
  prior.messages.push(
    { role: 'user', content: QUESTION, at: '2026-09-02T00:00:00.000Z' },
    { role: 'assistant', content: '测试人物乙是歌手。', at: '2026-09-02T00:00:01.000Z' },
  );
  await value.conversations.save();

  const { task, created } = await runNormal(value, {
    prompt: '测试人物乙与灯是什么网络梗',
    conversationId: prior.id,
  });

  assert.equal(task.status, 'completed');
  const completed = value.conversations.get('admin', created.conversationId);
  const answer = completed.messages.at(-1).content;
  assert.doesNotMatch(answer, /old-biography|### 联网来源/u);
  assert.match(answer, /未核验来源/u);
  assert.deepEqual(completed.researchContext.citedSources, []);
  assert.deepEqual(completed.researchContext.verifiedClaims, []);
});
