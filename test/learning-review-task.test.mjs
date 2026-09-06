import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskManager } from '../src/task-manager.mjs';
import { ConversationStore } from '../src/conversation-store.mjs';
import { temporaryProject } from './helpers.mjs';

const NOW = Date.parse('2026-09-06T04:00:00Z');

async function fixture(t, { broken = false, maxContextChars = 24_000, webAvailable = true, formatJson = (json) => json } = {}) {
  const project = await temporaryProject('learning-review-task-');
  t.after(project.cleanup);
  const files = new Map(Array.from({ length: 20 }, (_, i) => [
    `daily_doc/日记/2026-08-${String(i + 7).padStart(2, '0')}.md`,
    `已经完成主题${i + 1}练习。`,
  ]));
  files.set('daily_doc/日记/2026-09-05.md', '已经完成 CUDA 入门练习。[[learning_doc/CUDA 笔记]]');
  files.set('learning_doc/CUDA 笔记.md', 'CUDA 包含线程块与共享内存。');
  files.set('daily_doc/计划/2026-09-03.md', '- [ ] 计划阅读 FlashKDA。');
  files.set('daily_doc/日记/2026-08-03.md', '已经完成 RC-flow 旧论文。');
  files.set('learning_doc/RC-flow.md', 'RC-flow 是旧学习笔记。');
  const calls = { reads: [], model: [], searches: [], web: 0 };
  const index = {
    ready: Promise.resolve(), status: () => ({ available: true, files: files.size, chunks: files.size }),
    listDocuments: () => [...files.keys()].map((path) => ({ path })),
    readDocument: async (path) => {
      calls.reads.push(path);
      if (broken && path.includes('09-05')) throw Object.assign(new Error('changed'), { code: 'INDEX_DOCUMENT_CHANGED' });
      return { path, text: files.get(path) };
    },
    search: async (query) => { calls.searches.push(query); return { results: [] }; },
    close: async () => {},
  };
  const llm = { generate: async (messages) => {
    const input = JSON.parse(messages[1].content);
    calls.model.push(input);
    if (!input.segments) return JSON.stringify({ groups: [{ title: '学习方向', factIds: input.facts.map((fact) => fact.id) }] });
    const facts = [];
    for (const segment of input.segments) {
      if (segment.dateBasis === 'related') continue;
      const lines = segment.text.split('\n');
      const offset = lines.findIndex((line) => /完成|计划/u.test(line));
      if (offset < 0) continue;
      const line = lines[offset];
      facts.push({ topic: line.includes('CUDA') ? 'CUDA' : line.includes('FlashKDA') ? 'FlashKDA' : '练习',
        statement: line.split('[[')[0], status: line.includes('计划') ? 'planned' : 'completed',
        evidence: [{ segmentId: segment.id, path: segment.path, lineStart: segment.lineStart + offset,
          lineEnd: segment.lineStart + offset, quote: line }] });
    }
    return formatJson(JSON.stringify({ facts }));
  } };
  const conversations = new ConversationStore(project.config.conversationFile);
  const manager = new TaskManager({
    ...project.config, appName: 'Fixture', vaultLabel: 'Fixture', timezone: 'Asia/Shanghai',
    llm: { provider: 'fixture', model: 'fixture', timeoutMs: 1_000, maxOutputTokens: 4_000 },
    modelCatalog: [{ id: 'fixture', label: 'Fixture', actualModel: 'fixture', provider: 'fixture',
      efforts: ['default'], defaultEffort: 'default', available: true }],
    embedding: { provider: 'disabled' }, retrieval: { topK: 12, maxContextChars },
    research: { contextualizerEnabled: true },
    webSearch: { enabled: true }, sync: { provider: 'filesystem', displayName: 'Fixture' },
  }, { now: () => NOW, index, llm, conversations,
    store: { ready: Promise.resolve(), cleanupDrafts: async () => {}, auditBestEffort: async () => [] },
    webSearch: { publicStatus: () => ({ enabled: webAvailable, configured: webAvailable, provider: 'fixture' }),
      searchMany: async () => { calls.web += 1; throw new Error('Personal review must skip web'); } },
  });
  t.after(() => manager.close());
  await manager.ready;
  return { manager, conversations, calls, project };
}

async function ask(value, prompt, conversationId) {
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt, model: 'fixture', effort: 'default', webSearch: true, conversationId,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;
  assert.equal(task.status, 'completed', JSON.stringify(task.events.slice(-3)));
  return { task, conversation: value.conversations.get('admin', created.conversationId) };
}

test('exact three-turn monthly review reads beyond topK, retains its dates, and skips web', async (t) => {
  const value = await fixture(t);
  let id;
  let range;
  for (const prompt of ['总结最近一个月的学习重点', '所有', '所有的']) {
    const { task, conversation } = await ask(value, prompt, id);
    id = conversation.id;
    const review = conversation.researchContext.learningReview;
    range ||= review.range;
    assert.deepEqual(review.range, range);
    assert.equal(review.range.startInclusive, '2026-08-05T16:00:00.000Z');
    const answer = conversation.messages.at(-1).content;
    assert.match(answer, /CUDA/u);
    assert.match(answer, /计划.*FlashKDA/u);
    assert.doesNotMatch(answer, /RC-flow|哪个学科|请补充/u);
    assert.equal(task.learningReviewCoverage.candidateRecords, 22);
    assert.equal(task.learningReviewCoverage.completeRecords, 22);
    assert.equal(task.learningReviewCoverage.supplementalComplete, 1);
  }
  assert.equal(value.calls.web, 0);
  assert(value.calls.model[0].segments, 'First model call extracts date records; no contextualizer clarification');
  const restored = new ConversationStore(value.project.config.conversationFile);
  await restored.ready;
  assert.deepEqual(restored.get('admin', id).researchContext.learningReview.range, range);
  const fork = await restored.fork('admin', id);
  // fork is a prepared snapshot; persistence is exercised by the existing fork suite.
  assert.deepEqual(fork.researchContext.learningReview.range, range);
});

test('changed documents are counted as a discovery gap, never as a completed read', async (t) => {
  const value = await fixture(t, { broken: true });
  const { task, conversation } = await ask(value, '总结最近一个月的学习重点');
  assert.equal(task.learningReviewCoverage.discoveryFailures, 1);
  assert.match(conversation.messages.at(-1).content, /扫描失败 1 篇.*存在覆盖缺口/u);
  assert.doesNotMatch(conversation.messages.at(-1).content, /已学习.*CUDA/u);
});

test('a personal review does not require the globally selected web provider to be available', async (t) => {
  const value = await fixture(t, { webAvailable: false });
  const { task, conversation } = await ask(value, '总结最近一个月的学习重点');
  assert.equal(task.webSearch, false);
  assert.equal(conversation.webSearch, true, 'Keep the user preference for subsequent unrelated questions');
  assert.equal(value.calls.web, 0);
  assert.match(conversation.messages.at(-1).content, /CUDA/u);
});

test('provider formatting around one JSON object never discards otherwise valid date batches', async (t) => {
  const value = await fixture(t, { formatJson: (json) => `以下是提取结果：\n\n\`\`\`JSON\n${json}\n\`\`\`` });
  const { task, conversation } = await ask(value, '总结最近一个月的学习重点');
  assert.equal(task.learningReviewCoverage.completeRecords, 22);
  assert.equal(task.learningReviewCoverage.failedRecords, 0);
  assert.match(conversation.messages.at(-1).content, /CUDA/u);
  assert.doesNotMatch(conversation.messages.at(-1).content, /以下是提取结果/u);
});
