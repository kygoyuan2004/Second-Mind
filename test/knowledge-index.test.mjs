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
  tokenize,
} from '../src/knowledge-index.mjs';

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
    this.calls.push({ texts: [...texts], textType: options.textType });
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
  const result = await index.search('关键词检索', { route: 'semantic' });
  assert.equal(result.route, 'keyword');
  assert.equal(result.results[0].path, 'note.md');
  assert.equal(result.diagnostics.fallback, 'no-indexed-vectors');
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
