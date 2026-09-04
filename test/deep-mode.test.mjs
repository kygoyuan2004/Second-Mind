import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.mjs';
import { TaskManager, taskManagerInternals } from '../src/task-manager.mjs';
import { temporaryProject } from './helpers.mjs';

async function deepFixture(t, options = {}) {
  const project = await temporaryProject('second-mind-deep-');
  t.after(project.cleanup);
  const searches = [];
  const modelCalls = [];
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 3, chunks: 3, semanticAvailable: true }),
    search: async (query, searchOptions) => {
      searches.push({ query, options: searchOptions });
      const slug = searches.length;
      return {
        route: 'hybrid',
        results: [
          {
            path: 'learning/agent-plan.md',
            lineStart: slug,
            lineEnd: slug + 2,
            content: `Grounded evidence for ${query}`,
            matchedTerms: ['agent'],
          },
          {
            path: `learning/source-${slug}.md`,
            lineStart: 1,
            lineEnd: 3,
            content: `Distinct evidence ${slug}`,
            matchedTerms: [`term-${slug}`],
          },
        ],
        diagnostics: { embeddingUsed: true },
      };
    },
    close: async () => {},
  };
  const store = {
    ready: Promise.resolve(),
    cleanupDrafts: async () => {},
  };
  const llm = {
    generate: async (messages, generateOptions) => {
      modelCalls.push({ messages, options: generateOptions });
      if (messages[0]?.content.includes('bounded search queries')) {
        return options.plannerOutput ?? '{"queries":["Agent Harness Tool execution","Skill and MCP responsibilities"]}';
      }
      const answer = 'Deep grounded answer [[learning/agent-plan.md]]';
      generateOptions.onToken?.(answer);
      return answer;
    },
  };
  const config = {
    ...project.config,
    appName: 'Second Mind',
    vaultLabel: 'Fixture Vault',
    timezone: 'UTC',
    llm: {
      provider: 'anthropic', model: 'qwen3.8-max', maxOutputTokens: 3_000,
    },
    embedding: {
      provider: 'dashscope', model: 'qwen3.7-text-embedding', dimensions: 1024,
    },
    retrieval: { topK: 8, maxContextChars: 30_000 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
    deep: { enabled: options.deepEnabled !== false, topK: 16 },
  };
  const manager = new TaskManager(config, { index, store, llm, conversations });
  t.after(() => manager.close());
  await manager.ready;
  return { manager, conversations, searches, modelCalls };
}

test('status publishes real Normal and Deep modes only when Deep is enabled', async (t) => {
  const enabled = await deepFixture(t);
  assert.deepEqual(
    (await enabled.manager.publicStatus('admin')).taskModes.map((mode) => mode.id),
    ['normal', 'deep'],
  );

  const disabled = await deepFixture(t, { deepEnabled: false });
  assert.deepEqual(
    (await disabled.manager.publicStatus('admin')).taskModes.map((mode) => mode.id),
    ['normal'],
  );
});

test('task mode validation rejects fake, disabled, write-mode, and client agent options', async (t) => {
  const fixture = await deepFixture(t);
  await assert.rejects(
    () => fixture.manager.createTask('admin', { kind: 'qa', prompt: 'question', taskMode: 'fake' }),
    { code: 'INVALID_TASK_MODE' },
  );
  await assert.rejects(
    () => fixture.manager.createTask('admin', { kind: 'plan', prompt: 'plan', taskMode: 'deep' }),
    { code: 'DEEP_MODE_NOT_ALLOWED' },
  );
  await assert.rejects(
    () => fixture.manager.createTask('admin', {
      kind: 'qa', prompt: 'question', taskMode: 'deep', agents: [{ tools: ['Write'] }],
    }),
    { code: 'CLIENT_AGENT_OPTIONS_DENIED' },
  );
  await assert.rejects(
    () => fixture.manager.createTask('admin', {
      kind: 'qa', prompt: 'question', taskMode: 'deep', config: { agents: [] },
    }),
    { code: 'UNSUPPORTED_TASK_OPTION' },
  );
  await assert.rejects(
    () => fixture.manager.createTask('admin', {
      kind: 'qa', prompt: 'question', taskMode: 'deep', tools: ['shell'],
    }),
    { code: 'CLIENT_AGENT_OPTIONS_DENIED' },
  );

  const disabled = await deepFixture(t, { deepEnabled: false });
  await assert.rejects(
    () => disabled.manager.createTask('admin', { kind: 'qa', prompt: 'question', taskMode: 'deep' }),
    { code: 'DEEP_MODE_NOT_ALLOWED' },
  );
});

test('Deep mode plans multiple queries, expands hybrid retrieval, fuses evidence, and persists mode', async (t) => {
  const fixture = await deepFixture(t);
  const created = await fixture.manager.createTask('admin', {
    kind: 'qa',
    prompt: 'How does an Agent execute a plan?',
    taskMode: 'deep',
  });
  assert.equal(created.taskMode, 'deep');
  const task = fixture.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(fixture.manager.publicTask(task).taskMode, 'deep');
  assert.equal(fixture.modelCalls.length, 2);
  assert.equal(fixture.searches.length, 3);
  assert.deepEqual(
    fixture.searches.map((item) => item.options.limit),
    [16, 16, 16],
  );
  assert.ok(task.events.some((event) => event.type === 'session' && event.data.taskMode === 'deep'));
  assert.ok(task.events.some((event) => event.data.title === 'Deep retrieval plan ready'));
  assert.ok(task.events.some((event) => event.data.title === 'Deep evidence fusion complete'));
  assert.equal(fixture.conversations.list('admin')[0].taskMode, 'deep');
});

test('Normal mode remains a single retrieval and generation pass', async (t) => {
  const fixture = await deepFixture(t);
  const created = await fixture.manager.createTask('admin', {
    kind: 'qa', prompt: 'What is an Agent?', taskMode: 'normal',
  });
  const task = fixture.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(fixture.searches.length, 1);
  assert.equal(fixture.searches[0].options.limit, 8);
  assert.equal(fixture.modelCalls.length, 1);
  assert.equal(fixture.conversations.list('admin')[0].taskMode, 'normal');
});

test('Deep query parsing is bounded, deduplicated, and falls back to the original question', () => {
  assert.deepEqual(
    taskManagerInternals.deepQueriesFromOutput(
      '```json\n{"queries":["Original", "facet A", "facet a", "facet B", "facet C"]}\n```',
      'Original',
      3,
    ),
    ['Original', 'facet A', 'facet B'],
  );
  assert.deepEqual(
    taskManagerInternals.deepQueriesFromOutput('not json', 'Original', 4),
    ['Original'],
  );
  const longOriginal = `original-${'x'.repeat(500)}`;
  const longQueries = taskManagerInternals.deepQueriesFromOutput(
    JSON.stringify({ queries: [`facet-${'y'.repeat(500)}`] }),
    longOriginal,
    4,
  );
  assert.equal(longQueries[0], longOriginal);
  assert.equal(longQueries[1].length, 320);
});

test('Deep fusion keeps distinct passages from one file and cites only context-included paths', () => {
  const merged = taskManagerInternals.mergeDeepRetrieval([
    {
      query: 'facet A',
      retrieval: { results: [{
        path: 'one.md', lineStart: 1, lineEnd: 4, content: 'evidence A', matchedTerms: ['a'],
      }, {
        path: 'two.md', lineStart: 1, lineEnd: 2, content: 'z'.repeat(200), matchedTerms: ['z'],
      }] },
    },
    {
      query: 'facet B',
      retrieval: { results: [{
        path: 'one.md', lineStart: 100, lineEnd: 104, content: 'evidence B', matchedTerms: ['b'],
      }] },
    },
  ], 8);

  assert.equal(merged[0].path, 'one.md');
  assert.deepEqual(merged[0].deepExcerpts.map((item) => item.content), ['evidence A', 'evidence B']);
  const full = taskManagerInternals.sourceContext(merged, 2_000);
  assert.match(full.text, /evidence A/);
  assert.match(full.text, /evidence B/);
  assert.match(full.text, /<source id="V[0-9a-f]{16}" path="one\.md"/u);
  assert.deepEqual(full.includedPaths, ['one.md', 'two.md']);
  assert.equal(full.includedSources[0].kind, 'vault');
  assert.equal(full.includedSources[0].path, 'one.md');

  const bounded = taskManagerInternals.sourceContext(merged, 70);
  assert.ok(bounded.text.length <= 70);
  assert.deepEqual(bounded.includedPaths, ['one.md']);
});

test('Vault citations retain only exact paths actually supplied to the model', () => {
  const sources = [{
    id: taskManagerInternals.vaultSourceId('notes/verified.md'),
    kind: 'vault',
    path: 'notes/verified.md',
    title: 'notes/verified.md',
  }];
  const finalized = taskManagerInternals.finalizeVaultCitations(
    '可信 [[notes/verified.md]]；伪造 [[private/unknown.md]]；别名 [[notes/verified.md|标题]]。',
    sources,
  );
  assert.match(finalized.body, /\[\[notes\/verified\.md\]\]/u);
  assert.equal((finalized.body.match(/未核验知识库来源/gu) || []).length, 2);
  assert.deepEqual(finalized.referencedSources, sources);
});

test('source context keeps a match near the end of an oversized Markdown block', () => {
  const longContent = `${'prefix line\n'.repeat(700)}TARGET_EVIDENCE\ntrailer`;
  const context = taskManagerInternals.sourceContext([{
    path: 'long-code.md',
    lineStart: 1,
    lineEnd: 702,
    content: longContent,
    snippet: '…TARGET_EVIDENCE\ntrailer',
    matchedTerms: ['target_evidence'],
  }], 30_000);
  assert.match(context.text, /TARGET_EVIDENCE/);
  assert.deepEqual(context.includedPaths, ['long-code.md']);

  const normalizedOnly = taskManagerInternals.sourceContext([{
    path: 'normalized.md',
    content: longContent,
    snippet: '…TARGET_EVIDENCE\ntrailer',
    matchedTerms: ['a-token-that-does-not-map-directly'],
  }], 30_000);
  assert.match(normalizedOnly.text, /TARGET_EVIDENCE/);
  assert.deepEqual(normalizedOnly.includedPaths, ['normalized.md']);
});

test('bounded research sources never leave retained documents with an orphan source ID', () => {
  const oldOfficial = {
    id: 'W1', url: 'https://www.city-a.gov.cn/old', title: 'earlier official evidence',
    authorityLevel: 0, publishedAt: '2025-01-01',
  };
  const current = Array.from({ length: 10 }, (_, index) => ({
    id: `W${index + 2}`,
    url: `https://source-${index}.example/item`,
    title: `current ${index}`,
    authorityLevel: 5,
    publishedAt: '2026-01-01',
  }));
  const registry = new Map([oldOfficial, ...current].map((source) => [source.url, source]));
  const sources = taskManagerInternals.boundedResearchSources({
    priorSources: [],
    currentSources: current,
    registry,
    documents: [{ sourceId: 'W1', sourceIds: ['W1'], text: 'verified body' }],
    claims: [{ text: 'verified claim', sourceIds: ['W1'] }],
    limit: 10,
  });
  const documents = taskManagerInternals.retainDocumentsForSources(
    [{ sourceId: 'W1', sourceIds: ['W1'], text: 'verified body' }],
    sources,
  );

  assert.equal(sources.length, 10);
  assert.equal(sources.some((source) => source.id === 'W1'), true);
  assert.equal(documents.length, 1);
  assert.equal(
    documents.every((document) => document.sourceIds.every((id) => (
      sources.some((source) => source.id === id)
    ))),
    true,
  );

  const displaced = taskManagerInternals.boundedResearchSources({
    priorSources: [],
    currentSources: current.map((source) => ({ ...source, authorityLevel: 0 })),
    registry: new Map([oldOfficial, ...current].map((source) => [source.url, {
      ...source,
      authorityLevel: source.id === 'W1' ? 6 : 0,
    }])),
    documents: [{ sourceId: 'W1', sourceIds: ['W1'], text: 'low-authority body' }],
    claims: [],
    limit: 10,
  });
  assert.equal(displaced.some((source) => source.id === 'W1'), false);
  assert.deepEqual(taskManagerInternals.retainDocumentsForSources(
    [{ sourceId: 'W1', sourceIds: ['W1'], text: 'low-authority body' }],
    displaced,
  ), []);

  assert.deepEqual(taskManagerInternals.retainDocumentsForSources(
    [{ sourceId: 'W1', sourceIds: ['W1', 'W2'], text: 'combined body' }],
    [{ id: 'W1' }],
  ), [], 'a combined body must not be relabelled after one source is pruned');

  const unreferencedPrior = taskManagerInternals.boundedResearchSources({
    priorSources: [oldOfficial],
    currentSources: current.slice(0, 1),
    registry,
    documents: [],
    claims: [],
    limit: 10,
  });
  assert.equal(
    unreferencedPrior.some((source) => source.id === 'W1'),
    false,
    'prior source metadata must not become citable without a current claim or document reference',
  );
});

test('document budget is global and never appends or charges beyond the remaining space', () => {
  const documents = [{ sourceId: 'W1', sourceIds: ['W1'], text: '12345678' }];
  assert.equal(taskManagerInternals.remainingDocumentBudget(documents, 10), 2);
  assert.equal(taskManagerInternals.appendBoundedDocuments(documents, [{
    sourceId: 'W2', sourceIds: ['W2'], text: 'abcdef',
  }], 10), 1);
  assert.equal(documents[1].text, 'ab');
  assert.equal(taskManagerInternals.remainingDocumentBudget(documents, 10), 0);
  assert.equal(taskManagerInternals.appendBoundedDocuments(documents, [{
    sourceId: 'W3', sourceIds: ['W3'], text: 'must-not-enter',
  }], 10), 0);
});

test('Deep uses a safe top-k fallback when an older programmatic config has no deep block', async (t) => {
  const project = await temporaryProject('second-mind-deep-legacy-config-');
  t.after(project.cleanup);
  const conversations = new ConversationStore(project.config.conversationFile);
  const searches = [];
  const manager = new TaskManager({
    ...project.config,
    appName: 'Second Mind', vaultLabel: 'Legacy fixture', timezone: 'UTC',
    llm: { provider: 'openai-compatible', model: 'fixture', maxOutputTokens: 512 },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 3, maxContextChars: 2_000 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  }, {
    index: {
      ready: Promise.resolve(),
      status: () => ({ available: true }),
      search: async (_query, options) => {
        searches.push(options.limit);
        return { route: 'keyword', results: [], diagnostics: {} };
      },
      close: async () => {},
    },
    store: { ready: Promise.resolve(), cleanupDrafts: async () => {} },
    llm: {
      generate: async (messages) => messages[0]?.content.includes('bounded search queries')
        ? '{"queries":[]}' : 'No source was found.',
    },
    conversations,
  });
  t.after(() => manager.close());
  await manager.ready;
  const created = await manager.createTask('admin', { kind: 'qa', prompt: 'question', taskMode: 'deep' });
  await manager.getTask('admin', created.taskId).runPromise;
  assert.deepEqual(searches, [6]);
});

test('late cancellation cannot race a result already entering its atomic state commit', async (t) => {
  const fixture = await deepFixture(t);
  const originalSave = fixture.conversations.save.bind(fixture.conversations);
  let saveCalls = 0;
  let releaseCommit;
  let commitStarted;
  const enteredCommit = new Promise((resolve) => { commitStarted = resolve; });
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  fixture.conversations.save = async (snapshot) => {
    saveCalls += 1;
    if (saveCalls === 2) {
      commitStarted();
      await commitGate;
    }
    return originalSave(snapshot);
  };

  const created = await fixture.manager.createTask('admin', {
    kind: 'qa', prompt: 'commit race', taskMode: 'normal',
  });
  const task = fixture.manager.getTask('admin', created.taskId);
  await enteredCommit;
  assert.deepEqual(fixture.manager.cancel('admin', task.id), { ok: true, status: 'completing' });
  releaseCommit();
  await task.runPromise;
  assert.equal(task.status, 'completed');
});
