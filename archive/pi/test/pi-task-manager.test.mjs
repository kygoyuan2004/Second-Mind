import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ConversationStore } from '../src/conversation-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { VaultStore } from '../../../src/vault-store.mjs';
import { temporaryProject } from '../../../test/helpers.mjs';

const NOW = Date.parse('2026-09-06T04:00:00.000Z');

function managerConfig(project) {
  return {
    ...project.config,
    appName: 'Pi executor fixture',
    vaultLabel: 'Fixture Vault',
    timezone: 'Asia/Shanghai',
    modelCatalog: [{
      id: 'fixture', label: 'Fixture', actualModel: 'fixture-model', provider: 'fixture',
      efforts: ['low', 'high'], defaultEffort: 'high', available: true,
    }],
    llm: {
      provider: 'fixture', model: 'fixture-model', timeoutMs: 2_000,
      maxOutputTokens: 4_096, temperature: 0,
    },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 8, maxContextChars: 20_000 },
    deep: { enabled: true, topK: 12 },
    research: { contextualizerEnabled: false },
    webSearch: { enabled: false },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
}

function indexFixture() {
  const calls = { acquired: 0, released: 0, searches: [], temporal: [] };
  const result = {
    path: 'learning/topic.md',
    content: '记录了本月的学习重点。',
    snippet: '记录了本月的学习重点。',
    matchedTerms: ['学习'],
    logicalKey: 'learning/topic.md',
    relatedPaths: [],
    mtimeMs: Date.parse('2026-08-20T08:00:00.000Z'),
    modifiedAt: '2026-08-20T08:00:00.000Z',
  };
  const snapshot = {
    generation: 'fixture-generation',
    status: () => ({ available: true, files: 1, chunks: 1 }),
    async search(query, options) {
      calls.searches.push({ query, options });
      return { route: 'keyword', query, results: [result], diagnostics: {} };
    },
    async temporalInventory(query, options) {
      calls.temporal.push({ query, options });
      return {
        route: 'mtime-inventory', query, results: [result],
        inventory: {
          basis: 'file_mtime', range: options.range, scopeRequested: options.scope,
          scopeApplied: true, logicalFilesInRange: 1, returnedLogicalFiles: 1,
          invalidMtimeFiles: 0, metadataComplete: true, truncated: false,
          generation: 'fixture-generation',
        },
        diagnostics: { effectiveRoute: 'mtime-inventory', metadataComplete: true },
      };
    },
    listDocuments() {
      return [{ path: 'daily_doc/日记/2026-09-05.md', hash: 'fixture', size: 24 }];
    },
    async readDocument(path) {
      assert.equal(path, 'daily_doc/日记/2026-09-05.md');
      return { path, hash: 'fixture', text: '- [x] 已完成 CS336 Assignment 1。' };
    },
    release() { calls.released += 1; },
  };
  return {
    calls,
    index: {
      ready: Promise.resolve(),
      status: () => ({ available: true, files: 1, chunks: 1 }),
      acquireSnapshot() { calls.acquired += 1; return snapshot; },
      close: async () => {},
    },
  };
}

async function fixture(t, options = {}) {
  const project = options.project || await temporaryProject('second-mind-pi-executor-');
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = indexFixture();
  const calls = { model: [], agent: 0 };
  const llm = {
    mapsRequestedEffort: true,
    async generate(messages, generationOptions) {
      calls.model.push({
        messages: structuredClone(messages),
        options: { ...generationOptions },
      });
      if (options.modelError) throw options.modelError;
      const system = String(messages[0]?.content || '');
      let answer = '固定流水线生成的回答 [[learning/topic.md]]。';
      if (system.includes('个人学习回顾的证据抽取器')) {
        const input = JSON.parse(messages[1].content);
        const segment = input.segments[0];
        answer = JSON.stringify({ facts: [{
          topic: 'CS336', statement: '已完成 CS336 Assignment 1。', status: 'completed',
          evidence: [{ segmentId: segment.id, path: segment.path,
            lineStart: segment.lineStart, lineEnd: segment.lineStart,
            quote: '- [x] 已完成 CS336 Assignment 1。' }],
        }] });
      } else if (system.includes('按学习方向组织已核验事实')) {
        answer = JSON.stringify({ groups: [{ title: 'CS336', factIds: ['F1'] }] });
      }
      generationOptions.onToken?.(answer);
      return answer;
    },
  };
  const forbiddenAgent = {
    supports() { calls.agent += 1; assert.fail('TaskManager must not inspect an Agent loop.'); },
    async runQa() { calls.agent += 1; assert.fail('TaskManager must not enter Pi runQa.'); },
    async runDraft() { calls.agent += 1; assert.fail('TaskManager must not enter Pi runDraft.'); },
  };
  const manager = new TaskManager(managerConfig(project), {
    now: () => NOW,
    index: index.index,
    store: options.store || {
      ready: Promise.resolve(), cleanupDrafts: async () => {}, auditBestEffort: async () => [],
    },
    llm,
    conversations,
    piAgent: forbiddenAgent,
  });
  t.after(async () => {
    await manager.close();
    await project.cleanup();
  });
  await manager.ready;
  return { project, manager, conversations, index, calls };
}

test('QA keeps server-side retrieval and uses Pi only through the model lease generate call', async (t) => {
  const value = await fixture(t);
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: '解释 topic 的内容', model: 'fixture', effort: 'high',
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(value.index.calls.searches.length, 1);
  assert.equal(value.calls.model.length, 1);
  assert.equal(value.calls.agent, 0);
  assert.equal(task.agentMetrics, undefined);
  assert.equal(value.index.calls.acquired, 1);
  assert.equal(value.index.calls.released, 1);
  assert.equal(value.calls.model[0].options.effort, 'high');
  const status = await value.manager.publicStatus('admin');
  assert.equal(status.capabilities.piExecutor, true);
  assert.equal(status.capabilities.autonomousTools, false);
});

test('monthly-learning wording uses the bounded deterministic review and preserves its range for 所有', async (t) => {
  const value = await fixture(t);
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: '总结最近一个月的学习重点', model: 'fixture', effort: 'high',
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(value.index.calls.temporal.length, 0);
  assert.equal(value.index.calls.searches.length, 1, 'topic expansion uses ordinary index search');
  assert.equal(value.calls.model.length, 2, 'one extraction and one grouping call');
  assert.equal(value.calls.agent, 0);
  assert.equal(task.learningReview.kind, 'learning_review');
  assert.equal(task.taskMode.maxModelCalls, 50);
  assert.equal(task.taskMode.timeoutMs, 30 * 60_000);
  assert.match(task.events.find((event) => event.type === 'text')?.data.text || '', /CS336[\s\S]*2026-09-05/u);

  const followup = await value.manager.createTask('admin', {
    kind: 'qa', prompt: '所有', conversationId: created.conversationId,
    model: 'fixture', effort: 'high',
  });
  const followupTask = value.manager.getTask('admin', followup.taskId);
  await followupTask.runPromise;
  assert.equal(followupTask.status, 'completed');
  assert.deepEqual(followupTask.learningReview.range, task.learningReview.range);
  assert.equal(value.calls.agent, 0);
});

test('draft generation stays on the existing preview/confirm flow and never enters Pi Agent', async (t) => {
  const project = await temporaryProject('second-mind-pi-draft-');
  const store = new VaultStore(project.config);
  const value = await fixture(t, { project, store });
  const target = path.join(value.project.vaultPath, value.project.config.paths.diary, '2026-09-06.md');
  const created = await value.manager.createTask('admin', {
    kind: 'diary', date: '2026-09-06', prompt: '记录今天的重构', model: 'fixture', effort: 'high',
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(value.calls.model.length, 1);
  assert.equal(value.calls.agent, 0);
  assert.equal(await fsp.stat(target).then(() => true, () => false), false);
  const preview = task.events.find((event) => event.type === 'draft_ready');
  assert(preview);
  const saved = await store.saveDraft('admin', preview.data.id, { content: preview.data.content });
  assert.equal(saved.path, `${value.project.config.paths.diary}/2026-09-06.md`);
});

test('a broken provider fails the review task instead of saving an empty success answer', async (t) => {
  const value = await fixture(t, { modelError: Object.assign(new Error('Synthetic missing model'), {
    code: 'LLM_MODEL_NOT_FOUND', status: 400,
  }) });
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: '总结我最近一个月的学习重点', model: 'fixture', effort: 'high',
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;
  assert.equal(task.status, 'failed');
  assert.equal(value.calls.model.length, 1);
  assert.equal(task.events.some((event) => event.type === 'text'), false);
  assert.equal(value.index.calls.released, 1);
});

test('normal and deep retain the original 20/50 model-call and 10m/30m task ceilings', async (t) => {
  const value = await fixture(t);
  const normal = { modelCallSequence: 0, taskMode: { id: 'normal', maxModelCalls: 20 } };
  for (let index = 0; index < 20; index += 1) value.manager.nextModelCall(normal, 'fixture');
  assert.throws(
    () => value.manager.nextModelCall(normal, 'fixture'),
    { code: 'MODEL_CALL_BUDGET_EXCEEDED', status: 429 },
  );

  const status = await value.manager.publicStatus('admin');
  assert.deepEqual(
    status.taskModes.map(({ id, timeoutMs, maxModelCalls }) => ({ id, timeoutMs, maxModelCalls })),
    [
      { id: 'normal', timeoutMs: 10 * 60_000, maxModelCalls: 20 },
      { id: 'deep', timeoutMs: 30 * 60_000, maxModelCalls: 50 },
    ],
  );
});
