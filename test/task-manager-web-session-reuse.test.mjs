import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversationStore } from '../src/conversation-store.mjs';
import { researchQueriesEquivalent } from '../src/research-pipeline.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { temporaryProject } from './helpers.mjs';

const QUESTION = '甲州投控集团董事长测试人物甲是什么行政级别';

function contextualizerOutput() {
  return JSON.stringify({
    standaloneQuestion: QUESTION,
    subject: { name: '测试人物甲', type: 'person', aliases: [] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '行政级别', terms: ['市管干部', '任前公示', '任命'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [
      QUESTION,
      '甲州组织部 测试人物甲 市管干部 任前公示',
    ],
  });
}

function sourceFor(query, callIndex, queryIndex) {
  const sequence = callIndex * 10 + queryIndex;
  const variants = [
    {
      host: 'www.city-a.gov.cn',
      title: '甲州投控集团董事长任免公告',
      snippet: '正式任免材料记载测试人物甲担任甲州投控集团董事长。',
    },
    {
      host: 'zzb.city-a.gov.cn',
      title: '甲州组织部市管干部公示',
      snippet: '任前公示介绍测试人物甲在甲州投控集团的履历与拟任岗位。',
    },
    {
      host: 'www.region-a.gov.cn',
      title: '甲地区国资干部岗位规格核验',
      snippet: '权威材料核对测试人物甲、甲州投控集团与市管一级企业正职。',
    },
  ];
  const selected = variants[Math.min(sequence, variants.length - 1)];
  return {
    title: selected.title,
    url: `https://${selected.host}/mock/${sequence}`,
    snippet: `${selected.snippet} 检索路径：${query}`,
    source: selected.host,
    publishedAt: `2026-0${Math.min(sequence + 1, 9)}-01`,
    queryIndex,
  };
}

test('Deep feedback rounds reuse one task-scoped MCP session and deduplicate every query', async (t) => {
  const project = await temporaryProject('vaultmind-web-session-reuse-');
  t.after(project.cleanup);

  const conversations = new ConversationStore(project.config.conversationFile);
  const searchedBatches = [];
  let openCount = 0;
  let closeCount = 0;
  let topLevelSearchCount = 0;
  let evaluationCount = 0;
  let modelCallCount = 0;

  const webSearch = {
    publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
    searchMany: async () => {
      topLevelSearchCount += 1;
      throw new Error('TaskManager must not bypass the task-scoped MCP session.');
    },
    openSession: async () => {
      openCount += 1;
      let closed = false;
      return {
        searchMany: async (queries, options = {}) => {
          const callIndex = searchedBatches.length;
          searchedBatches.push([...queries]);
          const evidenceCandidates = queries.map((query, queryIndex) => {
            options.onActivity?.({
              stage: 'start', index: queryIndex, total: queries.length, queryIndex, query,
            });
            const source = sourceFor(query, callIndex, queryIndex);
            options.onActivity?.({
              stage: 'complete', index: queryIndex, total: queries.length,
              queryIndex, resultCount: 1,
            });
            return source;
          });
          return {
            results: evidenceCandidates,
            candidates: evidenceCandidates,
            evidenceCandidates,
            attempts: queries.map((query, queryIndex) => ({
              queryIndex,
              status: 'completed',
              resultCount: 1,
              durationMs: 1,
            })),
            errors: [],
            queryCount: queries.length,
          };
        },
        close: async () => {
          assert.equal(closed, false, 'the task-scoped session must be closed at most once');
          closed = true;
          closeCount += 1;
        },
      };
    },
  };

  const llm = {
    generate: async (messages) => {
      modelCallCount += 1;
      const system = String(messages[0]?.content || '');
      if (system.includes('conversation contextualizer')) return contextualizerOutput();
      if (system.includes('evidence evaluator')) {
        evaluationCount += 1;
        if (evaluationCount === 1) {
          return JSON.stringify({
            sufficient: false,
            confidence: 0.55,
            claims: [],
            conflicts: [],
            gaps: ['需要核对市管一级企业正职的岗位规格'],
            nextQueries: ['甲州国资委 投控集团 测试人物甲 市管一级企业正职 行政级别'],
            readSourceIds: [],
          });
        }
        return JSON.stringify({
          sufficient: true,
          confidence: 0.9,
          claims: [{
            text: '测试人物甲在甲州投控集团的行政级别需依据市管岗位规格判断。',
            sourceIds: ['W1'],
            direct: true,
            asOf: '2026-09-02',
          }],
          conflicts: [],
          gaps: [],
          nextQueries: [],
          readSourceIds: [],
        });
      }
      return '公开材料显示，测试人物甲的岗位规格需结合正式任免文件判断。[W1]';
    },
  };

  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 0, chunks: 0, semanticAvailable: false }),
    search: async () => ({ route: 'lexical', results: [], diagnostics: {} }),
    close: async () => {},
  };
  const store = {
    ready: Promise.resolve(),
    cleanupDrafts: async () => {},
    auditBestEffort: async () => [],
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
    embedding: { timeoutMs: 1_000 },
    deep: { enabled: true, topK: 12 },
    research: { contextualizerEnabled: true, loopEnabled: true },
    webSearch: {
      enabled: true, resultCount: 15, deepResultCount: 6, maxResultsPerDomain: 2,
      modelSourceLimit: 10, maxContextChars: 30_000, timeoutMs: 1_000,
    },
    webReader: { enabled: false, totalMaxChars: 40_000 },
    responsesFallback: { enabled: false, timeoutMs: 1_000 },
  };
  const manager = new TaskManager(config, {
    index, store, llm, webSearch, conversations,
  });
  t.after(() => manager.close());
  await manager.ready;

  const created = await manager.createTask('admin', {
    kind: 'qa', prompt: QUESTION, taskMode: 'deep', model: 'qwen',
    effort: 'medium', webSearch: true,
  });
  const task = manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(openCount, 1);
  assert.equal(closeCount, 1);
  assert.equal(topLevelSearchCount, 0);
  assert.equal(searchedBatches.length, 2, 'initial and feedback searches must be separate rounds');
  assert.equal(evaluationCount, 2, 'each retrieval round must feed the next evidence evaluation');
  assert.equal(modelCallCount, 4, 'contextualizer, two evaluators, and final answer');

  const allQueries = searchedBatches.flat();
  assert.deepEqual(searchedBatches.map((batch) => batch.length), [2, 1]);
  assert.equal(new Set(allQueries).size, allQueries.length);
  for (let left = 0; left < allQueries.length; left += 1) {
    assert.match(allQueries[left], /测试人物甲/u);
    assert.match(allQueries[left], /甲州|投控集团/u);
    for (let right = left + 1; right < allQueries.length; right += 1) {
      assert.equal(
        researchQueriesEquivalent(allQueries[left], allQueries[right]),
        false,
        `queries must be distinct across the whole task: ${allQueries[left]} / ${allQueries[right]}`,
      );
    }
  }
});
