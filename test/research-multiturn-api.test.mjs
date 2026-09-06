import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConversationStore } from '../src/conversation-store.mjs';
import { createApp } from '../src/server.mjs';
import { temporaryProject } from './helpers.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function contextualizedFirstQuestion() {
  return {
    standaloneQuestion: '甲州投控集团董事长是谁',
    subject: { name: '甲州投控集团', type: 'organization', aliases: ['甲州投控集团'] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '现任董事长', terms: ['董事长', '任命'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  };
}

function contextualizedFollowUp() {
  return {
    standaloneQuestion: '甲州投控集团党委书记、董事长测试人物甲是什么行政级别',
    subject: { name: '测试人物甲', type: 'person', aliases: [] },
    requiredAnchors: ['甲州', '投控集团', '投资控股'],
    intent: {
      label: '行政级别',
      terms: ['市管干部', '任前公示', '市管一级企业正职', '任命'],
    },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [
      '甲州投控集团党委书记、董事长测试人物甲是什么行政级别',
      '甲州组织部 测试人物甲 市管干部 任前公示',
      '甲州投控集团 测试人物甲 市管一级企业正职',
      '测试人物甲 甲州投控集团 履历 任命',
    ],
  };
}

class MultiTurnResearchLlm {
  constructor() {
    this.calls = [];
    this.contextualizerCalls = [];
    this.evaluatorCalls = [];
    this.finalCalls = [];
  }

  publicStatus() {
    return { provider: 'fixture', model: 'qwen-fixture', configured: true };
  }

  async generate(messages, options = {}) {
    const call = { messages: structuredClone(messages), options: { ...options, signal: undefined } };
    this.calls.push(call);
    const system = messages.find((message) => message.role === 'system')?.content || '';
    const user = messages.at(-1)?.content || '';

    if (system.includes('conversation contextualizer')) {
      this.contextualizerCalls.push(call);
      return JSON.stringify(
        user.includes('<original_question>\n测试人物甲是什么级别\n</original_question>')
          ? contextualizedFollowUp()
          : contextualizedFirstQuestion(),
      );
    }

    if (system.includes('evidence evaluator')) {
      this.evaluatorCalls.push(call);
      return JSON.stringify({
        sufficient: true,
        confidence: 0.94,
        claims: [
          {
            text: '公开任前公示和任免材料直接确认测试人物甲属于市管干部，并担任甲州投控集团党委书记、董事长。',
            sourceIds: ['W1'],
            direct: true,
            asOf: '2026-09-02',
          },
          {
            text: '正处级是根据市管一级企业正职岗位规格作出的推断，公开材料未直接标注该行政级别。',
            sourceIds: ['W1'],
            direct: false,
            asOf: '2026-09-02',
          },
        ],
        conflicts: [],
        gaps: [],
        nextQueries: [],
        readSourceIds: [],
      });
    }

    this.finalCalls.push(call);
    const answer = user.includes('行政级别')
      ? [
          '公开材料直接确认：测试人物甲属于甲州市管干部，并任甲州投控集团党委书记、董事长。[W1]',
          '',
          '“正处级”不是现有材料直接写明的结论，而是依据市管一级企业正职岗位规格作出的推断；暂未发现其高配副厅级的公开依据。[W1]',
          '',
          '### 联网来源',
          '- 这一段由模型错误生成，后端应删除并只生成一次。',
        ].join('\n')
      : '甲州投控集团现任党委书记、董事长为测试人物甲。[W1]';
    options.onToken?.(answer);
    return answer;
  }
}

function appConfig(project) {
  return {
    ...project.config,
    projectRoot,
    publicDir: path.join(projectRoot, 'public'),
    appName: 'Second Mind research fixture',
    vaultLabel: 'Fixture Vault',
    host: '127.0.0.1',
    port: 0,
    timezone: 'UTC',
    trustProxy: false,
    auth: {
      username: 'admin',
      password: 'correct horse battery staple',
      sessionSecret: 'TEST_ONLY_NOT_A_REAL_SESSION_SECRET',
      sessionTtlSeconds: 3_600,
      secureCookie: false,
    },
    modelCatalog: [{
      id: 'qwen',
      label: 'Qwen fixture',
      actualModel: 'qwen-fixture',
      provider: 'fixture',
      efforts: ['medium'],
      defaultEffort: 'medium',
      available: true,
    }],
    llm: {
      provider: 'openai-compatible',
      apiBase: 'https://llm.invalid/v1',
      apiKey: 'fixture-only',
      model: 'qwen-fixture',
      timeoutMs: 1_000,
      maxOutputTokens: 2_048,
      temperature: 0,
      allowInsecureHttp: false,
    },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 8, maxContextChars: 20_000, watch: false, reconcileIntervalMs: 60_000 },
    deep: { enabled: true, topK: 12 },
    research: { contextualizerEnabled: true, loopEnabled: true },
    webSearch: {
      provider: 'bailian-mcp',
      enabled: true,
      apiKey: 'fixture-only',
      resultCount: 15,
      deepResultCount: 6,
      maxResultsPerDomain: 2,
      modelSourceLimit: 10,
      timeoutMs: 60_000,
      maxContextChars: 30_000,
    },
    webReader: { enabled: true, normalMaxPages: 2, deepMaxPagesPerRound: 3 },
    responsesFallback: { enabled: false },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const body = await response.json();
  return { response, body };
}

function parseEvents(text) {
  return text.split(/\n\n+/u).map((block) => {
    const type = block.match(/^event:\s*(.+)$/mu)?.[1];
    const data = block.match(/^data:\s*(.+)$/mu)?.[1];
    return type && data ? { type, data: JSON.parse(data) } : null;
  }).filter(Boolean);
}

function relevantWebCandidate(queryIndex, turn) {
  return {
    title: turn === 1
      ? '甲州投控集团召开干部会议，测试人物甲任党委书记、董事长'
      : `甲州组织部任前公示：测试人物甲（路径 ${queryIndex + 1}）`,
    url: `https://${turn === 1 ? 'www' : `zzb-${queryIndex}`}.city-a.gov.cn/notices/${turn}-${queryIndex}`,
    snippet: turn === 1
      ? '甲州政府公开信息显示，甲州投控集团党委书记、董事长为测试人物甲，相关任命已经生效。'
      : '甲州组织部公开材料确认测试人物甲属于市管干部，现任甲州投控集团党委书记、董事长；市管一级企业正职岗位规格需与行政级别直接表述区分。',
    source: '甲州政府',
    publishedAt: '2026-08-30',
    queryIndex,
  };
}

function crossEntityCandidates(queryIndex, turn) {
  return [{
    title: '演员测试人物甲获奖经历与示例高级演员职称讨论',
    url: `https://baike.baidu.com/item/actor-test-person-a-${turn}-${queryIndex}`,
    snippet: '演员测试人物甲参演电影和话剧，娱乐行业文章讨论她的演员职称。',
    source: '百度百科',
    publishedAt: '2026-08-20',
    queryIndex,
  }, {
    title: '示例理工大学教师测试人物甲科研项目',
    url: `https://teacher.example.edu.cn/test-person-a/project-${turn}-${queryIndex}`,
    snippet: '示例理工副教授测试人物甲从事交通系统科研，介绍教师职称和科研项目。',
    source: '示例理工大学',
    publishedAt: '2026-08-21',
    queryIndex,
  }];
}

test('authenticated API preserves a refreshed conversation and keeps a Deep follow-up on the anchored entity', async (t) => {
  const project = await temporaryProject('vaultmind-research-multiturn-');
  const llm = new MultiTurnResearchLlm();
  const conversations = new ConversationStore(project.config.conversationFile);
  const indexQueries = [];
  const webRounds = [];
  const readerCalls = [];
  let paidFallbackCalls = 0;
  const audits = [];
  let app;

  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 2, chunks: 2, semanticAvailable: true }),
    search: async (query) => {
      indexQueries.push(query);
      const followUp = query.includes('测试人物甲') && /行政级别|市管干部|任前公示|市管一级企业正职|任命/u.test(query);
      return {
        route: 'hybrid',
        results: [{
          path: 'records/甲州投控集团任免.md',
          content: followUp
            ? '甲州投控集团测试人物甲任免记录：测试人物甲为市管干部；行政级别需要区分直接记载和岗位规格推断。'
            : '甲州投控集团任免记录：党委书记、董事长为测试人物甲。',
          matchedTerms: ['甲州', '投控集团'],
        }, {
          path: 'people/演员测试人物甲.md',
          content: '演员测试人物甲从事电影和话剧表演，资料仅涉及影视行业履历。',
          matchedTerms: ['测试人物甲'],
        }],
        diagnostics: { embeddingUsed: false },
      };
    },
    close: async () => {},
  };
  const store = {
    ready: Promise.resolve(),
    cleanupDrafts: async () => {},
    auditBestEffort: async (entry) => { audits.push(entry); return []; },
  };
  const webSearch = {
    publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
    searchMany: async (queries, options = {}) => {
      const turn = webRounds.length + 1;
      webRounds.push([...queries]);
      const evidenceCandidates = [];
      for (const [queryIndex, query] of queries.entries()) {
        options.onActivity?.({ stage: 'start', index: queryIndex, total: queries.length, query });
        evidenceCandidates.push(
          relevantWebCandidate(queryIndex, turn),
          ...crossEntityCandidates(queryIndex, turn),
        );
        options.onActivity?.({ stage: 'complete', index: queryIndex, total: queries.length, resultCount: 3 });
      }
      return {
        evidenceCandidates,
        candidates: evidenceCandidates,
        results: evidenceCandidates,
        attempts: queries.map((_query, index) => ({
          queryHash: `mock-hash-${turn}-${index}`,
          status: 'completed',
          resultCount: 3,
          durationMs: 1,
        })),
        errors: [],
        queryCount: queries.length,
      };
    },
  };
  const webReader = {
    publicStatus: () => ({ enabled: true, configured: true, pdfAvailable: true }),
    readMany: async ({ sources, sourceIds }) => {
      readerCalls.push({
        sourceIds: [...sourceIds],
        titles: sources.map((source) => source.title),
      });
      return {
        documents: sourceIds.map((sourceId) => ({
          sourceId,
          title: sources.find((source) => source.id === sourceId)?.title || sourceId,
          text: '甲州政府网页正文确认，甲州投控集团党委书记、董事长为测试人物甲。',
          fetchedAt: '2026-09-02T00:00:00.000Z',
        })),
        attempts: sourceIds.map((sourceId) => ({
          sourceId,
          urlHash: `mock-url-hash-${sourceId}`,
          authority: 'government_or_appointment',
          status: 'completed',
          durationMs: 1,
          byteLength: 100,
          httpStatus: 200,
        })),
        errors: [],
      };
    },
  };
  const responsesExtractor = {
    publicStatus: () => ({ enabled: false, configured: false }),
    extract: async () => {
      paidFallbackCalls += 1;
      throw new Error('Responses fallback must never run in this mock regression.');
    },
  };

  t.after(async () => {
    if (app) {
      await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await project.cleanup();
  });

  app = await createApp(appConfig(project), {
    llm, index, store, webSearch, webReader, responsesExtractor, conversations,
    allowLegacyTestEngine: true,
  });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const login = await requestJson(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie');
  const readHeaders = { cookie, 'x-vaultmind-request': '1' };
  const writeHeaders = { ...readHeaders, 'content-type': 'application/json' };

  const normal = await requestJson(base, '/api/knowledge/tasks', {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({
      kind: 'qa',
      prompt: '甲州投控集团董事长是谁',
      taskMode: 'normal',
      model: 'qwen',
      effort: 'medium',
      webSearch: true,
    }),
  });
  assert.equal(normal.response.status, 201);
  const normalStream = await fetch(`${base}/api/knowledge/tasks/${normal.body.taskId}/events`, {
    headers: readHeaders,
  });
  const normalEvents = parseEvents(await normalStream.text());
  assert.equal(normalEvents.at(-1)?.data.status, 'completed');
  assert.equal(webRounds.length, 1);
  assert.deepEqual(webRounds[0], ['甲州投控集团董事长是谁']);
  assert.ok(readerCalls[0].sourceIds.length > 0 && readerCalls[0].sourceIds.length <= 2);
  assert.equal(readerCalls[0].titles.some((title) => /演员|示例理工大学/u.test(title)), false);

  // A browser reload rehydrates from the opaque conversation ID: list, then fetch
  // the selected completed conversation before submitting the next turn.
  const afterRefreshList = await requestJson(base, '/api/knowledge/conversations', { headers: readHeaders });
  assert.equal(afterRefreshList.response.status, 200);
  assert.equal(afterRefreshList.body.conversations.length, 1);
  assert.equal(afterRefreshList.body.conversations[0].id, normal.body.conversationId);
  assert.equal(afterRefreshList.body.conversations[0].activeTask, false);
  const restored = await requestJson(
    base,
    `/api/knowledge/conversations/${encodeURIComponent(normal.body.conversationId)}`,
    { headers: readHeaders },
  );
  assert.equal(restored.response.status, 200);
  assert.deepEqual(restored.body.messages.map((message) => message.role), ['user', 'assistant']);
  assert.match(restored.body.messages.at(-1).content, /测试人物甲/u);

  const deep = await requestJson(base, '/api/knowledge/tasks', {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({
      kind: 'qa',
      prompt: '测试人物甲是什么级别',
      taskMode: 'deep',
      conversationId: normal.body.conversationId,
      model: 'qwen',
      effort: 'medium',
      webSearch: true,
    }),
  });
  assert.equal(deep.response.status, 201);
  assert.equal(deep.body.conversationId, normal.body.conversationId);
  assert.equal(deep.body.forkedFromConversationId, null);
  assert.equal(deep.body.taskMode, 'deep');
  const deepStream = await fetch(`${base}/api/knowledge/tasks/${deep.body.taskId}/events`, {
    headers: readHeaders,
  });
  const deepEvents = parseEvents(await deepStream.text());
  assert.equal(deepEvents.at(-1)?.data.status, 'completed');

  assert.equal(llm.contextualizerCalls.length, 2);
  const followUpContext = llm.contextualizerCalls[1].messages.at(-1).content;
  assert.match(followUpContext, /<conversation_state>/u);
  assert.match(followUpContext, /甲州投控集团/u);
  assert.match(followUpContext, /<recent_messages>/u);
  assert.match(followUpContext, /甲州投控集团董事长是谁/u);
  assert.match(followUpContext, /测试人物甲.*党委书记、董事长|党委书记、董事长.*测试人物甲/u);

  assert.equal(webRounds.length, 2);
  const deepVaultQueries = indexQueries.slice(1);
  const deepWebQueries = webRounds[1];
  assert.ok(
    deepVaultQueries.length >= 2 && deepVaultQueries.length <= 4,
    'Deep must retain two to four safe complementary paths after continuity repair',
  );
  assert.deepEqual(deepWebQueries, deepVaultQueries);
  for (const query of [...deepVaultQueries, ...deepWebQueries]) {
    assert.match(query, /测试人物甲/u);
    assert.match(query, /甲州|投控集团|投资控股/u);
    assert.match(query, /行政级别|市管干部|任前公示|市管一级企业正职|任命/u);
    assert.doesNotMatch(query, /演员|示例高级演员职称|示例理工|教授/u);
  }

  assert.equal(llm.evaluatorCalls.length, 2);
  const evaluatorPrompt = llm.evaluatorCalls.at(-1).messages.at(-1).content;
  const finalPrompt = llm.finalCalls.at(-1).messages.at(-1).content;
  for (const prompt of [evaluatorPrompt, finalPrompt]) {
    assert.match(prompt, /甲州投控集团/u);
    assert.match(prompt, /测试人物甲/u);
    assert.doesNotMatch(prompt, /演员测试人物甲|示例高级演员职称|示例理工大学|示例理工副教授/u);
  }

  const completedConversation = await requestJson(
    base,
    `/api/knowledge/conversations/${encodeURIComponent(normal.body.conversationId)}`,
    { headers: readHeaders },
  );
  assert.equal(completedConversation.body.messages.length, 4);
  const finalAnswer = completedConversation.body.messages.at(-1).content;
  assert.match(finalAnswer, /公开材料直接确认/u);
  assert.match(finalAnswer, /正处级.*推断/u);
  assert.match(finalAnswer, /不是.*直接写明/u);
  assert.equal(finalAnswer.match(/### 联网来源/gu)?.length, 1);
  assert.doesNotMatch(finalAnswer, /演员测试人物甲|示例理工大学|示例理工副教授/u);
  assert.equal(paidFallbackCalls, 0);
  assert.equal(audits.filter((entry) => entry.action === 'research_task').length, 2);

  const reloadedStore = new ConversationStore(project.config.conversationFile);
  await reloadedStore.ready;
  const reloaded = reloadedStore.get('admin', normal.body.conversationId);
  assert.equal(reloaded.messages.length, 4);
  assert.equal(reloaded.messages.at(-1).content, finalAnswer);
  assert.equal(reloaded.researchContext.subject.name, '测试人物甲');
});
