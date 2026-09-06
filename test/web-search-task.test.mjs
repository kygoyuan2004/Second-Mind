import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import test from 'node:test';

import { ConversationStore } from '../src/conversation-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { VaultStore } from '../src/vault-store.mjs';
import { temporaryProject } from './helpers.mjs';

const MODELS = ['qwen', 'kimi', 'deepseek'].map((id) => ({
  id,
  label: id,
  actualModel: `${id}-model`,
  efforts: ['medium'],
  defaultEffort: 'medium',
  available: true,
}));

async function fixture(t, options = {}) {
  const project = await temporaryProject('second-mind-web-task-');
  t.after(project.cleanup);
  const modelCalls = [];
  const webCalls = [];
  const webRequests = [];
  const audits = [];
  const auditWriter = {
    auditFile: project.config.auditFile,
    audit: VaultStore.prototype.audit,
  };
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 1, chunks: 1, semanticAvailable: true }),
    search: async (query) => ({
      route: 'hybrid',
      results: [{ path: 'vault/source.md', content: `Vault evidence for ${query}`, matchedTerms: ['evidence'] }],
      diagnostics: { embeddingUsed: true },
    }),
    close: async () => {},
  };
  const store = {
    ready: Promise.resolve(),
    cleanupDrafts: async () => {},
    auditBestEffort: async (event) => {
      audits.push(event);
      if (!options.persistAudit) return [];
      return VaultStore.prototype.auditBestEffort.call(auditWriter, event);
    },
    prepareDated: async () => ({ date: '2026-09-01', template: '', current: '' }),
    createDraft: async ({ content }) => ({ id: 'draft-fixture', content, targetRelative: 'plan.md' }),
    deleteDraft: async () => {},
  };
  const llm = {
    generate: async (messages, generateOptions) => {
      modelCalls.push({ messages, options: generateOptions });
      if (messages[0]?.content.includes('bounded search queries')) {
        return options.plannerOutput || '{"queries":["facet one","facet two"]}';
      }
      const answer = options.answer || 'Grounded answer [[vault/source.md]] with [verified](https://example.com/source) and [invented](https://invalid.example/fake).';
      generateOptions.onToken?.(answer);
      return answer;
    },
  };
  const webSearch = {
    publicStatus: () => ({
      enabled: options.enabled !== false,
      configured: options.configured !== false,
      provider: 'bailian-mcp',
    }),
    searchMany: async (queries, searchOptions) => {
      webRequests.push({
        queries: [...queries],
        resultCount: searchOptions.resultCount,
        maxResultsPerDomain: searchOptions.maxResultsPerDomain,
      });
      if (options.setupFailure) {
        searchOptions.onActivity?.({
          stage: 'error', index: null, queryIndex: null, total: queries.length,
          code: options.setupFailure,
        });
        return {
          results: [], attempts: [],
          errors: [{ queryIndex: null, code: options.setupFailure }],
          queryCount: queries.length,
        };
      }
      for (const [index, query] of queries.entries()) {
        webCalls.push(query);
        searchOptions.onActivity?.({ stage: 'start', index, total: queries.length, query });
      }
      if (options.searchResult) return options.searchResult(queries, searchOptions);
      const results = queries.map((_query, queryIndex) => ({
        title: queryIndex ? `Source ${queryIndex + 1}` : 'Verified source',
        url: queryIndex ? `https://example.com/source-${queryIndex + 1}` : 'https://example.com/source',
        snippet: `External evidence ${queryIndex + 1}`,
        source: 'example.com',
        publishedAt: '2026-09-01',
        queryIndex,
      }));
      for (const [index] of queries.entries()) {
        searchOptions.onActivity?.({ stage: 'complete', index, total: queries.length, resultCount: 1 });
      }
      return {
        results,
        candidates: results,
        attempts: queries.map((_query, index) => ({
          queryHash: `hash-${index}`, status: 'completed', resultCount: 1, durationMs: 5,
        })),
        errors: [],
        queryCount: queries.length,
      };
    },
  };
  const config = {
    ...project.config,
    appName: 'Second Mind', vaultLabel: 'Fixture Vault', timezone: 'UTC',
    modelCatalog: MODELS,
    llm: { provider: 'anthropic', model: 'qwen-model', maxOutputTokens: 3_000, temperature: null },
    embedding: { provider: 'dashscope', model: 'embedding', dimensions: 1_024 },
    webSearch: {
      provider: 'bailian-mcp', enabled: true, apiKey: 'fixture', resultCount: 15,
      deepResultCount: 6, maxResultsPerDomain: 2, modelSourceLimit: 10,
      timeoutMs: 60_000, maxContextChars: 30_000,
    },
    retrieval: { topK: 8, maxContextChars: 30_000 },
    deep: { enabled: true, topK: 16 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
  const manager = new TaskManager(config, {
    index, store, llm, webSearch, conversations, allowLegacyTestEngine: true,
  });
  t.after(() => manager.close());
  await manager.ready;
  return {
    manager,
    conversations,
    modelCalls,
    webCalls,
    webRequests,
    audits,
    auditFile: project.config.auditFile,
  };
}

function replaySse(manager, taskId) {
  const request = new EventEmitter();
  request.headers = {};
  let output = '';
  const response = {
    writeHead: () => {},
    write: (chunk) => { output += String(chunk || ''); return true; },
    end: (chunk = '') => { output += String(chunk || ''); },
  };
  manager.subscribe('admin', taskId, request, response);
  return output;
}

test('Web Search is strict, opt-in, QA-only, public, and fixed for a conversation', async (t) => {
  const value = await fixture(t);
  assert.deepEqual((await value.manager.publicStatus('admin')).webSearch, {
    enabled: true, configured: true, provider: 'bailian-mcp', bindingRevision: null,
    fallbackConfigured: false,
  });
  await assert.rejects(
    () => value.manager.createTask('admin', { kind: 'qa', prompt: 'bad', webSearch: 'true' }),
    { code: 'INVALID_WEB_SEARCH' },
  );

  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'First turn', model: 'qwen', effort: 'medium', webSearch: false,
  });
  await value.manager.getTask('admin', created.taskId).runPromise;
  const conversation = value.conversations.get('admin', created.conversationId);
  const messagesBeforeMismatch = conversation.messages.length;
  assert.equal(value.webCalls.length, 0);
  assert.equal(value.conversations.list('admin')[0].webSearch, false);

  await assert.rejects(
    () => value.manager.createTask('admin', {
      kind: 'qa', prompt: 'Changed permission', conversationId: created.conversationId,
      model: 'qwen', effort: 'medium', webSearch: true,
    }),
    { code: 'CONVERSATION_SETTINGS_CHANGED' },
  );
  assert.equal(conversation.messages.length, messagesBeforeMismatch);

  const plan = await value.manager.createTask('admin', {
    kind: 'plan', prompt: 'Create a plan', model: 'qwen', effort: 'medium', webSearch: true,
  });
  const planTask = value.manager.getTask('admin', plan.taskId);
  await planTask.runPromise;
  assert.equal(planTask.webSearch, false);
  assert.equal(value.webCalls.length, 0);
});

test('Normal searches once and every final model receives verified Web sources as plain text', async (t) => {
  const value = await fixture(t);
  for (const model of MODELS) {
    const created = await value.manager.createTask('admin', {
      kind: 'qa', prompt: `Latest facts for ${model.id}`, model: model.id, effort: 'medium', webSearch: true,
    });
    const task = value.manager.getTask('admin', created.taskId);
    await task.runPromise;
    assert.equal(task.status, 'completed');
    assert.equal(value.manager.publicTask(task).webSearch, true);
    const finalCall = value.modelCalls.at(-1);
    assert.equal(finalCall.options.model, model.actualModel);
    assert.equal(typeof finalCall.options.onToken, 'function',
      'final calls capture partial output locally so an explicit token-limit stop can be continued once');
    assert.match(finalCall.messages.at(-1).content, /<web_sources>/);
    assert.match(finalCall.messages.at(-1).content, /https:\/\/example\.com\/source/);
  }
  assert.equal(value.webCalls.length, 3);
  assert.deepEqual(value.webRequests.map((request) => request.resultCount), [15, 15, 15]);
  assert.deepEqual(value.webRequests.map((request) => request.maxResultsPerDomain), [2, 2, 2]);
  const stored = value.conversations.get('admin', [...value.conversations.conversations.keys()].at(-1));
  const answer = stored.messages.at(-1).content;
  assert.match(answer, /### 联网来源/);
  assert.match(answer, /https:\/\/example\.com\/source/);
  assert.doesNotMatch(answer, /https:\/\/invalid\.example/);
  assert.doesNotMatch(answer, /### Sources/);
  assert.equal(answer.match(/\[\[vault\/source\.md\]\]/g)?.length, 1);
});

test('Deep mode sends every unique retrieval query to Web Search without a one-call cap', async (t) => {
  const value = await fixture(t);
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Original question', taskMode: 'deep', model: 'qwen', effort: 'medium', webSearch: true,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;
  assert.equal(task.status, 'completed');
  assert.deepEqual(value.webCalls, ['Original question', 'facet one', 'facet two']);
  assert.equal(value.webRequests[0].resultCount, 6);
  assert.equal(value.audits.length, 1);
  assert.deepEqual(value.audits[0].attempts.map((item) => item.queryHash), ['hash-0', 'hash-1', 'hash-2']);
  assert.equal(JSON.stringify(value.audits).includes('Original question'), false);
  assert.ok(task.events.filter((event) => event.data?.toolName === 'bailian_web_search' && event.data.stage === 'start').length === 3);
});

test('Deep Web sources are round-robin balanced, capped at ten, and exposed as safe candidate metadata', async (t) => {
  const value = await fixture(t, {
    answer: 'Grounded answer [[vault/source.md]] without an external citation.',
    searchResult: async (queries, searchOptions) => {
      const make = (queryIndex, name, itemIndex, url = `https://round.example/${name}${itemIndex}`) => ({
        title: `${name.toUpperCase()} ${itemIndex}`,
        url,
        snippet: `${'&<>'.repeat(20)} evidence for group ${name} item ${itemIndex}`,
        source: 'round.example',
        publishedAt: '2026-09-01',
        queryIndex,
        selected: true,
        selectionReason: 'selected',
      });
      const grouped = [
        Array.from({ length: 5 }, (_unused, index) => make(0, 'a', index)),
        [
          make(1, 'duplicate', 0, 'https://round.example/a0'),
          ...Array.from({ length: 3 }, (_unused, index) => make(1, 'b', index + 1)),
        ],
        Array.from({ length: 4 }, (_unused, index) => make(2, 'c', index)),
      ];
      const results = grouped.flat();
      const candidates = [
        ...results,
        {
          title: 'Candidate only\nwith compacted title',
          url: 'https://round.example/candidate-only',
          snippet: 'This must never enter the activity event.',
          source: 'round.example',
          publishedAt: '',
          queryIndex: 2,
          selected: false,
          selectionReason: 'context_limit',
        },
      ];
      for (const [index] of queries.entries()) {
        searchOptions.onActivity?.({
          stage: 'complete', index, total: queries.length, queryIndex: index,
          resultCount: grouped[index].length,
        });
      }
      return {
        results,
        candidates,
        attempts: queries.map((_query, index) => ({
          queryHash: `round-${index}`, status: 'completed', resultCount: grouped[index].length, durationMs: 2,
        })),
        errors: [],
        queryCount: queries.length,
      };
    },
  });
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Original question', taskMode: 'deep',
    model: 'qwen', effort: 'medium', webSearch: true,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  const finalPrompt = value.modelCalls.at(-1).messages.at(-1).content;
  const webSources = finalPrompt.match(/<web_sources>\n([\s\S]*?)\n<\/web_sources>/u)?.[1] || '';
  const urls = [...webSources.matchAll(/ url="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(urls, [
    'https://round.example/a0',
    'https://round.example/c0',
    'https://round.example/a1',
    'https://round.example/b1',
    'https://round.example/c1',
    'https://round.example/a2',
    'https://round.example/b2',
    'https://round.example/c2',
    'https://round.example/a3',
    'https://round.example/b3',
  ]);
  assert.ok(webSources.length <= 30_000);

  const webActivities = task.events.filter((event) => event.data?.toolName === 'bailian_web_search');
  const candidatesEvent = webActivities.at(-1);
  assert.equal(candidatesEvent.type, 'activity');
  assert.equal(candidatesEvent.data.stage, 'web_candidates');
  assert.equal(candidatesEvent.data.candidateCount, 13);
  assert.equal(candidatesEvent.data.includedCount, 10);
  assert.equal(candidatesEvent.data.candidateSources.length, 13);
  assert.doesNotMatch(candidatesEvent.data.message, /https:\/\//u);
  assert.doesNotMatch(candidatesEvent.data.message, /Original question/u);
  assert.deepEqual(Object.keys(candidatesEvent.data.candidateSources[0]).sort(), [
    'included', 'publishedAt', 'queryIndex', 'reason', 'source', 'title', 'url',
  ]);
  assert.equal(candidatesEvent.data.candidateSources[0].queryIndex, 0);
  assert.ok(candidatesEvent.data.candidateSources.every((item) => item.url.startsWith('https://')));
  assert.equal(JSON.stringify(candidatesEvent.data.candidateSources).includes('snippet'), false);
  assert.equal(JSON.stringify(candidatesEvent.data.candidateSources).includes('evidence for group'), false);
  assert.equal(candidatesEvent.data.candidateSources.at(-1).included, false);
  assert.equal(candidatesEvent.data.candidateSources.at(-1).reason, 'context_limit');
});

test('Web appendix includes only allowlisted URLs actually cited by the answer', async (t) => {
  const citedUrl = 'https://sources.example/cited';
  const unusedUrl = 'https://sources.example/unused';
  const value = await fixture(t, {
    answer: `Answer without a Vault citation. [Used source](${citedUrl}) and [invented](https://invalid.example/fake).`,
    searchResult: async (queries, searchOptions) => {
      searchOptions.onActivity?.({ stage: 'complete', index: 0, total: 1, resultCount: 2 });
      const results = [
        { title: 'Cited', url: citedUrl, snippet: 'Cited evidence', source: 'sources.example', queryIndex: 0 },
        { title: 'Unused', url: unusedUrl, snippet: 'Unused evidence', source: 'sources.example', queryIndex: 0 },
      ];
      return {
        results, candidates: results,
        attempts: [{ queryHash: 'hash', status: 'completed', resultCount: 2, durationMs: 1 }],
        errors: [], queryCount: queries.length,
      };
    },
  });
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Use only one source', model: 'qwen', effort: 'medium', webSearch: true,
  });
  await value.manager.getTask('admin', created.taskId).runPromise;

  const answer = value.conversations.get('admin', created.conversationId).messages.at(-1).content;
  const appendix = answer.split('\n\n### 联网来源\n')[1];
  assert.ok(appendix);
  assert.match(appendix, /https:\/\/sources\.example\/cited/u);
  assert.doesNotMatch(appendix, /https:\/\/sources\.example\/unused/u);
  assert.doesNotMatch(answer, /https:\/\/invalid\.example/u);
  assert.doesNotMatch(answer, /### Sources/u);
  assert.doesNotMatch(answer, /\[\[vault\/source\.md\]\]/u);
});

test('legacy Web mode strips a model-authored source appendix before adding the server appendix', async (t) => {
  const value = await fixture(t, {
    answer: [
      'Verified fact [inline](https://example.com/source).',
      '',
      '#### Sources：',
      '- MODEL_AUTHORED_DUPLICATE',
    ].join('\n'),
  });
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'One appendix only', model: 'qwen', effort: 'medium', webSearch: true,
  });
  await value.manager.getTask('admin', created.taskId).runPromise;
  const answer = value.conversations.get('admin', created.conversationId).messages.at(-1).content;
  assert.equal(answer.match(/### 联网来源/gu)?.length, 1);
  assert.doesNotMatch(answer, /MODEL_AUTHORED_DUPLICATE/u);
});

test('No Vault or Web source appendix is invented when the answer cites neither', async (t) => {
  const value = await fixture(t, { answer: 'The supplied evidence is insufficient.' });
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Unanswered question', model: 'qwen', effort: 'medium', webSearch: true,
  });
  await value.manager.getTask('admin', created.taskId).runPromise;
  const answer = value.conversations.get('admin', created.conversationId).messages.at(-1).content;
  assert.equal(answer, 'The supplied evidence is insufficient.');
  assert.doesNotMatch(answer, /### Sources|### 联网来源|\[\[vault\/source\.md\]\]/u);
});

test('Web Search failures degrade to Vault-only answers without retries', async (t) => {
  const value = await fixture(t, {
    searchResult: async (queries, searchOptions) => {
      for (const [index] of queries.entries()) {
        searchOptions.onActivity?.({ stage: 'error', index, total: queries.length, code: 'UPSTREAM_FAILED' });
      }
      return {
        results: [], attempts: queries.map((_query, index) => ({
          queryHash: `failed-${index}`, status: 'failed', resultCount: 0, durationMs: 4, errorCode: 'UPSTREAM_FAILED',
        })),
        errors: queries.map((_query, queryIndex) => ({ queryIndex, code: 'UPSTREAM_FAILED' })),
        queryCount: queries.length,
      };
    },
  });
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Current answer', model: 'qwen', effort: 'medium', webSearch: true,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;
  assert.equal(task.status, 'completed');
  assert.deepEqual(value.webCalls, ['Current answer']);
  const conversation = value.conversations.get('admin', created.conversationId);
  assert.match(conversation.messages.at(-1).content, /联网搜索失败，本次仅依据知识库回答/);
  assert.doesNotMatch(conversation.messages.at(-1).content, /https:\/\//);
});

test('provider-controlled error codes are sanitized in SSE activity and persisted audit data', async (t) => {
  const privateCode = 'https://private-provider.example/v1';
  const safeCode = /^[A-Z][A-Z0-9_]{0,79}$/u;
  const value = await fixture(t, {
    persistAudit: true,
    searchResult: async () => {
      throw Object.assign(new Error('Synthetic provider failure.'), { code: privateCode });
    },
  });
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Use the safe fallback', model: 'qwen', effort: 'medium', webSearch: true,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  const activity = task.events.find((event) => (
    event.data?.toolName === 'bailian_web_search' && event.data?.stage === 'error'
  ));
  assert.ok(activity);
  assert.equal(activity.data.diagnostics.code, 'WEB_SEARCH_FAILED');
  assert.match(activity.data.diagnostics.code, safeCode);

  const eventPayload = JSON.stringify(task.events);
  const ssePayload = replaySse(value.manager, task.id);
  assert.doesNotMatch(eventPayload, /private-provider\.example|https?:\/\/|\/v1/u);
  assert.doesNotMatch(ssePayload, /private-provider\.example|https?:\/\/|\/v1/u);
  assert.match(ssePayload, /"code":"WEB_SEARCH_FAILED"/u);

  assert.equal(value.audits.length, 1);
  assert.deepEqual(value.audits[0].errorCodes, ['WEB_SEARCH_FAILED']);
  assert.ok(value.audits[0].errorCodes.every((code) => safeCode.test(code)));
  const persisted = await fsp.readFile(value.auditFile, 'utf8');
  assert.doesNotMatch(persisted, /private-provider\.example|https?:\/\/|\/v1/u);
  const records = persisted.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].errorCodes, ['WEB_SEARCH_FAILED']);
  assert.ok(records[0].errorCodes.every((code) => safeCode.test(code)));
});

test('MCP setup failures are actionable and retained as metadata-only audit status', async (t) => {
  const value = await fixture(t, { setupFailure: 'BAILIAN_WEB_SEARCH_NOT_ACTIVATED' });
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Current answer', model: 'qwen', effort: 'medium', webSearch: true,
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  const failure = task.events.find((event) => (
    event.data?.toolName === 'bailian_web_search' && event.data?.stage === 'error'
  ));
  assert.equal(failure.data.title, 'WebSearch MCP 初始化失败');
  assert.match(failure.data.message, /MCP 广场开通或重新开通/);
  assert.deepEqual(failure.data.diagnostics, {
    queryIndex: null,
    queryCount: 1,
    code: 'BAILIAN_WEB_SEARCH_NOT_ACTIVATED',
  });
  assert.equal(value.audits[0].status, 'failed');
  assert.equal(value.audits[0].attemptedCalls, 0);
  assert.deepEqual(value.audits[0].errorCodes, ['BAILIAN_WEB_SEARCH_NOT_ACTIVATED']);
  assert.equal(JSON.stringify(value.audits).includes('Current answer'), false);
});

test('enabled requests are rejected before mutation when the MCP client is unavailable', async (t) => {
  const value = await fixture(t, { configured: false });
  await assert.rejects(
    () => value.manager.createTask('admin', {
      kind: 'qa', prompt: 'Must search', model: 'qwen', effort: 'medium', webSearch: true,
    }),
    { code: 'WEB_SEARCH_UNAVAILABLE' },
  );
  assert.equal(value.conversations.list('admin').length, 0);
});
