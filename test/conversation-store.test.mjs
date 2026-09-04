import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.mjs';
import { temporaryProject } from './helpers.mjs';

test('a failed persistence attempt does not poison later conversation saves', async (t) => {
  const project = await temporaryProject('vaultmind-conversations-');
  t.after(project.cleanup);
  const filename = path.join(project.dataDir, 'state', 'conversations.json');
  const store = new ConversationStore(filename);
  await store.ready;
  const conversation = store.create('admin', 'qa', { title: 'Recovery test' });

  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(path.join(path.dirname(filename), 'blocker'), 'fixture');
  await fsp.rm(path.dirname(filename), { recursive: true });
  await fsp.writeFile(path.dirname(filename), 'not-a-directory');
  await assert.rejects(() => store.save());

  await fsp.rm(path.dirname(filename));
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  conversation.messages.push({ role: 'user', content: 'persist me' });
  await store.save();

  const persisted = JSON.parse(await fsp.readFile(filename, 'utf8'));
  assert.equal(persisted.conversations[0].messages[0].content, 'persist me');
});

test('failed delete and clear persistence restore in-memory conversations', async (t) => {
  const project = await temporaryProject('vaultmind-conversation-delete-');
  t.after(project.cleanup);
  const filename = path.join(project.dataDir, 'conversations.json');
  const store = new ConversationStore(filename);
  await store.ready;
  const first = store.create('admin', 'qa', { title: 'First' });
  const second = store.create('admin', 'qa', { title: 'Second' });
  await store.save();

  const blocked = path.join(project.dataDir, 'blocked-parent');
  await fsp.writeFile(blocked, 'not-a-directory');
  store.filename = path.join(blocked, 'conversations.json');
  await assert.rejects(() => store.delete('admin', first.id));
  assert.equal(store.get('admin', first.id).title, 'First');
  await assert.rejects(() => store.clear('admin', 'qa'));
  assert.deepEqual(
    store.list('admin').map((item) => item.id).sort(),
    [first.id, second.id].sort(),
  );
});

test('loads legacy v1 conversations and writes the compatible v2 shape on the next save', async (t) => {
  const project = await temporaryProject('vaultmind-conversation-v1-');
  t.after(project.cleanup);
  const filename = path.join(project.dataDir, 'conversations.json');
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(filename, JSON.stringify({
    version: 1,
    conversations: [{
      version: 1,
      id: 'legacy-id',
      userId: 'admin',
      kind: 'qa',
      title: 'Legacy conversation',
      model: 'legacy-model',
      messages: [{ role: 'user', content: 'legacy prompt' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }));

  const store = new ConversationStore(filename);
  await store.ready;
  assert.deepEqual(store.public(store.get('admin', 'legacy-id')), {
    id: 'legacy-id',
    kind: 'qa',
    title: 'Legacy conversation',
    model: 'legacy-model',
    actualModel: null,
    modelProvider: null,
    modelBindingRevision: null,
    effort: 'default',
    taskMode: 'normal',
    webSearch: false,
    webSearchProvider: null,
    webSearchBindingRevision: null,
    parentConversationId: null,
    forkedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  await store.save();
  const persisted = JSON.parse(await fsp.readFile(filename, 'utf8'));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.conversations[0].version, 2);
  assert.equal(persisted.conversations[0].effort, 'default');
  assert.equal(persisted.conversations[0].webSearch, false);
});

test('fork copies only the five most recent complete turns and keeps parent state isolated', async (t) => {
  const project = await temporaryProject('vaultmind-conversation-fork-');
  t.after(project.cleanup);
  const filename = path.join(project.dataDir, 'conversations.json');
  const store = new ConversationStore(filename);
  await store.ready;
  const parent = store.create('admin', 'qa', {
    title: '甲州投控集团董事长是谁',
    model: 'qwen',
    effort: 'high',
    webSearch: false,
    researchContext: {
      subject: { name: '测试人物甲', type: 'person', aliases: ['测试董事长甲'] },
      requiredAnchors: ['甲州', '投控集团'],
      intent: { label: '现任董事长', terms: ['任命'] },
      temporal: { mode: 'current', asOf: null },
      lastStandaloneQuestion: '甲州投控集团董事长是谁',
      verifiedClaims: [{ text: '测试人物甲担任董事长', direct: true, sourceIds: ['W1'] }],
      citedSources: [{ id: 'W1', title: '任免公告', url: 'https://example.com/appointment' }],
    },
  });
  for (let index = 1; index <= 7; index += 1) {
    parent.messages.push(
      { role: 'user', content: `question-${index}`, attachments: [`a-${index}.txt`] },
      { role: 'assistant', content: `answer-${index}` },
    );
  }
  parent.messages.push({ role: 'user', content: 'unfinished-question' });
  const parentBefore = structuredClone(parent);

  const child = store.createFork('admin', parent.id, {
    model: 'deepseek', effort: 'max', taskMode: 'deep', webSearch: true,
  });
  assert.equal(child.parentConversationId, parent.id);
  assert.ok(child.forkedAt);
  assert.equal(child.model, 'deepseek');
  assert.equal(child.effort, 'max');
  assert.equal(child.taskMode, 'deep');
  assert.equal(child.webSearch, true);
  assert.deepEqual(child.messages.map((message) => message.content), [
    'question-3', 'answer-3',
    'question-4', 'answer-4',
    'question-5', 'answer-5',
    'question-6', 'answer-6',
    'question-7', 'answer-7',
  ]);
  child.messages[0].content = 'changed only in child';
  child.researchContext.subject.name = 'child subject';
  assert.deepEqual(parent, parentBefore);
  assert.equal(Object.hasOwn(store.public(child), 'researchContext'), false);

  await store.save();
  await store.delete('admin', parent.id);
  assert.equal(store.get('admin', child.id).parentConversationId, parent.id);
});

test('research context persistence is private, bounded, and strips raw research material', async (t) => {
  const project = await temporaryProject('vaultmind-research-context-');
  t.after(project.cleanup);
  const filename = path.join(project.dataDir, 'conversations.json');
  const store = new ConversationStore(filename);
  await store.ready;
  const conversation = store.create('admin', 'qa', { title: 'Research' });
  const manyClaims = Array.from({ length: 25 }, (_, index) => ({
    text: `verified-${index}`,
    sourceIds: [`W${index}`],
    reasoning: 'hidden reasoning must not persist',
    pageBody: 'raw page body must not persist',
  }));
  const manySources = Array.from({ length: 25 }, (_, index) => ({
    id: `W${index}`,
    title: `source-${index}`,
    url: `https://example.com/${index}`,
    snippet: 'raw search snippet must not persist',
    query: 'raw search query must not persist',
  }));
  store.setResearchContext('admin', conversation.id, {
    subject: { name: '测试人物甲', type: 'person', aliases: ['测试人物甲', '测试人物甲'] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '行政级别', terms: ['市管干部'] },
    temporal: { mode: 'current', asOf: null },
    lastStandaloneQuestion: '甲州投控集团测试人物甲是什么行政级别',
    pendingClarification: {
      kind: 'context_switch',
      createdAt: '2026-09-03T00:00:00.000Z',
      proposedState: {
        standaloneQuestion: '训练显存怎么计算',
        subject: { name: '', type: 'topic', aliases: [] },
        requiredAnchors: [],
        intent: { label: '计算方法', terms: ['显存'] },
        temporal: { mode: 'unspecified', asOf: null },
        queries: ['must not persist inside pending state'],
      },
      rawModelOutput: 'must not persist from clarification',
    },
    claims: manyClaims,
    finalSources: [
      ...manySources,
      { id: 'bad-http', title: 'bad', url: 'http://example.com/not-allowed' },
      { id: 'credentials', title: 'bad', url: 'https://user:pass@example.com/not-allowed' },
    ],
    queries: ['must not persist'],
    webDocuments: ['must not persist'],
  });
  await store.save();

  const persisted = JSON.parse(await fsp.readFile(filename, 'utf8')).conversations[0];
  assert.equal(Object.hasOwn(store.public(conversation), 'researchContext'), false);
  assert.equal(persisted.researchContext.verifiedClaims.length, 20);
  assert.equal(persisted.researchContext.citedSources.length, 20);
  assert.equal(persisted.researchContext.subject.aliases.length, 1);
  assert.equal(JSON.stringify(persisted).includes('hidden reasoning'), false);
  assert.equal(JSON.stringify(persisted).includes('raw page body'), false);
  assert.equal(JSON.stringify(persisted).includes('raw search snippet'), false);
  assert.equal(JSON.stringify(persisted).includes('raw search query'), false);
  assert.equal(Object.hasOwn(persisted.researchContext, 'queries'), false);
  assert.equal(Object.hasOwn(persisted.researchContext, 'webDocuments'), false);
  assert.equal(persisted.researchContext.pendingClarification.kind, 'context_switch');
  assert.equal(
    persisted.researchContext.pendingClarification.proposedState.standaloneQuestion,
    '训练显存怎么计算',
  );
  assert.equal(
    Object.hasOwn(persisted.researchContext.pendingClarification.proposedState, 'queries'),
    false,
  );
  assert.equal(JSON.stringify(persisted).includes('rawModelOutput'), false);
});

test('persisted fork is atomic and a failed fork is never exposed in memory', async (t) => {
  const project = await temporaryProject('vaultmind-atomic-fork-');
  t.after(project.cleanup);
  const filename = path.join(project.dataDir, 'conversations.json');
  const store = new ConversationStore(filename);
  await store.ready;
  const parent = store.create('admin', 'qa', { title: 'Parent' });
  parent.messages.push(
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  );
  await store.save();

  const blocker = path.join(project.dataDir, 'not-a-directory');
  await fsp.writeFile(blocker, 'fixture');
  store.filename = path.join(blocker, 'conversations.json');
  const beforeIds = store.list('admin').map((item) => item.id);
  await assert.rejects(() => store.fork('admin', parent.id, { model: 'new-model' }));
  assert.deepEqual(store.list('admin').map((item) => item.id), beforeIds);

  store.filename = filename;
  const [first, second] = await Promise.all([
    store.fork('admin', parent.id, { title: 'First fork' }),
    store.fork('admin', parent.id, { title: 'Second fork' }),
  ]);
  assert.notEqual(first.id, second.id);
  const persisted = JSON.parse(await fsp.readFile(filename, 'utf8'));
  assert.deepEqual(
    persisted.conversations.map((item) => item.id).sort(),
    [parent.id, first.id, second.id].sort(),
  );
});

test('pending commits are not visible to concurrent readers before durable persistence', async (t) => {
  const project = await temporaryProject('vaultmind-atomic-visibility-');
  t.after(project.cleanup);
  const filename = path.join(project.dataDir, 'conversations.json');
  const store = new ConversationStore(filename);
  await store.ready;
  const parent = store.create('admin', 'qa', { title: 'Parent' });
  parent.messages.push(
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  );
  await store.save();

  const originalSave = store.save.bind(store);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writeStarted;
  const started = new Promise((resolve) => { writeStarted = resolve; });
  store.save = async (snapshot) => {
    writeStarted();
    await gate;
    return originalSave(snapshot);
  };

  const pendingChild = store.prepareFork('admin', parent.id, { title: 'Pending child' });
  const commit = store.commitNew('admin', pendingChild);
  await started;
  assert.equal(
    store.list('admin').some((conversation) => conversation.id === pendingChild.id),
    false,
    'a pending disk write must not become a dirty read',
  );

  release();
  await commit;
  assert.equal(store.list('admin').some((conversation) => conversation.id === pendingChild.id), true);
});
