import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversationStore } from '../src/conversation-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { temporaryProject } from './helpers.mjs';

const QUESTION = '甲州投控集团董事长是谁';
const SOURCE_URL = 'https://www.city-a.gov.cn/official-appointment';

function contextualizerResult() {
  return JSON.stringify({
    standaloneQuestion: QUESTION,
    subject: { name: '甲州投控集团', type: 'organization', aliases: ['甲州投控集团'] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '现任董事长', terms: ['董事长', '任命'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  });
}

async function fixture(t, options = {}) {
  const project = await temporaryProject('research-audit-lifecycle-');
  t.after(project.cleanup);
  const audits = [];
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 0, chunks: 0, semanticAvailable: false }),
    search: async () => ({ route: 'lexical', results: [], diagnostics: {} }),
  };
  const store = {
    ready: Promise.resolve(),
    cleanupDrafts: async () => {},
    auditBestEffort: options.auditBestEffort || (async (entry) => { audits.push(entry); return []; }),
  };
  let llmCall = 0;
  const llm = {
    generate: async (messages) => {
      llmCall += 1;
      const system = String(messages[0]?.content || '');
      if (system.includes('conversation contextualizer')) return contextualizerResult();
      if (system.includes('evidence evaluator')) {
        return JSON.stringify({
          sufficient: true, confidence: 0.9, claims: [], conflicts: [], gaps: [],
          nextQueries: [], readSourceIds: [],
        });
      }
      if (options.finalError) throw options.finalError;
      return '甲州投控集团董事长为测试人物甲。[W1]';
    },
  };
  const webSearch = options.webSearch || {
    publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
    searchMany: async (queries, callOptions) => {
      callOptions.onActivity?.({
        stage: 'start', index: 0, total: 1, queryIndex: 0, query: queries[0],
      });
      callOptions.onActivity?.({
        stage: 'complete', index: 0, total: 1, queryIndex: 0, resultCount: 1,
      });
      const source = {
        title: '甲州投控集团任免信息',
        url: SOURCE_URL,
        snippet: '甲州投控集团董事长任命',
        source: '甲州政府',
        publishedAt: '2026-08-01',
        queryIndex: 0,
      };
      return {
        results: [source], candidates: [source], evidenceCandidates: [source],
        attempts: [{ queryHash: 'provider-query-hash', status: 'completed', resultCount: 1, durationMs: 7 }],
        errors: [], queryCount: 1,
      };
    },
  };
  const webReader = options.webReader || {
    publicStatus: () => ({ enabled: true, configured: true }),
    readMany: async ({ sourceIds, onActivity }) => {
      onActivity?.({ stage: 'start', sourceId: sourceIds[0], index: 0, total: 1 });
      onActivity?.({
        stage: 'error', sourceId: sourceIds[0], index: 0, total: 1,
        code: 'WEB_READ_UPSTREAM_FAILED',
      });
      return {
        documents: [],
        attempts: [{
          sourceId: sourceIds[0], urlHash: 'reader-url-hash', status: 'failed',
          durationMs: 9, errorCode: 'WEB_READ_UPSTREAM_FAILED',
        }],
        errors: [{ sourceId: sourceIds[0], code: 'WEB_READ_UPSTREAM_FAILED' }],
      };
    },
  };
  const responsesExtractor = options.responsesExtractor || {
    publicStatus: () => ({ enabled: true, configured: true }),
    extract: async ({ sourceIds, onActivity }) => {
      onActivity?.({ stage: 'start', sourceCount: 1, billable: true });
      onActivity?.({
        stage: 'complete', sourceCount: 1, billable: true,
        toolCounts: { webSearch: 1, webExtractor: 1 },
      });
      return {
        text: '任免正文：测试人物甲任党委书记、董事长。',
        extractedSourceIds: [sourceIds[0]],
        toolCounts: { webSearch: 1, webExtractor: 1 },
        attempts: [{
          status: 'completed', sourceCount: 1, durationMs: 11,
          toolCounts: { webSearch: 1, webExtractor: 1 },
        }],
        errors: [],
      };
    },
  };
  const config = {
    ...project.config,
    vaultLabel: 'Fixture Vault',
    modelCatalog: [{
      id: 'qwen', label: 'Qwen', actualModel: 'qwen-fixture', provider: 'fixture',
      efforts: ['medium'], defaultEffort: 'medium', available: true,
    }],
    llm: {
      provider: 'fixture', model: 'qwen-fixture', timeoutMs: 1_000,
      maxOutputTokens: 2_048, temperature: 0,
    },
    retrieval: { topK: 8, maxContextChars: 20_000 },
    deep: { enabled: true, topK: 12 },
    research: { contextualizerEnabled: true, loopEnabled: true },
    webSearch: {
      enabled: true, resultCount: 15, deepResultCount: 6, maxResultsPerDomain: 2,
      modelSourceLimit: 10, maxContextChars: 30_000, timeoutMs: 1_000,
    },
    webReader: { enabled: true, normalMaxPages: 2, totalMaxChars: 40_000 },
    responsesFallback: { enabled: true, timeoutMs: 1_000 },
  };
  const manager = new TaskManager(config, {
    index, store, llm, webSearch, webReader, responsesExtractor, conversations,
  });
  t.after(() => manager.close());
  await manager.ready;
  if (options.failFinalCommit) {
    conversations.commitExisting = async () => {
      const error = new Error('fixture conversation save failure');
      error.code = 'FIXTURE_SAVE_FAILED';
      throw error;
    };
  }
  return { manager, conversations, audits, getLlmCalls: () => llmCall };
}

async function runTask(value) {
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: QUESTION, model: 'qwen', effort: 'medium', webSearch: true,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;
  return task;
}

function assertMetadataOnly(audit) {
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(serialized, /甲州|投控集团|official-appointment|任免正文/u);
  assert.doesNotMatch(serialized, /https?:\/\//u);
}

test('research audit retains Web, page-read, and fallback metadata when final generation times out', async (t) => {
  const error = new Error('final model fixture timeout');
  error.code = 'LLM_TIMEOUT';
  const value = await fixture(t, { finalError: error });
  const task = await runTask(value);

  assert.equal(task.status, 'failed');
  assert.equal(value.audits.length, 1);
  const audit = value.audits[0];
  assert.equal(audit.status, 'failed');
  assert.equal(audit.taskStatus, 'failed');
  assert.equal(audit.stopReason, 'LLM_TIMEOUT');
  assert.equal(audit.attemptedCalls, 1);
  assert.deepEqual(audit.attempts, [{
    queryHash: 'provider-query-hash', queryIndex: 0, status: 'completed',
    resultCount: 1, durationMs: 7, errorCode: '',
  }]);
  assert.equal(audit.pageReads.length, 1);
  assert.equal(audit.pageReads[0].sourceLevel, 'government_or_appointment');
  assert.equal(audit.pageReads[0].status, 'failed');
  assert.equal(audit.fallback.attemptedCalls, 1);
  assert.equal(audit.fallback.status, 'failed');
  assert.deepEqual(audit.fallback.toolCounts, { webSearch: 1, webExtractor: 1 });
  assert.equal(audit.fallback.attempts[0].status, 'failed');
  assert.deepEqual(audit.fallback.errorCodes, [
    'BAILIAN_EXTRACTOR_UNATTRIBUTED_SEARCH_CONTENT',
  ]);
  assertMetadataOnly(audit);
});

test('research audit is written once after a paid path even when conversation commit fails', async (t) => {
  const value = await fixture(t, { failFinalCommit: true });
  const task = await runTask(value);

  assert.equal(task.status, 'failed');
  assert.equal(value.audits.length, 1);
  assert.equal(value.audits[0].taskStatus, 'failed');
  assert.equal(value.audits[0].stopReason, 'CONVERSATION_PERSIST_FAILED');
  assert.equal(value.audits[0].fallback.attemptedCalls, 1);
  assertMetadataOnly(value.audits[0]);
});

test('Responses fallback calls one verified URL at a time and rejects web_search-tainted text', async (t) => {
  const calls = [];
  const responsesExtractor = {
    publicStatus: () => ({ enabled: true, configured: true }),
    extract: async ({ sources, sourceIds }) => {
      calls.push({ sources: sources.map((source) => source.id), sourceIds: [...sourceIds] });
      const tainted = sourceIds[0] === 'W2';
      return {
        text: tainted ? 'This may include unrelated search facts.' : 'Direct page extraction.',
        extractedSourceIds: [sourceIds[0]],
        toolCounts: { webSearch: tainted ? 1 : 0, webExtractor: 1 },
        attempts: [{
          status: 'completed', sourceCount: 1, durationMs: 1,
          toolCounts: { webSearch: tainted ? 1 : 0, webExtractor: 1 },
        }],
        errors: [],
      };
    },
  };
  const value = await fixture(t, { responsesExtractor });
  const task = {
    events: [], clients: new Set(), abortController: new AbortController(),
    researchAuditState: null, updatedAt: new Date().toISOString(),
  };
  const sources = [
    { id: 'W1', url: 'https://official.example/one', title: 'One' },
    { id: 'W2', url: 'https://official.example/two', title: 'Two' },
  ];
  const result = await value.manager.runResponsesFallback(task, sources, ['W1', 'W2'], {
    standaloneQuestion: QUESTION,
    subject: { name: '甲州投控集团' },
    requiredAnchors: ['甲州'],
  }, 100);

  assert.deepEqual(calls, [
    { sources: ['W1'], sourceIds: ['W1'] },
    { sources: ['W2'], sourceIds: ['W2'] },
  ]);
  assert.deepEqual(result.documents.map((document) => document.sourceIds), [['W1']]);
  assert.equal(result.documents[0].text, 'Direct page extraction.');
  assert.equal(result.attempts[0].status, 'completed');
  assert.equal(result.attempts[1].status, 'failed');
  assert.equal(result.errors.some((error) => (
    error.code === 'BAILIAN_EXTRACTOR_UNATTRIBUTED_SEARCH_CONTENT'
  )), true);
  assert.deepEqual(result.toolCounts, { webSearch: 1, webExtractor: 2 });
});

test('Responses fallback stops before another paid call once document budget is full', async (t) => {
  const calls = [];
  const responsesExtractor = {
    publicStatus: () => ({ enabled: true, configured: true }),
    extract: async ({ sourceIds }) => {
      calls.push(sourceIds[0]);
      return {
        text: '123456789', extractedSourceIds: [sourceIds[0]],
        toolCounts: { webSearch: 0, webExtractor: 1 },
        attempts: [{
          status: 'completed', sourceCount: 1, durationMs: 1,
          toolCounts: { webSearch: 0, webExtractor: 1 },
        }],
        errors: [],
      };
    },
  };
  const value = await fixture(t, { responsesExtractor });
  const task = {
    events: [], clients: new Set(), abortController: new AbortController(),
    researchAuditState: null, updatedAt: new Date().toISOString(),
  };
  const sources = ['W1', 'W2', 'W3'].map((id) => ({
    id, url: `https://official.example/${id}`, title: id,
  }));
  const state = {
    standaloneQuestion: QUESTION, subject: { name: '甲州投控集团' },
    requiredAnchors: ['甲州'],
  };
  const result = await value.manager.runResponsesFallback(
    task, sources, ['W1', 'W2', 'W3'], state, 5,
  );
  assert.deepEqual(calls, ['W1']);
  assert.equal(result.documents[0].text, '12345');

  const noBudget = await value.manager.runResponsesFallback(task, sources, ['W2'], state, 0);
  assert.deepEqual(calls, ['W1']);
  assert.deepEqual(noBudget.documents, []);
  assert.deepEqual(noBudget.attempts, []);
});

test('an in-flight Web Search attempt is audited when the task is cancelled', async (t) => {
  let started;
  const searchStarted = new Promise((resolve) => { started = resolve; });
  const webSearch = {
    publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
    searchMany: async (queries, { signal, onActivity }) => {
      onActivity?.({ stage: 'start', index: 0, total: 1, queryIndex: 0, query: queries[0] });
      started();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
          once: true,
        });
      });
      return { evidenceCandidates: [], attempts: [], errors: [], queryCount: 1 };
    },
  };
  const value = await fixture(t, { webSearch });
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: QUESTION, model: 'qwen', effort: 'medium', webSearch: true,
  });
  await searchStarted;
  value.manager.cancel('admin', created.taskId);
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'cancelled');
  assert.equal(value.audits.length, 1);
  const audit = value.audits[0];
  assert.equal(audit.status, 'cancelled');
  assert.equal(audit.taskStatus, 'cancelled');
  assert.equal(audit.stopReason, 'TASK_CANCELLED');
  assert.equal(audit.attemptedCalls, 1);
  assert.equal(audit.attempts[0].status, 'cancelled');
  assert.equal(audit.attempts[0].queryHash.length, 64);
  assertMetadataOnly(audit);
});

test('successful research writes exactly one audit record and audit sink failure is non-fatal', async (t) => {
  const value = await fixture(t);
  const task = await runTask(value);
  assert.equal(task.status, 'completed');
  assert.equal(value.audits.length, 1);

  let calls = 0;
  const failing = await fixture(t, {
    auditBestEffort: async () => { calls += 1; throw new Error('audit sink unavailable'); },
  });
  const successful = await runTask(failing);
  assert.equal(successful.status, 'completed');
  assert.equal(calls, 1);
});
