import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VaultPathPolicy } from '../src/path-policy.mjs';
import {
  KnowledgeIndex,
  bm25Search,
  chunkDocument,
  knowledgeIndexInternals,
  logicalDocumentKey,
  tokenize,
} from '../src/knowledge-index.mjs';
import { serverInternals } from '../src/server.mjs';

async function fixture(t, embedding = { provider: 'disabled' }) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultmind-index-'));
  const vaultPath = path.join(temporary, 'vault');
  const indexDir = path.join(temporary, 'index');
  await fsp.mkdir(vaultPath, { recursive: true });
  const config = {
    vaultPath,
    indexDir,
    excludedPaths: ['.obsidian', '.trash', '.git', '.livesync'],
    embedding: {
      provider: embedding.provider,
      model: embedding.model || '',
      dimensions: embedding.dimensions || 3,
      batchSize: embedding.batchSize || 16,
      timeoutMs: 1_000,
      endpoint: embedding.endpoint || '',
      apiBase: embedding.apiBase || '',
      apiKey: '',
    },
    retrieval: { topK: 8, watch: false, reconcileIntervalMs: 60 * 60_000 },
  };
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  return { temporary, vaultPath, indexDir, config };
}

class FakeEmbeddingClient {
  constructor() {
    this.enabled = true;
    this.provider = 'fake';
    this.model = 'fake-three-dimensional';
    this.embeddingModel = this.model;
    this.dimensions = 3;
    this.batchSize = 16;
    this.calls = [];
  }

  vector(text) {
    const value = String(text);
    if (value.includes('苹果')) return [1, 0, 0];
    if (value.includes('香蕉')) return [0, 1, 0];
    return [0, 0, 1];
  }

  async embed(texts, options = {}) {
    this.calls.push({
      texts: [...texts],
      textType: options.textType,
      instruct: options.instruct,
    });
    return texts.map((text) => this.vector(text));
  }
}

test('Markdown chunking preserves headings and lines while BM25 supports Chinese and identifiers', () => {
  const markdown = [
    '# Retrieval Notes',
    '',
    '知识库使用向量召回和关键词召回。',
    '',
    '## Code',
    '',
    '```js',
    'const queryVector = embed(input);',
    '```',
  ].join('\n');
  const chunks = chunkDocument('notes/rag.md', markdown, { targetSize: 70, overlapSize: 10 });
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].path, 'notes/rag.md');
  assert.equal(chunks[0].lineStart, 1);
  assert.ok(chunks.some((chunk) => chunk.heading === 'Code'));
  assert.ok(chunks.some((chunk) => chunk.content.includes('queryVector')));
  assert.ok(tokenize('中文知识库 queryVector').includes('queryvector'));
  assert.equal(bm25Search('queryVector', chunks, 5)[0].path, 'notes/rag.md');
});

test('BM25 query terms remove Chinese question scaffolding without changing document tokenization', () => {
  const terms = knowledgeIndexInternals.queryTermsFor('请问，测试人物乙是谁？');
  assert.ok(terms.includes('测试'));
  assert.ok(terms.includes('试人'));
  for (const weak of ['是', '谁', '是谁', '乙是']) assert.ok(!terms.includes(weak));

  assert.ok(tokenize('测试人物乙是谁').includes('乙是'));
  assert.deepEqual(knowledgeIndexInternals.queryTermsFor('苹果的颜色'), ['苹果', '颜色']);
  assert.deepEqual(knowledgeIndexInternals.queryTermsFor('queryVector'), ['queryvector']);
});

test('retrieval collapses raw and organized siblings into one logical source and prefers the organized note', async (t) => {
  const setup = await fixture(t);
  await Promise.all([
    fsp.writeFile(
      path.join(setup.vaultPath, '显存计算.md'),
      '# 显存计算\n\n训练显存包含参数、梯度、优化器状态和激活值。\n',
    ),
    fsp.writeFile(
      path.join(setup.vaultPath, '显存计算_整理版.md'),
      '# 显存计算整理\n\n训练显存包含参数、梯度、优化器状态和激活值，并给出计算公式。\n',
    ),
  ]);
  const index = new KnowledgeIndex(setup.config);
  t.after(() => index.close());
  await index.ready;

  const result = await index.search('训练显存计算公式', { route: 'keyword', limit: 8 });
  assert.equal(result.results.filter((item) => item.logicalKey === '显存计算.md').length, 1);
  assert.equal(result.results[0].path, '显存计算_整理版.md');
  assert.deepEqual(result.results[0].relatedPaths, ['显存计算.md']);
  assert.equal(logicalDocumentKey('显存计算_整理版.md'), '显存计算.md');
});

test('temporal inventory hard-filters the whole snapshot by mtime before ranking and logical dedupe', async (t) => {
  const setup = await fixture(t);
  await fsp.mkdir(path.join(setup.vaultPath, 'learning_notes'), { recursive: true });
  await fsp.mkdir(path.join(setup.vaultPath, 'daily_notes'), { recursive: true });
  const files = {
    raw: path.join(setup.vaultPath, 'learning_notes', 'topic.md'),
    organized: path.join(setup.vaultPath, 'learning_notes', 'topic_整理版.md'),
    outside: path.join(setup.vaultPath, 'learning_notes', 'old.md'),
    wrongScope: path.join(setup.vaultPath, 'daily_notes', 'same-window.md'),
    endBoundary: path.join(setup.vaultPath, 'learning_notes', 'at-end.md'),
  };
  await Promise.all([
    fsp.writeFile(files.raw, '# Topic\n\n学习了时间检索的原始材料。\n'),
    fsp.writeFile(files.organized, '# Topic\n\n学习了时间检索的整理材料。\n'),
    fsp.writeFile(files.outside, '# Old\n\n不应进入时间窗。\n'),
    fsp.writeFile(files.wrongScope, '# Daily\n\n同一时间窗内的生活记录。\n'),
    fsp.writeFile(files.endBoundary, '# Boundary\n\n结束边界必须排除。\n'),
  ]);
  await fsp.utimes(files.raw, new Date('2026-08-25T01:00:00Z'), new Date('2026-08-25T01:00:00Z'));
  await fsp.utimes(files.organized, new Date('2026-08-26T01:00:00Z'), new Date('2026-08-26T01:00:00Z'));
  await fsp.utimes(files.outside, new Date('2026-07-01T01:00:00Z'), new Date('2026-07-01T01:00:00Z'));
  await fsp.utimes(files.wrongScope, new Date('2026-08-27T01:00:00Z'), new Date('2026-08-27T01:00:00Z'));
  await fsp.utimes(files.endBoundary, new Date('2026-09-03T06:30:00Z'), new Date('2026-09-03T06:30:00Z'));
  const index = new KnowledgeIndex(setup.config);
  t.after(() => index.close());
  await index.ready;

  const inventory = await index.temporalInventory('这两周我学习了哪些内容', {
    range: {
      startMs: Date.parse('2026-08-20T16:00:00Z'),
      endMs: Date.parse('2026-09-03T06:30:00Z'),
      timeZone: 'Asia/Shanghai',
    },
    scope: 'learning',
  });
  assert.equal(inventory.route, 'mtime-inventory');
  assert.deepEqual(inventory.results.map((item) => item.path), [
    'learning_notes/topic_整理版.md',
    'daily_notes/same-window.md',
  ]);
  assert.deepEqual(inventory.results[0].relatedPaths, ['learning_notes/topic.md']);
  assert.equal(inventory.results[0].scopeMatch, true);
  assert.equal(inventory.results[1].scopeMatch, false);
  assert.equal(inventory.results[0].modifiedAt, '2026-08-26T01:00:00.000Z');
  assert.equal(inventory.inventory.inRangePhysicalFiles, 3);
  assert.equal(inventory.inventory.logicalFilesInRange, 2);
  assert.equal(inventory.inventory.scopeApplied, true);
  assert.equal(inventory.inventory.metadataComplete, true);
  assert.ok(inventory.results.every((item) => (
    item.mtimeMs >= Date.parse('2026-08-20T16:00:00Z') &&
    item.mtimeMs < Date.parse('2026-09-03T06:30:00Z')
  )));
});

test('temporal inventory reports incomplete mtime coverage instead of claiming completeness', async (t) => {
  const setup = await fixture(t);
  await fsp.mkdir(path.join(setup.vaultPath, 'learning'), { recursive: true });
  await fsp.writeFile(path.join(setup.vaultPath, 'learning', 'missing-time.md'), '# Note\n');
  const index = new KnowledgeIndex(setup.config);
  t.after(() => index.close());
  await index.ready;
  index.generation.files['learning/missing-time.md'].mtimeMs = null;

  const inventory = await index.temporalInventory('最近一周学习了哪些内容', {
    range: { startMs: 1, endMs: Date.now() + 1, timeZone: 'UTC' },
    scope: 'learning',
  });
  assert.equal(inventory.inventory.invalidMtimeFiles, 1);
  assert.equal(inventory.inventory.metadataComplete, false);
  assert.deepEqual(inventory.results, []);
});

test('an empty temporal window is a complete inventory rather than a scope-classification failure', async (t) => {
  const setup = await fixture(t);
  await fsp.mkdir(path.join(setup.vaultPath, 'learning'), { recursive: true });
  const note = path.join(setup.vaultPath, 'learning', 'old.md');
  await fsp.writeFile(note, '# Old learning note\n');
  await fsp.utimes(note, new Date('2026-07-01T01:00:00Z'), new Date('2026-07-01T01:00:00Z'));
  const index = new KnowledgeIndex(setup.config);
  t.after(() => index.close());
  await index.ready;

  const inventory = await index.temporalInventory('这两周我学习了哪些内容', {
    range: {
      startMs: Date.parse('2026-08-20T16:00:00Z'),
      endMs: Date.parse('2026-09-03T06:30:00Z'),
      timeZone: 'Asia/Shanghai',
    },
    scope: 'learning',
  });
  assert.equal(inventory.inventory.logicalFilesInRange, 0);
  assert.equal(inventory.inventory.scopeApplied, true);
  assert.equal(inventory.inventory.metadataComplete, true);
});

test('startup validation accepts a healthy slot whose live generation advanced after activation', async (t) => {
  const setup = await fixture(t);
  const note = path.join(setup.vaultPath, 'rolling.md');
  await fsp.writeFile(note, '# Rolling index\n\nFirst version.\n');
  const index = new KnowledgeIndex(setup.config);
  t.after(() => index.close());
  await index.ready;
  const activatedGeneration = index.status().generation;

  await fsp.writeFile(note, '# Rolling index\n\nSecond version.\n');
  await index.updatePaths(['rolling.md']);
  assert.notEqual(index.status().generation, activatedGeneration);
  assert.equal(serverInternals.resolvedIndexIsUsable(index, {
    generation: activatedGeneration,
    embedding: setup.config.embedding,
  }), true);
});

test('an acquired snapshot keeps one exact generation across same-slot file updates', async (t) => {
  const setup = await fixture(t);
  const first = path.join(setup.vaultPath, 'learning', 'first.md');
  const second = path.join(setup.vaultPath, 'learning', 'second.md');
  await fsp.mkdir(path.dirname(first), { recursive: true });
  await fsp.writeFile(first, '# First\n\n第一版学习记录。\n');
  await fsp.utimes(first, new Date('2026-08-25T01:00:00Z'), new Date('2026-08-25T01:00:00Z'));
  const index = new KnowledgeIndex(setup.config);
  t.after(() => index.close());
  await index.ready;
  const snapshot = index.acquireSnapshot();
  t.after(() => snapshot.release());
  const pinnedGeneration = snapshot.generation;

  await fsp.rm(first);
  await fsp.writeFile(second, '# Second\n\n第二版学习记录。\n');
  await fsp.utimes(second, new Date('2026-08-26T01:00:00Z'), new Date('2026-08-26T01:00:00Z'));
  await index.updatePaths(['learning/first.md', 'learning/second.md']);
  assert.notEqual(index.status().generation, pinnedGeneration);

  const options = {
    range: {
      startMs: Date.parse('2026-08-20T16:00:00Z'),
      endMs: Date.parse('2026-09-03T06:30:00Z'),
      timeZone: 'Asia/Shanghai',
    },
    scope: 'learning',
  };
  const pinned = await snapshot.temporalInventory('这两周我学习了哪些内容', options);
  const live = await index.temporalInventory('这两周我学习了哪些内容', options);
  assert.equal(pinned.inventory.generation, pinnedGeneration);
  assert.deepEqual(pinned.results.map((item) => item.path), ['learning/first.md']);
  assert.deepEqual(live.results.map((item) => item.path), ['learning/second.md']);

  snapshot.release();
  assert.throws(
    () => snapshot.search('第一版', { route: 'keyword' }),
    (error) => error?.code === 'INDEX_SNAPSHOT_RELEASED',
  );
});

test('explicit entity questions require the entity in keyword, semantic, and hybrid results', async (t) => {
  const setup = await fixture(t, {
    provider: 'openai-compatible',
    model: 'fake-three-dimensional',
    dimensions: 3,
  });
  await fsp.writeFile(
    path.join(setup.vaultPath, 'unrelated.md'),
    '# 人物问答\n\n这是一篇解释“谁是队长”和“是谁”语法的无关记录。\n',
  );
  const client = new FakeEmbeddingClient();
  const index = new KnowledgeIndex(setup.config, {
    policy: new VaultPathPolicy(setup.vaultPath, setup.config.excludedPaths),
    client,
  });
  t.after(() => index.close());
  await index.ready;

  for (const route of ['keyword', 'semantic', 'hybrid']) {
    const missing = await index.search('测试人物乙是谁', { route });
    assert.equal(missing.route, route);
    assert.equal(missing.results.length, 0);
    assert.equal(missing.diagnostics.entityAnchorApplied, true);
    assert.equal(missing.diagnostics.entityMatchedChunks, 0);
  }

  await fsp.mkdir(path.join(setup.vaultPath, 'people'), { recursive: true });
  await fsp.writeFile(
    path.join(setup.vaultPath, 'people', 'fictional-artist-a.md'),
    '# 测试人物乙\n\n测试人物乙是一名歌手和音乐制作人。\n',
  );
  await index.updatePaths(['people/fictional-artist-a.md']);

  for (const route of ['keyword', 'semantic', 'hybrid']) {
    const found = await index.search('谁是测试人物乙', { route });
    assert.equal(found.route, route);
    assert.equal(found.results[0].path, 'people/fictional-artist-a.md');
  }
});

test('disabled mode builds a lexical generation and never indexes hidden or .obsidian content', async (t) => {
  const setup = await fixture(t);
  await Promise.all([
    fsp.mkdir(path.join(setup.vaultPath, 'notes'), { recursive: true }),
    fsp.mkdir(path.join(setup.vaultPath, '.obsidian', 'plugins', 'livesync'), { recursive: true }),
    fsp.mkdir(path.join(setup.vaultPath, '.hidden'), { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(
      path.join(setup.vaultPath, 'notes', 'rag.md'),
      '# RAG Architecture\n\n混合检索先执行关键词召回，再融合向量结果。\n',
    ),
    fsp.writeFile(
      path.join(setup.vaultPath, 'notes', 'plan.md'),
      '# Plan\n\n今天完成知识库索引测试。\n',
    ),
    fsp.writeFile(
      path.join(setup.vaultPath, '.obsidian', 'plugins', 'livesync', 'data.json'),
      '{"credential":"never-index-this-secret"}',
    ),
    fsp.writeFile(path.join(setup.vaultPath, '.hidden', 'secret.md'), '# Hidden\nnever-index-hidden'),
  ]);

  const policy = new VaultPathPolicy(setup.vaultPath, setup.config.excludedPaths);
  const index = new KnowledgeIndex(setup.config, { policy });
  t.after(() => index.close());
  await index.ready;

  const status = index.status();
  assert.equal(status.available, true);
  assert.equal(status.files, 2);
  assert.equal(status.semanticAvailable, false);

  const keyword = await index.search('混合检索', { route: 'keyword' });
  assert.equal(keyword.route, 'keyword');
  assert.equal(keyword.results[0].path, 'notes/rag.md');
  assert.match(keyword.results[0].content, /关键词召回/);
  assert.ok(keyword.results[0].lineStart >= 1);
  assert.ok(keyword.results[0].lineEnd >= keyword.results[0].lineStart);
  assert.ok(keyword.results[0].matchedTerms.length > 0);

  const fallback = await index.search('混合检索', { route: 'hybrid' });
  assert.equal(fallback.route, 'keyword');
  assert.equal(fallback.diagnostics.fallback, 'embeddings-disabled');
  assert.equal(fallback.diagnostics.embeddingUsed, false);

  assert.equal((await index.search('never-index-this-secret', { route: 'keyword' })).results.length, 0);
  assert.equal((await index.search('never-index-hidden', { route: 'keyword' })).results.length, 0);
  const generationBefore = index.status().generation;
  await index.updatePaths(['.obsidian/plugins/livesync/data.json']);
  assert.equal(index.status().generation, generationBefore);
});

test('hybrid search embeds documents, reuses chunk hashes, and embeds only changed files', async (t) => {
  const setup = await fixture(t, {
    provider: 'openai-compatible',
    model: 'fake-three-dimensional',
    dimensions: 3,
  });
  await fsp.mkdir(path.join(setup.vaultPath, 'food'), { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(setup.vaultPath, 'food', 'apple.md'), '# 苹果\n\n苹果是一种红色水果。\n'),
    fsp.writeFile(path.join(setup.vaultPath, 'food', 'banana.md'), '# 香蕉\n\n香蕉通常是黄色水果。\n'),
  ]);
  const client = new FakeEmbeddingClient();
  const policy = new VaultPathPolicy(setup.vaultPath, setup.config.excludedPaths);
  const index = new KnowledgeIndex(setup.config, { policy, client });
  t.after(() => index.close());
  await index.ready;

  const initialDocumentInputs = client.calls
    .filter((call) => call.textType === 'document')
    .flatMap((call) => call.texts);
  assert.equal(initialDocumentInputs.length, 2);
  assert.equal(index.status().embeddedChunks, 2);

  await index.rebuild();
  assert.equal(
    client.calls.filter((call) => call.textType === 'document').flatMap((call) => call.texts).length,
    2,
  );

  await fsp.writeFile(
    path.join(setup.vaultPath, 'food', 'banana.md'),
    '# 香蕉\n\n香蕉通常是黄色水果，也富含钾。\n',
  );
  await index.updatePaths(['food/banana.md']);
  const allDocumentInputs = client.calls
    .filter((call) => call.textType === 'document')
    .flatMap((call) => call.texts);
  assert.equal(allDocumentInputs.length, 3);
  assert.match(allDocumentInputs.at(-1), /富含钾/);

  const hybrid = await index.search('苹果的颜色', { route: 'hybrid', limit: 2 });
  assert.equal(hybrid.route, 'hybrid');
  assert.equal(hybrid.results[0].path, 'food/apple.md');
  assert.match(hybrid.results[0].content, /红色水果/);
  assert.equal(hybrid.diagnostics.embeddingUsed, true);
  assert.equal(client.calls.at(-1).textType, 'query');
  assert.match(client.calls.at(-1).instruct, /retrieve passages that directly answer/i);

  const semantic = await index.search('苹果', { route: 'semantic', limit: 1 });
  assert.equal(semantic.route, 'semantic');
  assert.equal(semantic.results[0].path, 'food/apple.md');
});

test('embedding failure keeps keyword search available with explicit diagnostics', async (t) => {
  const setup = await fixture(t, {
    provider: 'openai-compatible',
    model: 'fake-three-dimensional',
    dimensions: 3,
  });
  await fsp.writeFile(path.join(setup.vaultPath, 'note.md'), '# Offline\n\n离线时仍可关键词检索。\n');
  const client = new FakeEmbeddingClient();
  client.embed = async () => {
    const error = new Error('provider unavailable');
    error.code = 'EMBEDDING_NETWORK_ERROR';
    throw error;
  };
  const index = new KnowledgeIndex(setup.config, {
    policy: new VaultPathPolicy(setup.vaultPath, setup.config.excludedPaths),
    client,
  });
  t.after(() => index.close());
  await index.ready;

  assert.equal(index.status().available, true);
  assert.equal(index.status().semanticAvailable, false);
  assert.equal(index.status().lastError.code, 'EMBEDDING_NETWORK_ERROR');
  assert.equal(serverInternals.resolvedIndexIsUsable(index, {
    generation: 'activation-time-generation',
    embedding: index.status().embedding,
  }), true);
  const result = await index.search('关键词检索', { route: 'semantic' });
  assert.equal(result.route, 'keyword');
  assert.equal(result.results[0].path, 'note.md');
  assert.equal(result.diagnostics.fallback, 'no-indexed-vectors');

  const degradedGeneration = index.status().generation;
  await index.close();
  const restarted = new KnowledgeIndex(setup.config, {
    policy: new VaultPathPolicy(setup.vaultPath, setup.config.excludedPaths),
    client,
    autoBuild: false,
  });
  t.after(() => restarted.close());
  await restarted.ready;
  assert.equal(restarted.status().generation, degradedGeneration);
  assert.equal(serverInternals.resolvedIndexIsUsable(restarted, {
    generation: 'older-activation-time-generation',
    embedding: restarted.status().embedding,
  }), true);
  assert.equal(
    (await restarted.search('关键词检索', { route: 'keyword' })).results[0].path,
    'note.md',
  );
});

test('a corrupt current generation falls back to the previous atomic generation', async (t) => {
  const setup = await fixture(t);
  const note = path.join(setup.vaultPath, 'history.md');
  await fsp.writeFile(note, '# Version one\n\nfirst generation\n');
  const first = new KnowledgeIndex(setup.config, {
    policy: new VaultPathPolicy(setup.vaultPath, setup.config.excludedPaths),
  });
  await first.ready;
  const firstGeneration = first.status().generation;
  await fsp.writeFile(note, '# Version two\n\nsecond generation\n');
  await first.updatePaths(['history.md']);
  const secondGeneration = first.status().generation;
  assert.notEqual(secondGeneration, firstGeneration);
  await first.close();

  const manifest = JSON.parse(await fsp.readFile(path.join(setup.indexDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.previous, firstGeneration);
  await fsp.writeFile(
    path.join(setup.indexDir, 'generations', `${manifest.current}.json`),
    '{corrupt-json',
  );

  const recovered = new KnowledgeIndex(setup.config, {
    policy: new VaultPathPolicy(setup.vaultPath, setup.config.excludedPaths),
    autoBuild: false,
  });
  t.after(() => recovered.close());
  await recovered.ready;
  assert.equal(recovered.status().available, true);
  assert.equal(recovered.status().generation, manifest.previous);
  assert.equal(recovered.status().previousGeneration, manifest.previous);
  assert.match(
    (await recovered.search('first generation', { route: 'keyword' })).results[0].content,
    /first generation/,
  );
});

test('persisted generations containing hidden Vault paths are rejected before search', async (t) => {
  const setup = await fixture(t);
  const note = path.join(setup.vaultPath, 'visible.md');
  await fsp.writeFile(note, '# Visible\n\nfirst safe version\n');
  const first = new KnowledgeIndex(setup.config, {
    policy: new VaultPathPolicy(setup.vaultPath, setup.config.excludedPaths),
  });
  await first.ready;
  const safeGeneration = first.status().generation;
  await fsp.writeFile(note, '# Visible\n\nsecond safe version\n');
  await first.updatePaths(['visible.md']);
  const manifest = JSON.parse(await fsp.readFile(path.join(setup.indexDir, 'manifest.json'), 'utf8'));
  await first.close();
  assert.equal(manifest.previous, safeGeneration);

  const currentFile = path.join(setup.indexDir, 'generations', `${manifest.current}.json`);
  const poisoned = JSON.parse(await fsp.readFile(currentFile, 'utf8'));
  const secretChunk = {
    id: 'hidden-secret-chunk',
    path: '.obsidian/private.json',
    name: 'private.json',
    heading: '',
    headings: [],
    lineStart: 1,
    lineEnd: 1,
    fileHash: 'fixture',
    chunkHash: 'fixture',
    content: 'never-return-persisted-secret',
    vector: null,
  };
  poisoned.files[secretChunk.path] = {
    hash: 'fixture', size: 1, mtimeMs: 1, ctimeMs: 1, chunks: [secretChunk.id],
  };
  poisoned.chunks.push(secretChunk);
  await fsp.writeFile(currentFile, JSON.stringify(poisoned));

  const recovered = new KnowledgeIndex(setup.config, {
    policy: new VaultPathPolicy(setup.vaultPath, setup.config.excludedPaths),
    autoBuild: false,
  });
  t.after(() => recovered.close());
  await recovered.ready;
  assert.equal(recovered.status().generation, safeGeneration);
  assert.equal(
    (await recovered.search('never-return-persisted-secret', { route: 'keyword' })).results.length,
    0,
  );
});
