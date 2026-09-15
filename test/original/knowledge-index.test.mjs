import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  KnowledgeIndex,
  bm25Search,
  chunkDocument,
  logicalDocumentKey,
  normalizeDates,
  routeKnowledgeQuery,
} from '../../src/original/knowledge-index.mjs';

class FakeRetrievalClient {
  constructor() {
    this.dimensions = 4;
    this.embeddingModel = 'fake-embedding';
    this.embedCalls = [];
    this.rerankCalls = [];
  }

  async embed(texts, options = {}) {
    this.embedCalls.push({ texts: [...texts], textType: options.textType });
    return texts.map((text) => {
      const value = String(text).includes('向量') ? 1 : 0.5;
      return [value, 1 - value, 0, 0];
    });
  }

  async rerank(query, documents, options = {}) {
    this.rerankCalls.push({ query, documents, topN: options.topN });
    return documents.map((_, index) => ({ index, score: 1 - index / 100 })).slice(0, options.topN);
  }
}

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuan-index-test-'));
  const vault = path.join(root, 'vault');
  const indexRoot = path.join(root, 'index');
  await fsp.mkdir(vault);
  const client = options.client || new FakeRetrievalClient();
  const index = new KnowledgeIndex({
    root: vault,
    indexRoot,
    client,
    watch: false,
    autoBuild: false,
    fetchEmbeddings: options.fetchEmbeddings,
  });
  await index.ready;
  t.after(async () => {
    index.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, vault, indexRoot, index, client };
}

test('按 Markdown 块分块并保留标题、行号、代码围栏和哈希', () => {
  const content = [
    '# 项目', '', '第一段内容。'.repeat(12), '',
    '## 实现', '', '```js', 'const importantIdentifier = 1;', 'console.log(importantIdentifier);', '```', '',
    '- 列表项一', '- 列表项二', '- 列表项三',
  ].join('\n');
  const chunks = chunkDocument('notes/demo.md', content, { targetSize: 90, overlapSize: 20 });
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.every((chunk) => chunk.fileHash && chunk.chunkHash), true);
  assert.equal(chunks.some((chunk) => chunk.headings.includes('实现')), true);
  assert.equal(chunks.filter((chunk) => chunk.content.includes('```js')).length, 1);
  assert.equal(chunks.every((chunk) => chunk.startLine <= chunk.endLine), true);
});

test('规则路由识别日期、路径、扩展名、标识符与列出全部', () => {
  assert.equal(normalizeDates('2026年8月25日 / 2026/8/25'), '2026-08-25 / 2026-08-25');
  for (const query of [
    '2026年8月25日写了什么',
    '查找 daily_doc/日记/a.md',
    '哪个 .yaml 文件',
    '列出全部 `importantIdentifier`',
  ]) assert.equal(routeKnowledgeQuery(query).route, 'exact');
  assert.equal(routeKnowledgeQuery('我之前对检索系统的模糊想法是什么').route, 'semantic');
  assert.equal(routeKnowledgeQuery('列出所有命中').exhaustive, true);
  assert.equal(logicalDocumentKey('x/笔记_整理版.md'), 'x/笔记.md');
  assert.equal(logicalDocumentKey('x/笔记（整理版）.md'), 'x/笔记.md');
});

test('BM25 支持中文二元词组和英文代码标识符', () => {
  const chunks = [
    ...chunkDocument('a.md', '# 检索\n\n这里讲混合知识检索和语义召回。'),
    ...chunkDocument('b.md', '# Code\n\nfunction importantIdentifier() { return true; }'),
  ];
  assert.equal(bm25Search('知识检索', chunks, 2)[0].path, 'a.md');
  assert.equal(bm25Search('importantIdentifier', chunks, 2)[0].path, 'b.md');
});

test('精确穷举实时扫描并返回全部文件与真实行号', async (t) => {
  const { vault, index } = await fixture(t, { fetchEmbeddings: false });
  await fsp.mkdir(path.join(vault, 'daily'));
  await fsp.writeFile(path.join(vault, 'daily', 'a.md'), '# A\n\n2026/8/25 记录 alpha\n\nalpha 再次出现\n');
  await fsp.writeFile(path.join(vault, 'daily', 'b.txt'), '2026年8月25日 alpha\n');
  const result = await index.search('列出全部包含“2026-08-25”的文件', { limit: 1 });
  assert.equal(result.route, 'exact');
  assert.equal(result.complete, true);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.find((item) => item.path.endsWith('a.md')).lineNumbers, [3]);
  assert.equal(result.diagnostics.embeddingUsed, false);
  assert.equal(result.diagnostics.embeddingModel, 'fake-embedding');
  assert.equal(result.diagnostics.embeddingDimensions, 4);
  assert.equal(result.diagnostics.embeddingApiCalled, false);
  assert.equal(result.diagnostics.embeddingApiSucceeded, false);
  assert.equal(result.diagnostics.queryVectorCacheHit, false);
  assert.equal(result.diagnostics.rankingCacheHit, false);
});

test('Embedding 诊断区分首次 API、排序缓存与跨模式查询向量缓存', async (t) => {
  const { vault, index, client } = await fixture(t, { fetchEmbeddings: true });
  await fsp.writeFile(path.join(vault, '向量检索.md'), '# 向量检索\n\n这里记录蓝色星球的混合检索思路。');
  await index.rebuild();
  client.embedCalls.length = 0;

  const first = await index.search('我模糊记得蓝色星球的检索思路', { taskMode: 'normal' });
  assert.equal(first.diagnostics.embeddingUsed, true);
  assert.equal(first.diagnostics.embeddingModel, 'fake-embedding');
  assert.equal(first.diagnostics.embeddingDimensions, 4);
  assert.equal(first.diagnostics.embeddingApiCalled, true);
  assert.equal(first.diagnostics.embeddingApiSucceeded, true);
  assert.equal(first.diagnostics.queryVectorCacheHit, false);
  assert.equal(first.diagnostics.rankingCacheHit, false);
  assert.equal(client.embedCalls.filter((call) => call.textType === 'query').length, 1);

  const rankingCached = await index.search('我模糊记得蓝色星球的检索思路', { taskMode: 'normal' });
  assert.equal(rankingCached.diagnostics.embeddingUsed, true);
  assert.equal(rankingCached.diagnostics.embeddingApiCalled, false);
  assert.equal(rankingCached.diagnostics.embeddingApiSucceeded, false);
  assert.equal(rankingCached.diagnostics.queryVectorCacheHit, false);
  assert.equal(rankingCached.diagnostics.rankingCacheHit, true);
  assert.equal(client.embedCalls.filter((call) => call.textType === 'query').length, 1);

  const queryVectorCached = await index.search('我模糊记得蓝色星球的检索思路', { taskMode: 'deep' });
  assert.equal(queryVectorCached.diagnostics.embeddingUsed, true);
  assert.equal(queryVectorCached.diagnostics.embeddingApiCalled, false);
  assert.equal(queryVectorCached.diagnostics.embeddingApiSucceeded, false);
  assert.equal(queryVectorCached.diagnostics.queryVectorCacheHit, true);
  assert.equal(queryVectorCached.diagnostics.rankingCacheHit, false);
  assert.equal(client.embedCalls.filter((call) => call.textType === 'query').length, 1);
});

test('Embedding 调用失败时诊断如实标记并回退 BM25', async (t) => {
  const client = new FakeRetrievalClient();
  const { vault, index } = await fixture(t, { client, fetchEmbeddings: true });
  await fsp.writeFile(path.join(vault, '回退.md'), '# 回退\n\n紫色灯塔的语义检索线索。');
  await index.rebuild();
  const originalEmbed = client.embed.bind(client);
  client.embed = async (texts, options = {}) => {
    if (options.textType === 'query') {
      const error = new Error('模拟查询 Embedding 超时');
      error.code = 'KNOWLEDGE_EMBEDDING_TIMEOUT';
      throw error;
    }
    return originalEmbed(texts, options);
  };

  const result = await index.search('我模糊记得紫色灯塔的线索');
  assert.equal(result.diagnostics.embeddingUsed, false);
  assert.equal(result.diagnostics.embeddingApiCalled, true);
  assert.equal(result.diagnostics.embeddingApiSucceeded, false);
  assert.equal(result.diagnostics.queryVectorCacheHit, false);
  assert.equal(result.diagnostics.rankingCacheHit, false);
  assert.equal(result.diagnostics.fallback, 'bm25');
  assert.equal(result.diagnostics.warning, 'KNOWLEDGE_EMBEDDING_TIMEOUT');
});

test('未向量化的新文件会实时叠加 BM25，整理版逻辑去重且关联原文', async (t) => {
  const { vault, index } = await fixture(t, { fetchEmbeddings: false });
  await fsp.writeFile(path.join(vault, '主题.md'), '# 主题\n\n混合检索基线。');
  await fsp.writeFile(path.join(vault, '主题_整理版.md'), '# 主题整理\n\n混合检索基线和语义召回。');
  await index.rebuild();
  await fsp.writeFile(path.join(vault, '新文件.md'), '# 新记忆\n\n蓝色火星计划的唯一线索。');
  const live = await index.search('我记得有一个蓝色火星计划', { taskMode: 'normal' });
  assert.equal(live.results[0].path, '新文件.md');
  assert.equal(live.diagnostics.liveOverlay, true);

  const deduped = await index.search('主题基线与语义召回的思路', { taskMode: 'normal' });
  const matching = deduped.results.filter((item) => item.logicalKey === '主题.md');
  assert.equal(matching.length, 1);
  assert.equal(matching[0].path, '主题_整理版.md');
  assert.deepEqual(matching[0].relatedPaths, ['主题.md']);
});

test('只重新 Embedding 发生变化的分片，原子切换并保留上一代', async (t) => {
  const client = new FakeRetrievalClient();
  const { vault, index, indexRoot } = await fixture(t, { client, fetchEmbeddings: true });
  await fsp.writeFile(path.join(vault, 'a.md'), '# A\n\n向量文档 A');
  await fsp.writeFile(path.join(vault, 'b.md'), '# B\n\n向量文档 B');
  await index.rebuild();
  assert.equal(client.embedCalls.flatMap((call) => call.texts).length, 2);
  const firstGeneration = index.status().generation;
  client.embedCalls.length = 0;
  await fsp.writeFile(path.join(vault, 'b.md'), '# B\n\n向量文档 B 已修改');
  await index.updatePaths(['b.md']);
  assert.equal(client.embedCalls.flatMap((call) => call.texts).length, 1);
  assert.notEqual(index.status().generation, firstGeneration);
  const manifest = JSON.parse(await fsp.readFile(path.join(indexRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.previous, firstGeneration);
  assert.ok(await fsp.stat(path.join(indexRoot, 'generations', `${manifest.current}.json`)));
  assert.ok(await fsp.stat(path.join(indexRoot, 'generations', `${manifest.previous}.json`)));
});

test('增量 Embedding 失败时不切换未完成索引且实时 BM25 仍覆盖修改', async (t) => {
  const client = new FakeRetrievalClient();
  const { vault, index } = await fixture(t, { client, fetchEmbeddings: true });
  await fsp.writeFile(path.join(vault, 'stable.md'), '# 稳定版本\n\n原始向量内容');
  await index.rebuild();
  const stableGeneration = index.status().generation;

  client.embed = async () => {
    const error = new Error('模拟 Embedding 失败');
    error.code = 'KNOWLEDGE_EMBEDDING_TIMEOUT';
    throw error;
  };
  await fsp.writeFile(path.join(vault, 'fresh.md'), '# 新内容\n\n没有进入向量索引的蓝色线索');
  await assert.rejects(() => index.updatePaths(['fresh.md']), /模拟 Embedding 失败/);
  assert.equal(index.status().generation, stableGeneration);

  const result = await index.search('我记得一个没有进入索引的蓝色线索');
  assert.equal(result.results[0].path, 'fresh.md');
  assert.equal(result.diagnostics.liveOverlay, true);
  assert.equal(result.diagnostics.fallback, 'bm25');
});

test('索引维度不匹配时拒绝加载并回退实时 BM25', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuan-index-mismatch-'));
  const vault = path.join(root, 'vault');
  const indexRoot = path.join(root, 'index');
  await fsp.mkdir(vault, { recursive: true });
  await fsp.mkdir(path.join(indexRoot, 'generations'), { recursive: true });
  await fsp.writeFile(path.join(vault, 'fallback.md'), '# 回退\n\n维度不匹配仍应检索到紫色线索');
  await fsp.writeFile(path.join(indexRoot, 'manifest.json'), JSON.stringify({
    version: 1,
    current: 'bad-dimension',
    previous: null,
  }));
  await fsp.writeFile(path.join(indexRoot, 'generations', 'bad-dimension.json'), JSON.stringify({
    version: 1,
    generation: 'bad-dimension',
    dimensions: 8,
    embeddingModel: 'fake-embedding',
    files: {},
    chunks: [],
  }));
  const index = new KnowledgeIndex({
    root: vault,
    indexRoot,
    client: new FakeRetrievalClient(),
    watch: false,
    autoBuild: false,
    fetchEmbeddings: false,
  });
  await index.ready;
  t.after(async () => {
    index.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  assert.equal(index.status().available, false);
  assert.equal(index.status().lastError.code, 'KNOWLEDGE_INDEX_DIMENSION_MISMATCH');
  const result = await index.search('我记得维度不匹配时的紫色线索');
  assert.equal(result.results[0].path, 'fallback.md');
  assert.equal(result.diagnostics.fallback, 'bm25');
  assert.equal(result.diagnostics.embeddingUsed, false);
  assert.equal(result.diagnostics.embeddingApiCalled, false);
  assert.equal(result.diagnostics.embeddingApiSucceeded, false);
  assert.equal(result.diagnostics.queryVectorCacheHit, false);
  assert.equal(result.diagnostics.rankingCacheHit, false);
  assert.equal(result.diagnostics.warning, 'KNOWLEDGE_INDEX_DIMENSION_MISMATCH');
});
