import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversationStore } from '../src/conversation-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { temporaryProject } from './helpers.mjs';

const FIXED_NOW = Date.parse('2026-09-03T06:30:00.000Z');

async function fixture(t, { temporalAvailable = true } = {}) {
  const project = await temporaryProject('vaultmind-temporal-task-');
  t.after(project.cleanup);
  const calls = { temporal: [], search: [], web: [], model: [] };
  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 4, chunks: 4, semanticAvailable: false }),
    search: async (...args) => {
      calls.search.push(args);
      throw new Error('ordinary relevance search must not run for an mtime inventory');
    },
    close: async () => {},
  };
  if (temporalAvailable) {
    index.temporalInventory = async (query, options) => {
      calls.temporal.push({ query, options });
      return {
        route: 'mtime-inventory',
        query,
        results: [{
          path: 'learning/topic-a.md',
          content: '本文件记录主题 A 的学习进展。',
          snippet: '本文件记录主题 A 的学习进展。',
          matchedTerms: ['学习'],
          logicalKey: 'learning/topic-a.md',
          relatedPaths: [],
          mtimeMs: Date.parse('2026-08-28T08:00:00.000Z'),
          modifiedAt: '2026-08-28T08:00:00.000Z',
        }, {
          path: 'learning/topic-b.md',
          content: '本文件记录主题 B 的学习进展。',
          snippet: '本文件记录主题 B 的学习进展。',
          matchedTerms: ['学习'],
          logicalKey: 'learning/topic-b.md',
          relatedPaths: [],
          mtimeMs: Date.parse('2026-09-01T08:00:00.000Z'),
          modifiedAt: '2026-09-01T08:00:00.000Z',
        }, {
          path: 'learning/outside-window.md',
          content: '这条内容绝不能进入最终证据。',
          snippet: '这条内容绝不能进入最终证据。',
          matchedTerms: ['学习'],
          logicalKey: 'learning/outside-window.md',
          relatedPaths: [],
          mtimeMs: Date.parse('2026-07-01T08:00:00.000Z'),
          modifiedAt: '2026-07-01T08:00:00.000Z',
        }, {
          path: 'learning/display-time-only.md',
          content: '只有展示时间、没有可信数值 mtime 的内容绝不能进入证据。',
          snippet: '只有展示时间、没有可信数值 mtime 的内容绝不能进入证据。',
          matchedTerms: ['学习'],
          logicalKey: 'learning/display-time-only.md',
          relatedPaths: [],
          modifiedAt: '2026-08-29T08:00:00.000Z',
        }],
        inventory: {
          basis: 'file_mtime',
          range: options.range,
          scopeRequested: options.scope,
          scopeApplied: true,
          totalIndexedFiles: 4,
          eligiblePhysicalFiles: 3,
          inRangePhysicalFiles: 2,
          logicalFilesInRange: 2,
          returnedLogicalFiles: 2,
          invalidMtimeFiles: 0,
          metadataComplete: true,
          truncated: false,
          generation: 'fixture-generation',
        },
        diagnostics: { effectiveRoute: 'mtime-inventory', metadataComplete: true },
      };
    };
  }
  const webSearch = {
    publicStatus: () => ({ enabled: true, configured: true, provider: 'fixture-web' }),
    searchMany: async (...args) => {
      calls.web.push(args);
      throw new Error('WebSearch must not run for a private Vault mtime inventory');
    },
  };
  const llm = {
    generate: async (messages) => {
      calls.model.push(structuredClone(messages));
      return temporalAvailable
        ? '最近两周学习了主题 A 和主题 B [[learning/topic-a.md]] [[learning/topic-b.md]]。'
        : '当前索引无法提供可靠的文件更新时间盘点。';
    },
  };
  const conversations = new ConversationStore(project.config.conversationFile);
  const manager = new TaskManager({
    ...project.config,
    appName: 'Fixture',
    vaultLabel: 'Fixture Vault',
    timezone: 'Asia/Shanghai',
    modelCatalog: [{
      id: 'fixture',
      label: 'Fixture',
      actualModel: 'fixture-model',
      provider: 'fixture',
      efforts: ['default'],
      defaultEffort: 'default',
      available: true,
    }],
    llm: {
      provider: 'fixture', model: 'fixture-model', timeoutMs: 1_000,
      maxOutputTokens: 2_048, temperature: 0,
    },
    embedding: { provider: 'disabled', timeoutMs: 1_000 },
    retrieval: { topK: 8, maxContextChars: 20_000 },
    deep: { enabled: true, topK: 12 },
    research: { contextualizerEnabled: true, loopEnabled: true },
    webSearch: {
      enabled: true, resultCount: 15, deepResultCount: 6,
      maxResultsPerDomain: 2, modelSourceLimit: 10,
      maxContextChars: 30_000, timeoutMs: 1_000,
    },
    webReader: { enabled: false, normalMaxPages: 2, totalMaxChars: 40_000 },
    responsesFallback: { enabled: false, timeoutMs: 1_000 },
  }, {
    allowLegacyTestEngine: true,
    now: () => FIXED_NOW,
    index,
    store: {
      ready: Promise.resolve(),
      cleanupDrafts: async () => {},
      auditBestEffort: async () => [],
    },
    conversations,
    llm,
    webSearch,
    webReader: {
      publicStatus: () => ({ enabled: false, configured: false }),
      readMany: async () => ({ documents: [], attempts: [], errors: [] }),
    },
    responsesExtractor: {
      publicStatus: () => ({ enabled: false, configured: false }),
      extract: async () => ({ text: '', extractedSourceIds: [], attempts: [], errors: [] }),
    },
  });
  t.after(() => manager.close());
  await manager.ready;
  return { manager, conversations, calls };
}

test('Deep modified learning notes inventory uses one complete mtime scan and never WebSearch', async (t) => {
  const value = await fixture(t);
  const created = await value.manager.createTask('admin', {
    kind: 'qa',
    prompt: '这两周我的知识库中修改了哪些学习笔记',
    taskMode: 'deep',
    model: 'fixture',
    effort: 'default',
    webSearch: true,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(value.calls.temporal.length, 1);
  assert.equal(value.calls.search.length, 0);
  assert.equal(value.calls.web.length, 0);
  assert.equal(value.calls.model.length, 1, 'no contextualizer, Deep planner, or evaluator is needed');
  assert.equal(value.calls.temporal[0].options.scope, 'learning');
  assert.equal(
    value.calls.temporal[0].options.range.startInclusive,
    '2026-08-20T16:00:00.000Z',
  );
  assert.equal(
    value.calls.temporal[0].options.range.endExclusive,
    '2026-09-03T06:30:00.001Z',
  );
  const finalPrompt = value.calls.model[0].at(-1).content;
  assert.match(finalPrompt, /basis="file_mtime"/u);
  assert.match(finalPrompt, /timezone="Asia\/Shanghai"/u);
  assert.match(finalPrompt, /start_inclusive="2026-08-20T16:00:00.000Z"/u);
  assert.match(finalPrompt, /end_exclusive="2026-09-03T06:30:00.001Z"/u);
  assert.match(finalPrompt, /learning\/topic-a\.md/u);
  assert.match(finalPrompt, /learning\/topic-b\.md/u);
  assert.doesNotMatch(finalPrompt, /outside-window/u);
  assert.doesNotMatch(finalPrompt, /display-time-only/u);
  assert.ok(task.events.some((event) => (
    event.data?.title === '联网搜索已跳过' && event.data?.stage === 'skipped'
  )));
  const stored = value.conversations.get('admin', created.conversationId);
  assert.doesNotMatch(stored.messages.at(-1).content, /覆盖不完整/u);
});

test('an older or mock index without temporal metadata fails closed with an explicit warning', async (t) => {
  const value = await fixture(t, { temporalAvailable: false });
  const created = await value.manager.createTask('admin', {
    kind: 'qa',
    prompt: '这两周我的知识库中修改了哪些学习笔记',
    taskMode: 'normal',
    model: 'fixture',
    effort: 'default',
    webSearch: false,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(value.calls.search.length, 0, 'must not leak out-of-window search hits as a fallback');
  assert.equal(value.calls.web.length, 0);
  assert.equal(value.calls.model.length, 1);
  assert.match(value.calls.model[0].at(-1).content, /metadata_complete="false"/u);
  assert.match(value.calls.model[0].at(-1).content, /Do not describe this as a complete inventory/u);
  const stored = value.conversations.get('admin', created.conversationId);
  assert.match(stored.messages.at(-1).content, /时间盘点覆盖不完整/u);
  assert.ok(task.events.some((event) => (
    event.data?.toolName === 'vault_mtime_inventory' && event.data?.stage === 'error'
  )));
});

test('an unsupported private relative period asks for clarification without RAG, Web, or LLM calls', async (t) => {
  const value = await fixture(t);
  const created = await value.manager.createTask('admin', {
    kind: 'qa',
    prompt: '最近一个季度我学习了什么',
    taskMode: 'deep',
    model: 'fixture',
    effort: 'default',
    webSearch: true,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(value.calls.temporal.length, 0);
  assert.equal(value.calls.search.length, 0);
  assert.equal(value.calls.web.length, 0);
  assert.equal(value.calls.model.length, 0);
  const stored = value.conversations.get('admin', created.conversationId);
  assert.match(stored.messages.at(-1).content, /无法把这个相对时间表达安全转换/u);
  assert.match(stored.messages.at(-1).content, /不会用普通相关度检索或联网结果代替/u);
  assert.ok(task.events.some((event) => (
    event.data?.toolName === 'temporal_range_parser' &&
      event.data?.stage === 'clarification' &&
      event.data?.diagnostics?.queryCount === 0
  )));
});
