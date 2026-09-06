import assert from 'node:assert/strict';
import test from 'node:test';
import { runLearningReview } from '../src/learning-review-runner.mjs';
import { resolveLearningReviewRequest } from '../src/learning-review.mjs';

const NOW = Date.parse('2026-09-06T04:00:00Z');
const INVALID_JSON = '{"facts":[{"topic":"CUDA" "statement":"已经学习 CUDA 的线程块","evidence":[]}]}';

function factsFor(input) {
  return { facts: input.segments.filter((segment) => segment.dateBasis !== 'related').map((segment) => ({
    topic: 'CUDA', statement: '已完成 "CUDA" 练习。', status: 'completed',
    evidence: [{ segmentId: segment.id, path: segment.path, lineStart: segment.lineStart,
      lineEnd: segment.lineStart, quote: segment.text.split('\n')[0] }],
  })) };
}

function fixture(files, generate, { controller = new AbortController(), budgetAvailable = () => true } = {}) {
  const calls = [];
  const events = [];
  let active = 0;
  let peak = 0;
  const promise = runLearningReview({
    task: { abortController: controller },
    review: resolveLearningReviewRequest('总结最近一个月的学习重点', { now: NOW, timeZone: 'Asia/Shanghai' }),
    maxContextChars: 24_000,
    index: {
      listDocuments: () => [...files.keys()].map((path) => ({ path })),
      readDocument: async (path) => ({ text: files.get(path) }),
      search: async () => ({ results: [] }),
    },
    emit: (type, data) => events.push({ type, data }), budgetAvailable,
    generate: async (messages) => {
      const input = JSON.parse(messages[1].content);
      const number = calls.length + 1;
      calls.push({ number, input, messages });
      active += 1;
      peak = Math.max(peak, active);
      try { return await generate(input, number); }
      finally { active -= 1; }
    }, generateFinal: async () => ({ groups: [] }),
  });
  return { promise, calls, events, peak: () => peak };
}

function sourceCharacters(calls) {
  return calls.reduce((total, call) => total + call.input.segments.reduce((sum, segment) => sum + segment.text.length, 0), 0);
}

test('one malformed JSON batch retries once and recovers every small dated file without editing quoted values', async () => {
  const files = new Map(Array.from({ length: 12 }, (_, index) => [
    `diary/2026-08-${String(index + 7).padStart(2, '0')}.md`, '已完成 "CUDA" 练习。',
  ]));
  const value = fixture(files, (input, number) => number === 1 ? INVALID_JSON : JSON.stringify(factsFor(input)));
  const result = await value.promise;
  assert.equal(value.calls.length, 2);
  assert.equal(result.coverage.retries, 1);
  assert.equal(result.coverage.batches, 2);
  assert.equal(result.coverage.candidateRecords, 12);
  assert.equal(result.coverage.completeRecords, 12);
  assert.equal(result.coverage.failedRecords, 0);
  assert.equal(result.coverage.partialRecords, 0);
  assert.equal(result.coverage.budgetUncoveredRecords, 0);
  assert.equal(result.coverage.characters, sourceCharacters(value.calls));
  assert.equal(result.coverage.characters, [...files.values()].reduce((sum, text) => sum + text.length, 0) * 2);
  assert.deepEqual(value.calls[0].input, value.calls[1].input, 'retry must reuse the original source batch and identities');
  assert.match(value.calls[1].messages[0].content, /转义/u);
  assert.match(result.answer, /已完成 "CUDA" 练习/u);
  assert.equal(result.sources.length, 12);
});

test('parallel extraction and retries share the 12-call budget, with supplementary reading yielding to dates', async () => {
  const files = new Map(Array.from({ length: 12 }, (_, index) => {
    const first = `已完成 "CUDA" 练习。${index === 0 ? '[[notes/kernel]]' : ''}`;
    return [`diary/2026-08-${String(index + 7).padStart(2, '0')}.md`, `${first}\n${'合成背景'.repeat(500)}`];
  }));
  files.set('notes/kernel.md', '线程块说明。');
  const value = fixture(files, async (input, number) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return number === 1 ? INVALID_JSON : JSON.stringify(factsFor(input));
  });
  const result = await value.promise;
  assert.equal(value.peak(), 2);
  assert.equal(value.calls.length, 12);
  assert.equal(result.coverage.batches, 12);
  assert.equal(result.coverage.retries, 1);
  assert.equal(result.coverage.completeRecords, 11);
  assert.equal(result.coverage.failedRecords, 0);
  assert.equal(result.coverage.budgetUncoveredRecords, 1);
  assert.equal(result.coverage.supplementalComplete, 0);
  assert.equal(result.coverage.supplementalUncovered, 1);
  assert.ok(value.calls.every((call) => call.input.relatedFacts.length === 0));
  assert.equal(result.coverage.characters, sourceCharacters(value.calls));
  assert.ok(result.coverage.characters <= 240_000);
  assert.equal(result.coverage.completeRecords + result.coverage.partialRecords +
    result.coverage.failedRecords + result.coverage.budgetUncoveredRecords, result.coverage.candidateRecords);
});

test('well-formed JSON with invalid evidence is rejected without retrying the facts', async () => {
  const value = fixture(new Map([['diary/2026-09-05.md', '已完成 "CUDA" 练习。']]), (input) => {
    const output = factsFor(input);
    output.facts[0].evidence[0].quote = '这句话在原文不存在';
    return JSON.stringify(output);
  });
  const result = await value.promise;
  assert.equal(value.calls.length, 1);
  assert.equal(result.coverage.retries, 0);
  assert.equal(result.coverage.rejectedFacts, 1);
  assert.equal(result.sources.length, 0);
  assert.doesNotMatch(result.answer, /完成／已学习/u);
});

test('abort after malformed output terminates immediately without a retry', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('Synthetic cancellation'), { name: 'AbortError' });
  const value = fixture(new Map([['diary/2026-09-05.md', '已完成 "CUDA" 练习。']]), () => {
    controller.abort(reason);
    return INVALID_JSON;
  }, { controller });
  await assert.rejects(value.promise, (error) => error === reason);
  assert.equal(value.calls.length, 1);
  assert.equal(value.events.some((event) => event.data.title === '正在重试证据抽取'), false);
});

test('a top-level facts value that is not an array receives exactly one schema retry', async () => {
  const value = fixture(new Map([['diary/2026-09-05.md', '已完成 "CUDA" 练习。']]),
    (input, number) => number === 1 ? '{"facts":{"statement":"wrong shape"}}' : JSON.stringify(factsFor(input)));
  const result = await value.promise;
  assert.equal(value.calls.length, 2);
  assert.equal(result.coverage.retries, 1);
  assert.equal(result.coverage.completeRecords, 1);
  assert.equal(result.coverage.failedRecords, 0);
});

test('permanently malformed output stops after one retry and reports the attempted file as failed', async () => {
  const value = fixture(new Map([['diary/2026-09-05.md', '已完成 "CUDA" 练习。']]), () => INVALID_JSON);
  const result = await value.promise;
  assert.equal(value.calls.length, 2);
  assert.equal(result.coverage.retries, 1);
  assert.equal(result.coverage.failedRecords, 1);
  assert.equal(result.coverage.completeRecords, 0);
  assert.equal(result.coverage.budgetUncoveredRecords, 0);
  assert.equal(result.coverage.characters, sourceCharacters(value.calls));
  assert.match(result.answer, /存在覆盖缺口/u);
});


test('a transient network failure retries once, while authentication failures do not', async () => {
  const files = new Map([['diary/2026-09-05.md', '已完成 "CUDA" 练习。']]);
  for (const code of ['LLM_NETWORK_ERROR', 'LLM_AUTH_FAILED']) {
    const value = fixture(files, (input, number) => {
      if (number === 1) throw Object.assign(new Error('Synthetic provider failure'), { code });
      return factsFor(input);
    });
    const result = await value.promise;
    assert.equal(value.calls.length, code === 'LLM_NETWORK_ERROR' ? 2 : 1);
    assert.equal(result.coverage.completeRecords, code === 'LLM_NETWORK_ERROR' ? 1 : 0);
    assert.equal(result.coverage.failedRecords, code === 'LLM_AUTH_FAILED' ? 1 : 0);
  }
});
