import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveLearningReviewRequest, learningReviewLimits } from '../src/learning-review.mjs';
import { TaskManager } from '../src/task-manager.mjs';

test('real TaskManager callbacks retain original output ceilings and requested effort for extraction and grouping', async () => {
  const calls = [];
  const task = { abortController: new AbortController(), deadlineAt: Date.now() + learningReviewLimits.timeoutMs,
    modelCallSequence: 0, learningReview: resolveLearningReviewRequest('回顾过去30天读过什么', {
      now: Date.parse('2026-09-06T04:00:00Z'), timeZone: 'Asia/Shanghai',
    }) };
  const conversation = { messages: [] };
  const manager = {
    config: { retrieval: { maxContextChars: 24_000 } }, emit() {},
    generationOptions: () => ({ effort: 'xhigh', maxOutputTokens: 4_096 }),
    taskIndex: () => ({ listDocuments: async () => [{ path: 'diary/2026-08-31.md' }],
      readDocument: async () => ({ text: '已完成 Orion 阅读。' }), search: async () => ({ results: [] }) }),
    generateModel: async (current, purpose, messages, options) => {
      current.modelCallSequence += 1; calls.push({ purpose, options });
      if (purpose === 'learning_review_group') return { groups: [{ title: 'Orion', factIds: ['F1'] }] };
      const segment = JSON.parse(messages[1].content).segments[0];
      return { facts: [{ topic: 'Orion', statement: '已完成 Orion 阅读。', status: 'completed',
        evidence: [{ segmentId: segment.id, lineStart: 1, lineEnd: 1 }] }] };
    },
  };
  await TaskManager.prototype.runDeterministicLearningReview.call(manager, task, conversation);
  assert.deepEqual(calls.map((call) => call.purpose), ['learning_review_extract', 'learning_review_group']);
  for (const { options } of calls) {
    assert.equal(options.maxOutputTokens, 131_072, '4K is an accidental migration-only ceiling');
    assert.equal(options.effort, 'xhigh');
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 600_000);
  }
  assert.match(conversation.messages[0].content, /已完成 Orion 阅读/u);
});

test('general personal activity recaps resolve without exact-phrase hardcoding', () => {
  const options = {
    now: Date.parse('2026-09-06T04:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
  };
  for (const prompt of [
    '总结最近一个月的学习重点',
    '我这一个月都学了什么',
    '回顾过去30天读过什么',
    '盘点本月做过的学习工作',
    '总结我最近一个月都做了什么',
  ]) assert.equal(resolveLearningReviewRequest(prompt, options)?.kind, 'learning_review', prompt);
  for (const prompt of [
    '机器学习最近一个月最新进展',
    '列出最近一个月修改的文件',
    '总结人工智能行业近期研究动态',
  ]) assert.equal(resolveLearningReviewRequest(prompt, options), null, prompt);
});

test('TaskManager reaches the deterministic review runner but never an autonomous Pi edge', async () => {
  const source = await fsp.readFile(new URL('../src/task-manager.mjs', import.meta.url), 'utf8');
  assert.match(source, /resolveLearningReviewRequest|runLearningReview/u);
  assert.doesNotMatch(source, /personal_learning_review/u);
  assert.doesNotMatch(source, /this\.piAgent\.(?:supports|runQa|runDraft)\s*\(/u);
  assert.doesNotMatch(source, /new\s+PiAgentRuntime\s*\(/u);
});

test('production graph reaches Pi single generation and the server review runner, never Agent tools', async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const pending = [path.join(sourceRoot, 'bootstrap.mjs')];
  const visited = new Set();
  const imports = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/gu;

  while (pending.length) {
    const filename = pending.pop();
    if (visited.has(filename)) continue;
    visited.add(filename);
    const source = await fsp.readFile(filename, 'utf8');
    for (const match of source.matchAll(imports)) {
      const resolved = path.resolve(path.dirname(filename), match[1]);
      if (resolved.startsWith(`${sourceRoot}${path.sep}`)) pending.push(resolved);
    }
  }

  const relative = [...visited].map((filename) => path.relative(sourceRoot, filename));
  assert(relative.includes('pi-generation-executor.mjs'));
  assert.equal(relative.includes('pi-agent-runtime.mjs'), false);
  assert.equal(relative.includes('pi-agent-tools.mjs'), false);
  assert.equal(relative.includes('learning-review-runner.mjs'), true);
  const production = (await Promise.all([...visited].map((filename) => fsp.readFile(filename, 'utf8')))).join('\n');
  assert.doesNotMatch(production, /personal_learning_review/u);
  assert.doesNotMatch(production, /learning review permits at most (?:64|128)|256 knowledge-tool/iu);
});
