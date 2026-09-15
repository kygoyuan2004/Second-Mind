import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { routeKnowledgeQuery } from '../src/knowledge-index.mjs';
import { learningReviewLimits, resolveLearningReviewRequest } from '../src/learning-review.mjs';
import { DEFAULT_PI_CONTEXT_WINDOW_TOKENS } from '../src/pi-context-policy.mjs';
import { runtimeConfigInternals } from '../../../src/runtime-config-registry.mjs';

const ORIGINAL_ROOT = process.env.ORIGINAL_SECOND_MIND_ROOT || path.resolve('unavailable-original-source');
const TARGET_ROOT = path.resolve(new URL('..', import.meta.url).pathname);

async function exists(filename) {
  try { await fsp.access(filename); return true; } catch { return false; }
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('original and Pi migration retain the same review, retrieval and model contract', {
  skip: !(await exists(path.join(ORIGINAL_ROOT, 'lib', 'learning-review.mjs'))),
}, async () => {
  const originalReviewModule = await import(pathToFileURL(
    path.join(ORIGINAL_ROOT, 'lib', 'learning-review.mjs'),
  ));
  const originalIndexModule = await import(pathToFileURL(
    path.join(ORIGINAL_ROOT, 'lib', 'knowledge-index.mjs'),
  ));
  const originalModelModule = await import(pathToFileURL(
    path.join(ORIGINAL_ROOT, 'lib', 'model-catalog.mjs'),
  ));

  assert.deepEqual(
    {
      maxTurns: learningReviewLimits.maxTurns,
      timeoutMs: learningReviewLimits.timeoutMs,
      maxToolCalls: learningReviewLimits.maxReadSearchCalls,
      retrievalTimeoutMs: learningReviewLimits.retrievalTimeoutMs,
    },
    originalReviewModule.learningReviewExecutionBudget,
  );

  const now = Date.parse('2026-09-06T04:00:00.000Z');
  for (const question of [
    '总结我最近一个月的学习重点', '回顾我上个月学了什么', '盘点我本月的学习情况',
    '总结我本周学了什么', '回顾我上周学习情况', '总结我最近一周学了什么',
    '总结我今天学了什么', '总结我昨天学了什么', '总结我近期学习重点',
    '总结我从2026-08-10至2026-08-20学了什么',
  ]) {
    const originalWindow = originalReviewModule.createLearningReview(
      question, { now, timeZone: 'Asia/Shanghai' },
    );
    const migratedWindow = resolveLearningReviewRequest(
      question, { now, timeZone: 'Asia/Shanghai' },
    );
    assert.ok(originalWindow && migratedWindow, question);
    assert.equal(migratedWindow.range.startInclusive, originalWindow.startInclusive, question);
    assert.equal(
      Date.parse(migratedWindow.range.endExclusive) - 1,
      Date.parse(originalWindow.endInclusive),
      question,
    );
  }

  for (const query of [
    '列出所有包含 `queryVector` 的文件',
    '2026-08-31 的计划是什么？',
    'CS336 的训练闭环包括什么？',
  ]) {
    assert.deepEqual(routeKnowledgeQuery(query), originalIndexModule.routeKnowledgeQuery(query));
  }

  const originalQwen = originalModelModule.MODEL_CATALOG.find((model) => model.id === 'qwen');
  const targetQwen = runtimeConfigInternals.MODEL_SLOTS.find((model) => model.id === 'qwen');
  assert.equal(originalQwen.actualModel, 'qwen3.8-max[1M]');
  assert.equal(runtimeConfigInternals.normalizeOriginalQwenAlias('qwen', 'qwen3.8-max'), originalQwen.actualModel);
  assert.equal(runtimeConfigInternals.normalizeOriginalQwenAlias('qwen', 'qwen3.8-max-0902'), originalQwen.actualModel);
  assert.equal(runtimeConfigInternals.normalizeOriginalQwenAlias('custom', 'qwen3.8-max'), 'qwen3.8-max');
  assert.equal(originalQwen.defaultEffort, targetQwen.defaultEffort);
  assert.equal(originalQwen.defaultEffort, 'xhigh');
  assert.equal(DEFAULT_PI_CONTEXT_WINDOW_TOKENS, 1_000_000);
  const originalExecutor = await fsp.readFile(path.join(ORIGINAL_ROOT, 'lib', 'knowledge-agent.mjs'), 'utf8');
  const originalOutputCeiling = Number(originalExecutor.match(/const DEFAULT_MAX_OUTPUT_TOKENS = ([\d_]+);/u)?.[1]?.replaceAll('_', ''));
  assert.equal(learningReviewLimits.extractionOutputTokens, originalOutputCeiling);
  assert.ok(learningReviewLimits.extractionTimeoutMs <= learningReviewLimits.timeoutMs);
});

test('knowledge visual assets equal the original while migration management controls remain available', {
  skip: !(await exists(path.join(ORIGINAL_ROOT, 'public', 'knowledge.html'))),
}, async () => {
  const exactFiles = [
    'knowledge.css', 'agent-render.js', 'knowledge-clipboard.js', 'knowledge-sources.js',
    'styles.css', 'overrides.css', 'site-config.js',
    'assets/chengdu-university-of-technology-logo.png',
    'assets/zhejiang-university-logo.png',
    'vendor/dompurify/purify.min.js', 'vendor/katex/auto-render.min.js',
    'vendor/katex/katex.min.css', 'vendor/katex/katex.min.js',
    'vendor/marked/marked.umd.js',
  ];
  for (const relative of exactFiles) {
    const [original, migrated] = await Promise.all([
      fsp.readFile(path.join(ORIGINAL_ROOT, 'public', relative)),
      fsp.readFile(path.join(TARGET_ROOT, 'public', relative)),
    ]);
    assert.equal(digest(migrated), digest(original), relative);
  }

  const [originalHtml, migratedHtml, originalJs, migratedJs] = await Promise.all([
    fsp.readFile(path.join(ORIGINAL_ROOT, 'public', 'knowledge.html'), 'utf8'),
    fsp.readFile(path.join(TARGET_ROOT, 'public', 'knowledge.html'), 'utf8'),
    fsp.readFile(path.join(ORIGINAL_ROOT, 'public', 'knowledge.js'), 'utf8'),
    fsp.readFile(path.join(TARGET_ROOT, 'public', 'knowledge.js'), 'utf8'),
  ]);
  // Management, branding and multi-vault isolation are explicitly retained
  // migration features. Compare the original controls/assets, not whole-file
  // hashes that would incorrectly require deleting those features again.
  for (const match of originalHtml.matchAll(/id="(knowledge-[^"]+)"/gu)) {
    assert.ok(migratedHtml.includes(`id="${match[1]}"`), match[1]);
  }
  for (const id of ['knowledge-base-select', 'knowledge-admin-config', 'knowledge-app-name']) {
    assert.ok(migratedHtml.includes(`id="${id}"`), id);
  }
  assert.ok(originalJs.includes('createSourcePreview'));
  assert.ok(migratedJs.includes('createSourcePreview'));
  assert.ok(migratedJs.includes('switchKnowledgeBase'));

  for (const omitted of ['drive.html', 'drive.js', 'home.html', 'home.js']) {
    assert.equal(await exists(path.join(TARGET_ROOT, 'public', omitted)), false, omitted);
  }
});
