import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CompletenessEvalError,
  assertRedactedCompletenessReport,
  createOfflineEmbeddingClient,
  evaluateCompleteness,
  logicalRetrievalMetrics,
  measuredCompletenessReport,
  parseCompletenessDataset,
  sha256,
  writePrivateReport,
} from '../scripts/lib/completeness-eval.mjs';

function fixture(count = 2) {
  const clean = ['# Synthetic questions'];
  const gold = ['# Synthetic detailed questions'];
  for (let number = 1; number <= count; number += 1) {
    const question = `Find synthetic topic ${number}`;
    clean.push(`**${number}.** ${question}`);
    gold.push(
      `### 题目 ${number}：${question}`,
      '',
      '**考察维度**：Synthetic only',
      '',
      '**应命中来源（共 2 篇）**：',
      '| 序号 | 笔记路径 | 贡献 |',
      '|---|---|---|',
      `| 1 | Notes/Topic-${number}.md | Primary |`,
      `| 2 | Notes/Topic-${number}_整理版.md | Variant |`,
      '',
      '**参考答案要点**：',
      '1. This text must never enter a report.',
      '',
      '**评分标准**：Synthetic rubric.',
      '',
    );
  }
  return { clean: clean.join('\n'), gold: gold.join('\n') };
}

test('parses clean questions and full gold without retaining answer text', () => {
  const input = fixture();
  const dataset = parseCompletenessDataset(input.clean, input.gold, { expectedCount: 2 });
  assert.equal(dataset.length, 2);
  assert.equal(dataset[0].physicalGoldPaths.length, 2);
  assert.equal(dataset[0].logicalGoldIds.length, 1);
  assert.equal(Object.hasOwn(dataset[0], 'answer'), false);
  assert.equal(JSON.stringify(dataset).includes('never enter a report'), false);
});

test('rejects a clean/full question mismatch', () => {
  const input = fixture(1);
  assert.throws(
    () => parseCompletenessDataset(input.clean.replace('topic 1', 'different'), input.gold, {
      expectedCount: 1,
    }),
    (error) => error instanceof CompletenessEvalError && error.code === 'QUESTION_TEXT_MISMATCH',
  );
});

test('scores logical variants once and reports coverage, MRR, and nDCG', () => {
  const metrics = logicalRetrievalMetrics(
    ['notes/topic-1.md', 'notes/second.md'],
    [
      { path: 'Notes/irrelevant.md' },
      { path: 'Notes/Topic-1_整理版.md' },
      { path: 'Notes/Topic-1.md' },
      { path: 'Notes/second.md' },
    ],
    [1, 2, 4],
  );
  assert.equal(metrics.goldLogicalCount, 2);
  assert.equal(metrics.returnedLogicalCount, 3);
  assert.equal(metrics.byK['1'].goldCoverage, 0);
  assert.equal(metrics.byK['2'].goldCoverage, 0.5);
  assert.equal(metrics.byK['4'].goldCoverage, 1);
  assert.equal(metrics.mrr, 0.5);
  assert.ok(metrics.byK['4'].ndcg > 0 && metrics.byK['4'].ndcg < 1);
});

test('hybrid evaluation fails closed when retrieval silently falls back', async () => {
  const dataset = [{ number: 1, question: 'synthetic', logicalGoldIds: ['notes/a.md'] }];
  await assert.rejects(
    evaluateCompleteness(dataset, {
      route: 'hybrid',
      kValues: [1],
      search: async () => ({
        route: 'keyword',
        diagnostics: { embeddingUsed: false },
        results: [{ path: 'Notes/A.md' }],
      }),
    }),
    (error) => error instanceof CompletenessEvalError &&
      error.code === 'QUERY_VECTORS_REQUIRED_OFFLINE',
  );
});

test('offline embedding client serves only precomputed query vectors', async () => {
  const vectors = new Map([[sha256('synthetic query'), [0.25, 0.75]]]);
  const client = createOfflineEmbeddingClient({
    enabled: true,
    provider: 'synthetic',
    model: 'fixture',
    dimensions: 2,
  }, vectors);
  assert.deepEqual(
    await client.embed(['synthetic query'], { textType: 'query' }),
    [[0.25, 0.75]],
  );
  await assert.rejects(
    client.embed(['document'], { textType: 'document' }),
    (error) => error.code === 'OFFLINE_EMBEDDING_FORBIDDEN',
  );
});

test('redacted reports contain no question, answer, path, or candidate identifiers', async (t) => {
  const evaluation = await evaluateCompleteness([
    { number: 1, question: 'private in memory only', logicalGoldIds: ['notes/a.md'] },
  ], {
    route: 'keyword',
    kValues: [1],
    search: async () => ({ route: 'keyword', results: [{ path: 'Notes/A.md' }] }),
  });
  const report = measuredCompletenessReport(evaluation, { route: 'keyword' });
  assert.equal(assertRedactedCompletenessReport(report), true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('private in memory only'), false);
  assert.equal(serialized.includes('Notes/A.md'), false);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'completeness-redaction-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const output = path.join(root, '.local', 'reports', 'result.json');
  await writePrivateReport(output, report, root);
  const stat = await fsp.stat(output);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('report privacy guard rejects private fields and paths', () => {
  assert.throws(
    () => assertRedactedCompletenessReport({ records: [{ question: 'secret' }] }),
    (error) => error.code === 'REPORT_PRIVACY_VIOLATION',
  );
  assert.throws(
    () => assertRedactedCompletenessReport({ note: 'learning_doc/private.md' }),
    (error) => error.code === 'REPORT_PRIVACY_VIOLATION',
  );
});
