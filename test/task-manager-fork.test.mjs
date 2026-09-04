import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import test from 'node:test';

import { ConversationStore } from '../src/conversation-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { temporaryProject } from './helpers.mjs';

const MODELS = [
  {
    id: 'qwen',
    label: 'Qwen fixture',
    actualModel: 'qwen-fixture',
    efforts: ['medium'],
    defaultEffort: 'medium',
    available: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek fixture',
    actualModel: 'deepseek-fixture',
    efforts: ['medium'],
    defaultEffort: 'medium',
    available: true,
  },
];

async function forkFixture(t, { modelCatalog = MODELS } = {}) {
  const project = await temporaryProject('vaultmind-task-fork-');
  const conversations = new ConversationStore(project.config.conversationFile);
  const calls = [];
  const indexQueries = [];
  const manager = new TaskManager({
    ...project.config,
    appName: 'Fork fixture',
    vaultLabel: 'Fixture Vault',
    timezone: 'UTC',
    modelCatalog,
    llm: {
      provider: 'anthropic',
      model: 'qwen-fixture',
      maxOutputTokens: 4_096,
      temperature: null,
    },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 8, maxContextChars: 20_000 },
    deep: { enabled: true, topK: 12 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  }, {
    conversations,
    index: {
      ready: Promise.resolve(),
      status: () => ({ available: true, files: 1, chunks: 1, semanticAvailable: false }),
      search: async (query) => {
        indexQueries.push(query);
        return {
          route: 'keyword',
          results: [{ path: 'vault/source.md', content: `Evidence for ${query}` }],
          diagnostics: {},
        };
      },
      close: async () => {},
    },
    store: {
      ready: Promise.resolve(),
      cleanupDrafts: async () => {},
      auditBestEffort: async () => [],
    },
    llm: {
      generate: async (messages, options = {}) => {
        calls.push({ messages, options });
        const system = messages.find((message) => message.role === 'system')?.content || '';
        if (system.includes('bounded search queries')) {
          return JSON.stringify({
            queries: [
              '甲州投控集团 测试人物甲 行政级别',
              '甲州组织部 测试人物甲 任前公示',
            ],
          });
        }
        const answer = 'Fixture answer [[vault/source.md]].';
        options.onToken?.(answer);
        return answer;
      },
    },
    webSearch: {
      publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
      searchMany: async (queries) => ({
        results: [], candidates: [], attempts: [], errors: [], queryCount: queries.length,
      }),
    },
  });
  await manager.ready;
  t.after(async () => {
    manager.close();
    await project.cleanup();
  });
  return { project, conversations, manager, calls, indexQueries };
}

function createPopulatedParent(conversations) {
  const parent = conversations.create('admin', 'qa', {
    title: '甲州投控集团董事长是谁',
    model: 'qwen',
    effort: 'medium',
    taskMode: 'normal',
    webSearch: false,
    researchContext: {
      subject: { name: '测试人物甲', type: 'person', aliases: ['测试董事长甲'] },
      requiredAnchors: ['甲州', '投控集团'],
      intent: { label: '现任职务', terms: ['董事长', '任命'] },
      temporal: { mode: 'current', asOf: null },
      lastStandaloneQuestion: '甲州投控集团董事长是谁',
      verifiedClaims: [{
        text: '测试人物甲担任甲州投控集团党委书记、董事长。',
        sourceIds: ['W1'],
        direct: true,
      }],
      citedSources: [{
        id: 'W1',
        title: '任免公告',
        url: 'https://www.city-a.gov.cn/appointment',
        source: '甲州政府',
      }],
    },
  });
  for (let index = 1; index <= 7; index += 1) {
    parent.messages.push(
      { role: 'user', content: `question-${index}`, at: `2026-01-${String(index).padStart(2, '0')}T00:00:00.000Z` },
      { role: 'assistant', content: `answer-${index}`, at: `2026-01-${String(index).padStart(2, '0')}T00:01:00.000Z` },
    );
  }
  parent.messages.push({ role: 'user', content: 'unfinished-question' });
  return parent;
}

test('task creation API rejects conflicting references with 400 and unchanged-setting forks with 409', async (t) => {
  const { manager, conversations } = await forkFixture(t);
  const parent = createPopulatedParent(conversations);
  const before = structuredClone(parent);

  await assert.rejects(
    () => manager.createTask('admin', {
      kind: 'qa',
      prompt: 'conflicting references',
      conversationId: parent.id,
      forkFromConversationId: parent.id,
      model: 'deepseek',
      effort: 'medium',
    }),
    (error) => error?.status === 400 && error?.code === 'CONVERSATION_REFERENCE_CONFLICT',
  );
  await assert.rejects(
    () => manager.createTask('admin', {
      kind: 'qa',
      prompt: 'unchanged settings',
      forkFromConversationId: parent.id,
      model: 'qwen',
      effort: 'medium',
      webSearch: false,
    }),
    (error) => error?.status === 409 && error?.code === 'FORK_SETTINGS_UNCHANGED',
  );

  assert.deepEqual(parent, before);
  assert.equal(manager.tasks.size, 0);
  assert.equal(conversations.list('admin').length, 1);
});

test('a fixed-setting change atomically creates a child with five complete turns and private research context', async (t) => {
  const { manager, conversations } = await forkFixture(t);
  const parent = createPopulatedParent(conversations);
  await conversations.save();
  const parentBefore = structuredClone(parent);
  const parentResearch = conversations.getResearchContext('admin', parent.id);

  const created = await manager.createTask('admin', {
    kind: 'qa',
    prompt: '测试人物甲是什么级别',
    taskMode: 'deep',
    forkFromConversationId: parent.id,
    model: 'deepseek',
    effort: 'medium',
    webSearch: false,
  });
  const task = manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.notEqual(created.conversationId, parent.id);
  assert.equal(created.forkedFromConversationId, parent.id);
  assert.equal(created.taskMode, 'deep');
  const child = conversations.get('admin', created.conversationId);
  assert.equal(child.parentConversationId, parent.id);
  assert.ok(child.forkedAt);
  assert.equal(child.model, 'deepseek');
  assert.equal(child.taskMode, 'deep');
  assert.deepEqual(child.messages.map((message) => message.content), [
    'question-3', 'answer-3',
    'question-4', 'answer-4',
    'question-5', 'answer-5',
    'question-6', 'answer-6',
    'question-7', 'answer-7',
    '测试人物甲是什么级别',
    'Fixture answer [[vault/source.md]].',
  ]);
  assert.deepEqual(conversations.getResearchContext('admin', child.id), parentResearch);
  assert.deepEqual(parent, parentBefore, 'forking and completing the child must not mutate the parent');

  assert.equal(manager.publicTask(task).forkedFromConversationId, parent.id);
  assert.equal(manager.publicTask(task).conversationId, child.id);
  const session = task.events.find((event) => event.type === 'session');
  assert.equal(session?.data.forkedFromConversationId, parent.id);
  assert.equal(session?.data.taskMode, 'deep');
  const done = task.events.findLast((event) => event.type === 'done');
  assert.equal(done?.data.forkedFromConversationId, parent.id);
  assert.equal(done?.data.conversationId, child.id);

  const publicChild = manager.getConversation('admin', child.id);
  assert.equal(publicChild.parentConversationId, parent.id);
  assert.equal(Object.hasOwn(publicChild, 'researchContext'), false);
});

test('a deleted parent model can only continue through an explicit fork to a current model', async (t) => {
  const { manager, conversations } = await forkFixture(t, {
    modelCatalog: [MODELS[1]],
  });
  const parent = createPopulatedParent(conversations);
  await conversations.save();
  const parentBefore = structuredClone(parent);
  const parentResearch = conversations.getResearchContext('admin', parent.id);

  await assert.rejects(
    () => manager.createTask('admin', {
      kind: 'qa',
      prompt: '普通续聊不能静默换模型',
      conversationId: parent.id,
      model: 'deepseek',
      effort: 'medium',
    }),
    (error) => error?.status === 409 && error?.code === 'CONVERSATION_SETTINGS_CHANGED',
  );
  await assert.rejects(
    () => manager.createTask('admin', {
      kind: 'qa',
      prompt: '没有指定替代模型也不能派生',
      forkFromConversationId: parent.id,
    }),
    (error) => error?.status === 409 && error?.code === 'CONVERSATION_SETTINGS_CHANGED',
  );

  const created = await manager.createTask('admin', {
    kind: 'qa',
    prompt: '使用当前模型继续追问',
    forkFromConversationId: parent.id,
    model: 'deepseek',
    effort: 'medium',
    webSearch: false,
  });
  const task = manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(created.forkedFromConversationId, parent.id);
  const child = conversations.get('admin', created.conversationId);
  assert.equal(child.parentConversationId, parent.id);
  assert.equal(child.model, 'deepseek');
  assert.deepEqual(child.messages.slice(0, 10).map((message) => message.content), [
    'question-3', 'answer-3',
    'question-4', 'answer-4',
    'question-5', 'answer-5',
    'question-6', 'answer-6',
    'question-7', 'answer-7',
  ]);
  assert.deepEqual(conversations.getResearchContext('admin', child.id), parentResearch);
  assert.deepEqual(parent, parentBefore, 'recovering through a fork must not mutate the parent');
});

test('Normal and Deep may switch repeatedly while continuing the same conversation', async (t) => {
  const { manager, conversations } = await forkFixture(t);
  const normal = await manager.createTask('admin', {
    kind: 'qa',
    prompt: 'First normal turn',
    taskMode: 'normal',
    model: 'qwen',
    effort: 'medium',
    webSearch: false,
  });
  await manager.getTask('admin', normal.taskId).runPromise;

  const deep = await manager.createTask('admin', {
    kind: 'qa',
    prompt: 'Follow up in Deep mode',
    taskMode: 'deep',
    conversationId: normal.conversationId,
    model: 'qwen',
    effort: 'medium',
    webSearch: false,
  });
  await manager.getTask('admin', deep.taskId).runPromise;

  const normalAgain = await manager.createTask('admin', {
    kind: 'qa',
    prompt: 'Return to Normal mode',
    taskMode: 'normal',
    conversationId: normal.conversationId,
    model: 'qwen',
    effort: 'medium',
    webSearch: false,
  });
  await manager.getTask('admin', normalAgain.taskId).runPromise;

  assert.equal(deep.conversationId, normal.conversationId);
  assert.equal(normalAgain.conversationId, normal.conversationId);
  assert.equal(deep.forkedFromConversationId, null);
  assert.equal(normalAgain.forkedFromConversationId, null);
  const conversation = conversations.get('admin', normal.conversationId);
  assert.equal(conversation.parentConversationId, undefined);
  assert.equal(conversation.taskMode, 'normal');
  assert.deepEqual(conversation.messages.filter((message) => message.role === 'user').map((message) => message.content), [
    'First normal turn',
    'Follow up in Deep mode',
    'Return to Normal mode',
  ]);
  assert.equal(conversation.messages.length, 6);
});

test('a failed initial fork save removes the child and restores the untouched parent', async (t) => {
  const { project, manager, conversations } = await forkFixture(t);
  const parent = createPopulatedParent(conversations);
  await conversations.save();
  const parentBefore = structuredClone(parent);
  const persistedBefore = await fsp.readFile(project.config.conversationFile, 'utf8');
  const originalSave = conversations.save.bind(conversations);
  conversations.save = async () => {
    throw new Error('fixture fork persistence failure');
  };

  await assert.rejects(
    () => manager.createTask('admin', {
      kind: 'qa',
      prompt: 'must not leave a child',
      forkFromConversationId: parent.id,
      model: 'deepseek',
      effort: 'medium',
      webSearch: false,
    }),
    (error) => error?.status === 503 && error?.code === 'CONVERSATION_PERSIST_FAILED',
  );

  assert.equal(manager.tasks.size, 0);
  assert.deepEqual(conversations.list('admin').map((item) => item.id), [parent.id]);
  assert.deepEqual(conversations.get('admin', parent.id), parentBefore);
  assert.equal(await fsp.readFile(project.config.conversationFile, 'utf8'), persistedBefore);

  conversations.save = originalSave;
});
