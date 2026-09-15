import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  KnowledgeAgentManager,
  retrievalEmbeddingEvent,
} from '../../src/original/knowledge-agent.mjs';
import { createKnowledgeSearchServer } from '../../src/original/knowledge-search-mcp.mjs';
import { KnowledgeStore } from '../../src/original/knowledge-store.mjs';
import { KNOWLEDGE_SEARCH_TOOL } from '../../src/original/subagent-policy.mjs';

async function makeVault() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuan-knowledge-test-'));
  const vault = path.join(root, 'vault');
  const drafts = path.join(root, 'private', 'drafts');
  const conversations = path.join(root, 'private', 'knowledge-conversations.json');
  const audit = path.join(root, 'private', 'knowledge-audit.jsonl');
  await Promise.all([
    fsp.mkdir(path.join(vault, 'daily_doc', '日记'), { recursive: true }),
    fsp.mkdir(path.join(vault, 'daily_doc', '计划'), { recursive: true }),
    fsp.mkdir(path.join(vault, 'daily_doc', '随心草稿'), { recursive: true }),
    fsp.mkdir(path.join(vault, 'daily_doc', '随心草稿', '视频整理'), { recursive: true }),
    fsp.mkdir(path.join(vault, 'learning_doc'), { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(path.join(vault, 'daily_doc', '日记', '模板 1.md'), '# YYYY-MM-DD 日记\n\n## 今日事项\n\n1. \n\n## 感悟反思\n\n- \n\n## 其他\n\n- \n'),
    fsp.writeFile(path.join(vault, 'daily_doc', '计划', '模板 1.md'), '# YYYY-MM-DD 计划\n\n## 任务清单\n\n- [ ] \n\n## 备注\n\n- \n'),
    fsp.writeFile(path.join(vault, 'learning_doc', 'RAG.md'), '# RAG 学习\n\n检索增强生成需要先召回知识片段，再让模型核验来源。\n'),
  ]);
  const store = new KnowledgeStore({ root: vault, draftRoot: drafts, auditFile: audit });
  await store.initialize();
  return {
    root, vault, drafts, conversations, audit, store,
    async close() { await fsp.rm(root, { recursive: true, force: true }); },
  };
}

function resultMessage(result) {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'knowledge-session',
    result,
    num_turns: 1,
    duration_ms: 10,
    total_cost_usd: 0,
    errors: [],
  };
}

async function waitFor(check, timeout = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待知识库任务超时');
}

test('来源解析支持完整路径、唯一缩写及重名提示，并拒绝不安全引用', async (t) => {
  const fixture = await makeVault();
  t.after(() => fixture.close());
  await fsp.writeFile(path.join(fixture.vault, 'daily_doc/随心草稿/汇报 09.md'), '# synthetic');
  assert.deepEqual(await fixture.store.resolveSource('learning_doc/RAG.md'), { path: 'learning_doc/RAG.md' });
  assert.deepEqual(await fixture.store.resolveSource('RAG'), { path: 'learning_doc/RAG.md' });
  assert.deepEqual(await fixture.store.resolveSource('随心草稿/汇报 09.md'), { path: 'daily_doc/随心草稿/汇报 09.md' });
  await fsp.writeFile(path.join(fixture.vault, 'daily_doc/随心草稿/RAG.md'), '# other');
  assert.deepEqual(await fixture.store.resolveSource('RAG.md'), { candidates: ['daily_doc/随心草稿/RAG.md', 'learning_doc/RAG.md'] });
  await assert.rejects(fixture.store.resolveSource('missing.md'), { status: 404 });
  for (const input of ['/learning_doc/RAG.md', '../RAG.md', 'A/../RAG.md', 'file:///RAG.md']) {
    await assert.rejects(fixture.store.resolveSource(input), { status: 400 });
  }
});

test('实时中文检索覆盖正文并拒绝路径穿越和符号链接', async (t) => {
  const fixture = await makeVault();
  t.after(() => fixture.close());

  const first = await fixture.store.search('检索增强生成');
  assert.equal(first[0].path, 'learning_doc/RAG.md');
  assert.match(first[0].snippet, /检索增强生成/);

  const longQuery = `${'背景 '.repeat(100)}检索增强生成`;
  await assert.rejects(
    () => fixture.store.search(longQuery),
    (error) => error.code === 'SEARCH_QUERY_TOO_LONG',
  );
  const longResults = await fixture.store.search(longQuery, { allowLongQuery: true });
  assert.equal(longResults[0].path, 'learning_doc/RAG.md');

  const nearMaximumQuery = `${'背景 '.repeat(3997)}检索增强生成`;
  assert.equal(nearMaximumQuery.length, 11_997);
  const nearMaximumResults = await fixture.store.search(nearMaximumQuery, { allowLongQuery: true });
  assert.equal(nearMaximumResults[0].path, 'learning_doc/RAG.md');

  await fsp.writeFile(path.join(fixture.vault, 'learning_doc', '投机解码.md'), '# 投机解码\n\n草稿模型可以加速推理。\n');
  const refreshed = await fixture.store.search('草稿模型');
  assert.equal(refreshed[0].path, 'learning_doc/投机解码.md');

  await assert.rejects(() => fixture.store.existingFile('../outside.txt'), /路径/);
  await fsp.symlink('/etc/hosts', path.join(fixture.vault, 'learning_doc', 'escape.md'));
  await assert.rejects(() => fixture.store.existingFile('learning_doc/escape.md'), /普通文件|链接/);
});

test('快速关键词检索严格匹配实时文件且不调用语义索引', async (t) => {
  const fixture = await makeVault();
  t.after(() => fixture.close());
  await fsp.mkdir(path.join(fixture.vault, 'learning_doc', 'Guidance'));
  await Promise.all([
    fsp.writeFile(
      path.join(fixture.vault, 'learning_doc', 'Guidance', 'MyAPI_Config.MD'),
      '# API 配置\n\nImportantIdentifier 在 2026/8/25 完成更新。\n',
    ),
    fsp.writeFile(
      path.join(fixture.vault, 'learning_doc', 'OnlySecret.md'),
      '# 普通标题\n\n这是与文件名无关的正文。\n',
    ),
    fsp.writeFile(
      path.join(fixture.vault, 'learning_doc', '另一份检索.md'),
      '# 另一份检索\n\n检索结果需要核验来源。\n',
    ),
    fsp.writeFile(
      path.join(fixture.vault, 'learning_doc', '长行命中.md'),
      `# 长行命中\n\n${'无关前缀'.repeat(120)} ImportantTailMarker 位于长行末尾。\n`,
    ),
  ]);
  let semanticCalls = 0;
  fixture.store.attachIndex({
    status: () => ({ available: true }),
    async search() {
      semanticCalls += 1;
      throw new Error('关键词检索不应调用索引');
    },
  });

  assert.deepEqual(await fixture.store.keywordSearch('蔡徐坤'), []);

  const phrase = await fixture.store.keywordSearch('检索增强生成');
  assert.equal(phrase[0].path, 'learning_doc/RAG.md');
  assert.equal(phrase[0].matchedTerms.includes('检索增强生成'), true);
  assert.match(phrase[0].snippet, /检索增强生成/);

  const allTerms = await fixture.store.keywordSearch('检索 来源');
  assert.equal(allTerms.some((result) => result.path === 'learning_doc/RAG.md'), true);
  assert.deepEqual(await fixture.store.keywordSearch('检索 紫色灯塔'), []);

  const english = await fixture.store.keywordSearch('importantidentifier');
  assert.equal(english[0].path, 'learning_doc/Guidance/MyAPI_Config.MD');
  const filePath = await fixture.store.keywordSearch('guidance/myapi_config.md');
  assert.equal(filePath[0].path, 'learning_doc/Guidance/MyAPI_Config.MD');
  const date = await fixture.store.keywordSearch('2026年8月25日');
  assert.equal(date[0].path, 'learning_doc/Guidance/MyAPI_Config.MD');
  assert.equal(date[0].matchedTerms.includes('2026-08-25'), true);

  const pathOnly = await fixture.store.keywordSearch('ONLYSECRET.MD');
  assert.equal(pathOnly[0].path, 'learning_doc/OnlySecret.md');
  assert.equal(pathOnly[0].snippet, '');
  const longLine = await fixture.store.keywordSearch('importanttailmarker');
  assert.equal(longLine[0].path, 'learning_doc/长行命中.md');
  assert.match(longLine[0].snippet, /ImportantTailMarker/);
  assert.equal((await fixture.store.keywordSearch('检索', { limit: 1 })).length, 1);
  await assert.rejects(
    () => fixture.store.keywordSearch('x'.repeat(201)),
    (error) => error.code === 'SEARCH_QUERY_TOO_LONG',
  );
  assert.equal(semanticCalls, 0);
});

test('显式语义检索仅在索引可用时执行', async (t) => {
  const fixture = await makeVault();
  t.after(() => fixture.close());
  fixture.store.attachIndex(null);
  await assert.rejects(
    () => fixture.store.semanticSearch('x'.repeat(201)),
    (error) => error.status === 413 && error.code === 'SEARCH_QUERY_TOO_LONG',
  );
  await assert.rejects(
    () => fixture.store.semanticSearch('RAG'),
    (error) => error.status === 503 && error.code === 'SEMANTIC_SEARCH_UNAVAILABLE',
  );
  fixture.store.attachIndex({ status: () => ({ available: false }) });
  await assert.rejects(
    () => fixture.store.semanticSearch('RAG'),
    (error) => error.status === 503 && error.code === 'SEMANTIC_SEARCH_UNAVAILABLE',
  );
  fixture.store.attachIndex({
    status: () => ({ available: true }),
    async search() {
      return {
        route: 'semantic',
        results: [{ path: 'learning_doc/RAG.md' }],
        diagnostics: { embeddingUsed: false, fallback: 'bm25' },
      };
    },
  });
  await assert.rejects(
    () => fixture.store.semanticSearch('RAG'),
    (error) => error.status === 503 && error.code === 'SEMANTIC_SEARCH_UNAVAILABLE',
  );
  let options;
  fixture.store.attachIndex({
    status: () => ({ available: true }),
    async search(query, receivedOptions) {
      options = receivedOptions;
      return { route: 'semantic', query, results: [] };
    },
  });
  assert.equal((await fixture.store.semanticSearch('RAG', { limit: 5 })).route, 'semantic');
  assert.deepEqual(options, { limit: 5, route: 'semantic' });
});

test('日记使用遗留日期文件、确认前不写入且并发修改会阻止覆盖', async (t) => {
  const fixture = await makeVault();
  t.after(() => fixture.close());
  const legacy = path.join(fixture.vault, 'daily_doc', '日记', '2026-8-5.md');
  await fsp.writeFile(legacy, '# 旧日记\n\n原有内容\n');

  const prepared = await fixture.store.prepareDatedDocument('diary', '2026-08-05');
  assert.equal(prepared.relative, 'daily_doc/日记/2026-8-5.md');
  const draft = await fixture.store.createDraft({
    userId: 'user-12345678',
    kind: 'diary',
    date: '2026-08-05',
    prepared,
    content: '# 2026-08-05 日记\n\n## 今日事项\n\n1. 原有内容\n2. 新事项\n',
  });
  assert.equal(await fsp.readFile(legacy, 'utf8'), '# 旧日记\n\n原有内容\n');
  assert.equal(draft.targetPath, 'daily_doc/日记/2026-8-5.md');
  assert.equal(draft.attachments.length, 0);

  await fsp.appendFile(legacy, '\n外部修改\n');
  await assert.rejects(
    () => fixture.store.saveDraft('user-12345678', draft.id, { content: draft.content }),
    (error) => error.code === 'DRAFT_CONFLICT',
  );
  assert.match(await fsp.readFile(legacy, 'utf8'), /外部修改/);
});

test('随心记草稿和附件先存系统盘，确认后写入固定目录并处理重名', async (t) => {
  const fixture = await makeVault();
  t.after(() => fixture.close());
  const draft = await fixture.store.createDraft({
    userId: 'user-12345678',
    kind: 'scratch',
    content: '# RAG/学习记录\n\n今天理解了候选召回和来源核验。\n',
    attachments: [
      { name: '示意图.png', type: 'image/png', kind: 'image', buffer: Buffer.from('image-one') },
      { name: '示意图.png', type: 'image/png', kind: 'image', buffer: Buffer.from('image-two') },
    ],
  });

  assert.match(draft.targetPath, /^daily_doc\/随心草稿\/RAG 学习记录\.md$/);
  assert.equal(draft.attachments[1].finalName, '示意图-2.png');
  await assert.rejects(() => fsp.stat(path.join(fixture.vault, draft.targetPath)), /ENOENT/);
  assert.equal((await fsp.readdir(fixture.drafts)).length, 1);

  const saved = await fixture.store.saveDraft('user-12345678', draft.id, {
    title: draft.title,
    content: draft.content,
  });
  const note = await fsp.readFile(path.join(fixture.vault, saved.path), 'utf8');
  assert.match(note, /!\[\[assets\/RAG 学习记录\/示意图\.png\]\]/);
  assert.match(note, /!\[\[assets\/RAG 学习记录\/示意图-2\.png\]\]/);
  assert.equal(
    await fsp.readFile(path.join(fixture.vault, 'daily_doc', '随心草稿', 'assets', 'RAG 学习记录', '示意图.png'), 'utf8'),
    'image-one',
  );
  assert.deepEqual(await fsp.readdir(fixture.drafts), []);
});

test('日记附件确认后按日期保存，重复添加保留旧链接并自动处理重名', async (t) => {
  const fixture = await makeVault();
  t.after(() => fixture.close());
  const date = '2026-08-24';
  const firstPrepared = await fixture.store.prepareDatedDocument('diary', date);
  const firstDraft = await fixture.store.createDraft({
    userId: 'user-12345678',
    kind: 'diary',
    date,
    prepared: firstPrepared,
    content: '# 2026-08-24 日记\n\n## 今日事项\n\n1. 第一次记录\n',
    attachments: [
      { name: '现场.png', type: 'image/png', kind: 'image', buffer: Buffer.from('first-image') },
    ],
  });
  assert.match(firstDraft.content, /!\[\[assets\/2026-08-24\/现场\.png\]\]/);
  await assert.rejects(
    () => fsp.stat(path.join(fixture.vault, 'daily_doc', '日记', 'assets', date, '现场.png')),
    /ENOENT/,
  );

  await fixture.store.saveDraft('user-12345678', firstDraft.id, { content: firstDraft.content });
  assert.equal(
    await fsp.readFile(path.join(fixture.vault, 'daily_doc', '日记', 'assets', date, '现场.png'), 'utf8'),
    'first-image',
  );

  const secondPrepared = await fixture.store.prepareDatedDocument('diary', date);
  const secondDraft = await fixture.store.createDraft({
    userId: 'user-12345678',
    kind: 'diary',
    date,
    prepared: secondPrepared,
    content: '# 2026-08-24 日记\n\n## 今日事项\n\n1. 第一次记录\n2. 第二次记录\n',
    attachments: [
      { name: '现场.png', type: 'image/png', kind: 'image', buffer: Buffer.from('second-image') },
    ],
  });
  assert.equal(secondDraft.attachments[0].finalName, '现场-2.png');
  assert.match(secondDraft.content, /!\[\[assets\/2026-08-24\/现场\.png\]\]/);
  assert.match(secondDraft.content, /!\[\[assets\/2026-08-24\/现场-2\.png\]\]/);

  const secondSaved = await fixture.store.saveDraft('user-12345678', secondDraft.id, {
    content: secondDraft.content,
  });
  const finalNote = await fsp.readFile(path.join(fixture.vault, secondSaved.path), 'utf8');
  assert.match(finalNote, /!\[\[assets\/2026-08-24\/现场\.png\]\]/);
  assert.match(finalNote, /!\[\[assets\/2026-08-24\/现场-2\.png\]\]/);
  assert.equal(
    await fsp.readFile(path.join(fixture.vault, 'daily_doc', '日记', 'assets', date, '现场-2.png'), 'utf8'),
    'second-image',
  );
});

test('知识历史按用户和模式原子清除，并阻止创建中或运行中的竞态', async (t) => {
  const fixture = await makeVault();
  let releaseRunning;
  const runningGate = new Promise((resolve) => { releaseRunning = resolve; });
  const queryFn = ({ prompt }) => (async function* stream() {
    if (JSON.stringify(prompt).includes('保持运行')) await runningGate;
    yield resultMessage('完成');
  })();
  const videoProcessor = {
    ready: Promise.resolve(),
    async status() { return { available: false }; },
    async cleanupStale() {},
  };
  const manager = new KnowledgeAgentManager({
    queryFn,
    store: fixture.store,
    conversationFile: fixture.conversations,
    index: false,
    videoProcessor,
  });
  let restored;
  t.after(async () => {
    restored?.close();
    manager.close();
    await manager.persistQueue.catch(() => {});
    await fixture.close();
  });
  await manager.ready;

  const storedConversation = (id, userId, kind) => ({
    id,
    userId,
    kind,
    title: `${kind}-${id}`,
    modelId: 'qwen',
    effortId: 'xhigh',
    webSearch: false,
    taskModeId: 'normal',
    sdkSessionId: null,
    messages: [],
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  });
  manager.conversations.set('qa-one', storedConversation('qa-one', 'user-history-a', 'qa'));
  manager.conversations.set('qa-two', storedConversation('qa-two', 'user-history-a', 'qa'));
  manager.conversations.set('plan-one', storedConversation('plan-one', 'user-history-a', 'plan'));
  manager.conversations.set('qa-other', storedConversation('qa-other', 'user-history-b', 'qa'));
  await manager.persistConversations();

  const persist = manager.persistConversations.bind(manager);
  let persistCalls = 0;
  manager.persistConversations = (...args) => {
    persistCalls += 1;
    return persist(...args);
  };
  assert.deepEqual(
    await manager.clearConversations('user-history-a', 'qa'),
    { ok: true, kind: 'qa', deletedCount: 2 },
  );
  assert.equal(persistCalls, 1);
  assert.deepEqual(
    manager.listConversations('user-history-a').map((item) => item.kind),
    ['plan'],
  );
  assert.equal(manager.listConversations('user-history-b').length, 1);
  assert.deepEqual(
    await manager.clearConversations('user-history-a', 'qa'),
    { ok: true, kind: 'qa', deletedCount: 0 },
  );
  assert.equal(persistCalls, 1, '空集合清除不应产生无意义的历史文件写入');
  await assert.rejects(
    () => manager.clearConversations('user-history-a', 'invalid'),
    (error) => error.status === 400 && error.code === 'INVALID_KNOWLEDGE_MODE',
  );

  manager.conversations.set(
    'scratch-rollback',
    storedConversation('scratch-rollback', 'user-history-a', 'scratch'),
  );
  await persist();
  manager.persistConversations = async () => { throw new Error('simulated persist failure'); };
  await assert.rejects(
    () => manager.clearConversations('user-history-a', 'scratch'),
    /simulated persist failure/,
  );
  assert.equal(manager.conversations.has('scratch-rollback'), true, '持久化失败必须恢复全部记录');
  manager.persistConversations = persist;

  const originalAssertNoSymlinks = fixture.store.assertNoSymlinks.bind(fixture.store);
  let signalPreparationStarted;
  let releasePreparation;
  const preparationStarted = new Promise((resolve) => { signalPreparationStarted = resolve; });
  const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
  fixture.store.assertNoSymlinks = async (...args) => {
    if (!args.length) {
      signalPreparationStarted();
      await preparationGate;
    }
    return originalAssertNoSymlinks(...args);
  };
  const creating = manager.createTask('user-creating', {
    kind: 'qa', prompt: '创建阶段测试', model: 'qwen', effort: 'xhigh',
  });
  await preparationStarted;
  await assert.rejects(
    () => manager.clearConversations('user-creating', 'qa'),
    (error) => error.status === 409 && error.code === 'CONVERSATIONS_BUSY',
  );
  releasePreparation();
  const created = await creating;
  await waitFor(() => manager.getTask('user-creating', created.taskId).status === 'completed');
  fixture.store.assertNoSymlinks = originalAssertNoSymlinks;

  const running = await manager.createTask('user-running', {
    kind: 'qa', prompt: '保持运行', model: 'qwen', effort: 'xhigh',
  });
  const beforeBusyClear = manager.listConversations('user-running').map((item) => item.id);
  await assert.rejects(
    () => manager.clearConversations('user-running', 'qa'),
    (error) => error.status === 409 && error.code === 'CONVERSATIONS_BUSY',
  );
  assert.deepEqual(
    manager.listConversations('user-running').map((item) => item.id),
    beforeBusyClear,
    '忙碌检查失败时不能部分删除',
  );
  releaseRunning();
  await waitFor(() => manager.getTask('user-running', running.taskId).status === 'completed');
  assert.equal((await manager.clearConversations('user-running', 'qa')).deletedCount, 1);
  await manager.persistQueue;

  const audits = (await fsp.readFile(fixture.audit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((event) => event.action === 'conversations_cleared');
  assert.deepEqual(
    audits[0],
    {
      at: audits[0].at,
      action: 'conversations_cleared',
      userId: 'user-history-a',
      kind: 'qa',
      deletedCount: 2,
    },
  );
  assert.equal('conversationIds' in audits[0], false);

  manager.close();
  restored = new KnowledgeAgentManager({
    queryFn: () => { throw new Error('恢复历史不应调用模型'); },
    store: fixture.store,
    conversationFile: fixture.conversations,
    index: false,
    videoProcessor,
  });
  await restored.ready;
  assert.equal(restored.listConversations('user-history-a').some((item) => item.kind === 'qa'), false);
  assert.equal(restored.listConversations('user-history-a').some((item) => item.kind === 'plan'), true);
  assert.equal(restored.listConversations('user-history-b').length, 1);
});

test('Embedding 执行过程区分真实调用、两级缓存、精确跳过和故障回退', async () => {
  const diagnostics = {
    embeddingModel: 'qwen3.7-text-embedding',
    embeddingDimensions: 1024,
    embeddingUsed: true,
    embeddingApiCalled: true,
    embeddingApiSucceeded: true,
    queryVectorCacheHit: false,
    rankingCacheHit: false,
  };
  assert.deepEqual(
    retrievalEmbeddingEvent({ route: 'semantic', diagnostics }),
    {
      type: 'activity',
      data: {
        toolName: 'QwenEmbedding', stage: 'completed',
        title: 'Qwen Embedding 已完成',
        message: 'qwen3.7-text-embedding · 查询向量 · 1024维',
      },
    },
  );
  assert.equal(
    retrievalEmbeddingEvent({
      route: 'semantic',
      diagnostics: { ...diagnostics, embeddingApiCalled: false, embeddingApiSucceeded: false, queryVectorCacheHit: true },
    }).data.title,
    '已复用查询向量缓存',
  );
  assert.equal(
    retrievalEmbeddingEvent({
      route: 'semantic',
      diagnostics: { ...diagnostics, embeddingApiCalled: false, embeddingApiSucceeded: false, rankingCacheHit: true },
    }).data.title,
    '已复用混合检索缓存',
  );
  assert.equal(
    retrievalEmbeddingEvent({ route: 'exact', diagnostics: { ...diagnostics, embeddingUsed: false } }).data.title,
    '精确检索已跳过 Qwen Embedding',
  );
  assert.deepEqual(
    retrievalEmbeddingEvent({
      route: 'semantic',
      diagnostics: { ...diagnostics, embeddingApiSucceeded: false, embeddingUsed: false, fallback: 'bm25' },
    }),
    {
      type: 'warning',
      data: { title: 'Qwen Embedding 调用失败', message: '已回退 BM25。', key: 'embedding-fallback' },
    },
  );
  assert.equal(
    retrievalEmbeddingEvent({
      route: 'semantic',
      diagnostics: { ...diagnostics, embeddingApiCalled: false, embeddingApiSucceeded: false, embeddingUsed: false, fallback: 'bm25' },
    }).data.title,
    '词法回退已启用',
  );

  let observed = null;
  const retrieval = { route: 'semantic', results: [], diagnostics };
  const task = {
    abortController: new AbortController(),
    taskMode: { id: 'normal' },
    hybridSearchEnabled: true,
  };
  const server = createKnowledgeSearchServer({
    async hybridSearch(query) {
      assert.equal(query, '主动改写后的检索');
      return retrieval;
    },
  }, task, {
    onRetrieval(result, context) { observed = { result, context }; },
  });
  const response = await server.instance._registeredTools.KnowledgeSearch.handler({
    query: '主动改写后的检索', offset: 0, limit: 20,
  });
  assert.equal(response.isError, undefined);
  assert.equal(observed.result, retrieval);
  assert.deepEqual(observed.context, { query: '主动改写后的检索', source: 'agent-search' });
});

test('知识库 Agent 始终只读、按开关开放 Tavily MCP，历史与草稿不进入 Vault', async (t) => {
  const fixture = await makeVault();
  const captured = [];
  const capturedPrompts = [];
  const queryFn = ({ prompt, options }) => {
    captured.push(options);
    return (async function* stream() {
      if (typeof prompt === 'string') capturedPrompts.push(prompt);
      else {
        const messages = [];
        for await (const message of prompt) messages.push(message);
        capturedPrompts.push(messages);
      }
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Grep', input: { pattern: 'RAG' } },
        },
      };
      yield { type: 'tool_progress', tool_name: 'Grep', elapsed_time_seconds: 1 };
      yield { type: 'tool_use_summary', summary: '已搜索知识库正文。' };
      yield resultMessage('知识库答案〔来源：learning_doc/RAG.md#RAG 学习〕');
    })();
  };
  const transcriber = {
    async status() {
      return { available: true, maxBytes: 8 * 1024 * 1024, maxDurationMs: 300_000 };
    },
    async transcribe(_userId, body) {
      assert.equal(body.type, 'audio/webm');
      return { text: '这是手机口述内容。', durationMs: 1200 };
    },
  };
  const manager = new KnowledgeAgentManager({
    queryFn,
    store: fixture.store,
    conversationFile: fixture.conversations,
    index: false,
    transcriber,
    videoProcessor: {
      ready: Promise.resolve(),
      async status() {
        return {
          available: true, uploadAvailable: true, linkAvailable: true,
          maxUploadBytes: 1024 * 1024 * 1024, maxDurationSeconds: 7200,
          acceptedTypes: ['video/mp4'], acceptedExtensions: ['.mp4'], rawVideoRetention: 'task-only',
        };
      },
      validateInput(value) {
        if (value?.uploadId) return { type: 'upload', uploadId: value.uploadId };
        if (value?.url) return { type: 'url', url: value.url };
        throw new Error('missing video');
      },
      async prepare() {
        const buffer = Buffer.from('frame');
        return {
          name: '测试课程.mp4', sourceUrl: '', durationSeconds: 65, durationLabel: '00:01:05',
          metadata: { video: { width: 1280, height: 720, codec: 'h264' }, audio: { codec: 'aac' } },
          transcript: { language: 'zh', transcript: '[00:00:03] 第一部分内容。' },
          frames: [{
            name: '关键帧-00-00-00.jpg', type: 'image/jpeg', kind: 'image', bytes: buffer.length,
            buffer, data: buffer.toString('base64'), timestamp: '00:00:00',
          }],
          persistentFrames: [{ name: '关键帧-00-00-00.jpg', type: 'image/jpeg', kind: 'image', buffer }],
          async cleanup() {},
        };
      },
      async cleanupStale() {},
    },
    webSearchServerFactory: () => ({
      type: 'stdio', command: '/test/node', args: ['/test/tavily-mcp.mjs'],
      env: { TAVILY_API_KEY: 'test-key' }, timeout: 60_000, alwaysLoad: true,
    }),
  });
  t.after(async () => {
    manager.close();
    await manager.persistQueue;
    await fixture.close();
  });
  await manager.ready;

  const status = await manager.publicStatus('user-12345678');
  assert.equal(status.attachmentLimits.count, 8);
  assert.equal(status.attachmentLimits.bytesPerAttachment, 5 * 1024 * 1024);
  assert.equal(status.attachmentLimits.totalBytes, 15 * 1024 * 1024);
  assert.equal(status.speechTranscription.available, true);
  assert.deepEqual(
    status.taskModes.map(({ id, maxTurns, timeoutMs, maxSubagents }) => ({
      id, maxTurns, timeoutMs, maxSubagents,
    })),
    [
      { id: 'normal', maxTurns: 20, timeoutMs: 10 * 60_000, maxSubagents: 0 },
      { id: 'deep', maxTurns: 50, timeoutMs: 30 * 60_000, maxSubagents: 2 },
    ],
  );
  assert.equal(status.hybridSearch.index.available, false);
  assert.deepEqual(
    await manager.transcribeAudio('user-12345678', { type: 'audio/webm' }),
    { text: '这是手机口述内容。', durationMs: 1200 },
  );
  for (const kind of ['diary', 'plan', 'scratch', 'video']) {
    await assert.rejects(
      () => manager.createTask('user-12345678', {
        kind,
        prompt: '不能开启深度模式',
        taskMode: 'deep',
      }),
      (error) => error.code === 'DEEP_MODE_NOT_ALLOWED' && error.status === 400,
    );
  }
  await assert.rejects(
    () => manager.createTask('user-12345678', {
      kind: 'qa',
      prompt: '尝试伪造子 Agent',
      taskMode: 'deep',
      agents: { 'source-verifier': { tools: ['Bash'] } },
    }),
    (error) => error.code === 'CLIENT_SUBAGENT_OPTIONS_DENIED' && error.status === 400,
  );
  const first = await manager.createTask('user-12345678', {
    kind: 'qa', prompt: 'RAG 是什么？', model: 'default', effort: 'high', webSearch: false,
  });
  await waitFor(() => manager.getTask('user-12345678', first.taskId).status === 'completed');
  const activity = manager.getTask('user-12345678', first.taskId).events
    .filter((event) => event.type === 'activity');
  assert.equal(activity.some((event) => event.data.toolName === 'Grep'), true);
  assert.equal(activity.some((event) => /搜索正文/.test(event.data.title)), true);
  assert.equal(activity.some((event) => event.data.title === '词法回退已启用'), true);
  assert.deepEqual(captured[0].tools, ['Read', 'Glob', 'Grep', KNOWLEDGE_SEARCH_TOOL]);
  assert.equal(captured[0].allowedTools.some((tool) => /Write|Edit|Bash/.test(tool)), false);
  assert.equal(captured[0].allowedTools.includes(KNOWLEDGE_SEARCH_TOOL), true);
  assert.deepEqual(captured[0].disallowedTools, ['WebSearch', 'WebFetch']);
  assert.equal(captured[0].maxTurns, 20);
  assert.equal('maxBudgetUsd' in captured[0], false);
  assert.equal(captured[0].tools.includes('Agent'), false);
  assert.equal(captured[0].agents, undefined);
  assert.equal(captured[0].hooks, undefined);
  assert.equal(captured[0].env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '131072');
  assert.match(captured[0].systemPrompt.append, /KnowledgeSearch\/Glob\/Grep 全库复查/);

  const second = await manager.createTask('user-12345678', {
    kind: 'qa', prompt: '补充外部资料', model: 'default', effort: 'high', webSearch: true,
  });
  await waitFor(() => manager.getTask('user-12345678', second.taskId).status === 'completed');
  assert.deepEqual(captured[1].tools, ['Read', 'Glob', 'Grep', KNOWLEDGE_SEARCH_TOOL]);
  assert.equal(captured[1].allowedTools.includes('mcp__tavily__tavily_search'), true);
  assert.equal(captured[1].allowedTools.includes('mcp__tavily__tavily_extract'), true);
  assert.equal('maxBudgetUsd' in captured[1], false);
  assert.equal(captured[1].mcpServers.tavily.type, 'stdio');
  assert.equal(captured[1].mcpServers.tavily.timeout, 60_000);
  assert.equal(path.relative(fixture.vault, fixture.conversations).startsWith('..'), true);
  assert.equal((await fsp.readFile(fixture.conversations, 'utf8')).includes('RAG 是什么'), true);

  const qaWithAttachment = await manager.createTask('user-12345678', {
    kind: 'qa',
    prompt: '根据附件解释图中内容',
    model: 'default',
    effort: 'high',
    attachments: [{
      name: '问题截图.png',
      type: 'image/png',
      data: Buffer.from('image-data').toString('base64'),
    }],
  });
  await waitFor(() => manager.getTask('user-12345678', qaWithAttachment.taskId).status === 'completed');
  assert.match(JSON.stringify(capturedPrompts[2]), /问题截图\.png/);
  assert.equal(manager.getTask('user-12345678', qaWithAttachment.taskId).attachments[0].data, undefined);

  const planWithAttachment = await manager.createTask('user-12345678', {
    kind: 'plan',
    prompt: '根据文件整理计划',
    date: '2026-08-24',
    model: 'default',
    effort: 'high',
    attachments: [{
      name: '安排.txt',
      type: 'text/plain',
      data: Buffer.from('上午开会，下午写报告。').toString('base64'),
    }],
  });
  const completedPlan = await waitFor(() => {
    const task = manager.getTask('user-12345678', planWithAttachment.taskId);
    return task.status === 'completed' && task;
  });
  const planDraft = await fixture.store.getDraft('user-12345678', completedPlan.draftId);
  assert.equal(planDraft.attachments[0].finalName, '安排.txt');
  assert.match(planDraft.content, /\[\[assets\/2026-08-24\/安排\.txt\]\]/);
  await fixture.store.deleteDraft('user-12345678', completedPlan.draftId);

  const videoTask = await manager.createTask('user-12345678', {
    kind: 'video',
    prompt: '整理成学习笔记',
    model: 'default',
    effort: 'high',
    videoOutput: 'learning',
    video: { uploadId: '00000000-0000-4000-8000-000000000001' },
  });
  const completedVideo = await waitFor(() => {
    const task = manager.getTask('user-12345678', videoTask.taskId);
    return task.status === 'completed' && task;
  });
  const videoDraft = await fixture.store.getDraft('user-12345678', completedVideo.draftId);
  assert.match(videoDraft.targetPath, /^daily_doc\/随心草稿\/视频整理\//);
  assert.equal(videoDraft.kind, 'video');
  assert.equal(captured.at(-1).tools.length, 0);
  assert.match(JSON.stringify(capturedPrompts.at(-1)), /00:00:03/);
  assert.match(JSON.stringify(capturedPrompts.at(-1)), /关键帧顺序/);
  await fixture.store.deleteDraft('user-12345678', completedVideo.draftId);

  const longQaPrompt = `${'背景 '.repeat(3997)}检索增强生成`;
  const longQaTask = await manager.createTask('user-12345678', {
    kind: 'qa', prompt: longQaPrompt, model: 'default', effort: 'high', webSearch: false,
  });
  const completedLongQa = await waitFor(() => {
    const task = manager.getTask('user-12345678', longQaTask.taskId);
    return task.status === 'completed' && task;
  });
  assert.equal(completedLongQa.status, 'completed');
  assert.equal(completedLongQa.error, undefined);
  assert.match(JSON.stringify(capturedPrompts.at(-1)), /检索增强生成/);

  const deepQa = await manager.createTask('user-12345678', {
    kind: 'qa',
    prompt: '全面比较三个主题并独立核验来源',
    model: 'default',
    effort: 'high',
    taskMode: 'deep',
    webSearch: false,
  });
  const completedDeepQa = await waitFor(() => {
    const task = manager.getTask('user-12345678', deepQa.taskId);
    return task.status === 'completed' && task;
  });
  const deepOptions = captured.at(-1);
  assert.equal(deepQa.taskMode, 'deep');
  assert.equal(completedDeepQa.taskMode.maxTurns, 50);
  assert.equal(completedDeepQa.taskMode.timeoutMs, 30 * 60_000);
  assert.equal(completedDeepQa.taskMode.maxSubagents, 2);
  assert.equal(deepOptions.maxTurns, 50);
  assert.equal('maxBudgetUsd' in deepOptions, false);
  assert.deepEqual(
    deepOptions.tools,
    ['Read', 'Glob', 'Grep', KNOWLEDGE_SEARCH_TOOL, 'Agent'],
  );
  assert.deepEqual(Object.keys(deepOptions.agents), ['vault-researcher', 'source-verifier']);
  assert.equal(Array.isArray(deepOptions.hooks.PreToolUse), true);
  for (const definition of Object.values(deepOptions.agents)) {
    assert.deepEqual(definition.tools, ['Read', 'Glob', 'Grep', KNOWLEDGE_SEARCH_TOOL]);
    assert.equal(definition.permissionMode, 'dontAsk');
    assert.equal(definition.disallowedTools.includes('Agent'), true);
    assert.equal(definition.disallowedTools.includes('Bash'), true);
    assert.equal(definition.disallowedTools.includes('Write'), true);
    assert.equal(definition.disallowedTools.includes('WebSearch'), true);
  }

  const nineAttachments = Array.from({ length: 9 }, (_, index) => ({
    name: `${index}.txt`, type: 'text/plain', data: Buffer.from('x').toString('base64'),
  }));
  await assert.rejects(
    () => manager.createTask('user-12345678', {
      kind: 'scratch', prompt: '整理', attachments: nineAttachments,
    }),
    (error) => error.code === 'TOO_MANY_ATTACHMENTS',
  );
});
