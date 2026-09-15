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

test('parallel extraction and retries share the 50-turn plan, with supplementary reading yielding to dates', async () => {
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
  assert.ok(value.calls.length <= 49);
  assert.equal(result.coverage.batches, value.calls.length);
  assert.equal(result.coverage.retries, 1);
  assert.equal(result.coverage.completeRecords, 12);
  assert.equal(result.coverage.failedRecords, 0);
  assert.equal(result.coverage.budgetUncoveredRecords, 0);
  assert.ok(value.calls.slice(0, 13).every((call) => call.input.relatedFacts.length === 0));
  assert.equal(result.coverage.characters, sourceCharacters(value.calls));
  assert.ok(result.coverage.characters <= 960_000);
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

test('compact evidence references recover exact quotes from the snapshot, never from model text', async () => {
  const value = fixture(new Map([['diary/2026-09-05.md', '已完成 CUDA 练习。']]), (input) => ({
    facts: [{ topic: 'CUDA', statement: '已完成 CUDA 练习。', status: 'completed',
      evidence: [{ segmentId: input.segments[0].id, lineStart: input.segments[0].lineStart,
        lineEnd: input.segments[0].lineStart }] }],
  }));
  const result = await value.promise;
  assert.equal(result.coverage.completeRecords, 1);
  assert.equal(result.coverage.rejectedFacts, 0);
  assert.match(result.answer, /已完成 CUDA 练习/u);
  assert.match(result.answer, /diary\/2026-09-05\.md/u);
  const segment = value.calls[0].input.segments[0];
  assert.equal(segment.numberedText, `${segment.lineStart}│已完成 CUDA 练习。`);
  assert.equal(segment.text, '已完成 CUDA 练习。', 'numbering must not alter canonical evidence or source budgets');
});

test('compact references cannot select lines outside the scheduled segment or promote a plan', async () => {
  for (const outside of [false, true]) {
    const value = fixture(new Map([['plan/2026-09-05.md', '- [ ] 计划阅读 CUDA。']]), (input) => ({
      facts: [{ topic: 'CUDA', statement: '阅读 CUDA。', status: 'completed',
        evidence: [{ segmentId: input.segments[0].id,
          lineStart: input.segments[0].lineStart,
          lineEnd: outside ? input.segments[0].lineEnd + 1 : input.segments[0].lineStart }] }],
    }));
    if (outside) {
      await assert.rejects(value.promise, (error) => error.code === 'REVIEW_EXTRACTION_FAILED' && error.coverage.completeRecords === 0);
      assert.equal(value.calls.length, 2, 'unparseable whole-batch references get one bounded repair attempt, never fabricated evidence');
    } else {
      const result = await value.promise;
      assert.doesNotMatch(result.answer, /完成／已学习/u);
      assert.equal(result.coverage.rejectedFacts, 0);
      assert.match(result.answer, /计划/u);
    }
  }
});

test('batch-local references accept integer serialization or an exact unique path without exposing opaque IDs', async () => {
  for (const byPath of [false, true]) {
    const value = fixture(new Map([['diary/2026-09-05.md', '已完成 Orion 阅读。']]), (input) => {
      assert.equal(input.segments[0].id, 'S1');
      return { facts: [{ topic: 'Orion', statement: '已完成 Orion 阅读。', status: 'completed', evidence: [{
        ...(byPath ? { path: input.segments[0].path } : { segmentId: 'S1' }), lineStart: '1', lineEnd: '1',
      }] }] };
    });
    const result = await value.promise;
    assert.equal(result.coverage.completeRecords, 1);
    assert.equal(result.coverage.retries, 0);
    assert.match(result.answer, /完成／已学习[\s\S]*Orion/u);
  }
});

test('an all-malformed reference batch retries once with stable aliases and recovers the source set', async () => {
  const value = fixture(new Map([['diary/2026-09-05.md', '已完成 "CUDA" 练习。']]), (input, number) => {
    const facts = factsFor(input);
    if (number === 1) facts.facts[0].evidence = [{ segmentId: 'S999', lineStart: 1, lineEnd: 1 }];
    return facts;
  });
  const result = await value.promise;
  assert.equal(value.calls.length, 2);
  assert.deepEqual(value.calls[0].input, value.calls[1].input);
  assert.equal(result.coverage.retries, 1);
  assert.equal(result.coverage.completeRecords, 1);
  assert.equal(result.coverage.failedRecords, 0);
  const diagnostic = value.events.find((event) => event.data.title === '证据引用格式无效').data.diagnostics;
  assert.equal(diagnostic.unresolvedReferences, 1);
  assert.equal(diagnostic.missingQuotes, 1);
  assert.ok(Object.values(diagnostic).every((value) => typeof value === 'number'), 'diagnostics never store private model prose');
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

test('permanently malformed output fails the task after one retry instead of publishing an empty review', async () => {
  const value = fixture(new Map([['diary/2026-09-05.md', '已完成 "CUDA" 练习。']]), () => INVALID_JSON);
  let failure;
  await assert.rejects(value.promise, (error) => { failure = error; return error.code === 'REVIEW_EXTRACTION_FAILED'; });
  const result = { coverage: failure.coverage };
  assert.equal(value.calls.length, 2);
  assert.equal(result.coverage.retries, 1);
  assert.equal(result.coverage.failedRecords, 1);
  assert.equal(result.coverage.completeRecords, 0);
  assert.equal(result.coverage.budgetUncoveredRecords, 0);
  assert.equal(result.coverage.characters, sourceCharacters(value.calls));
  assert.ok(value.events.some((event) => event.data.title === '学习回顾处理失败'));
});

test('locally excluded reference material cannot mask the failure of every actual activity batch', async () => {
  const value = fixture(new Map([
    ['diary/2026-09-05.md', '已完成课程练习。'],
    ['notes/2026-09-05.md', '仅为资料，不能证明活动。'],
  ]), () => INVALID_JSON);
  await assert.rejects(value.promise, { code: 'REVIEW_EXTRACTION_FAILED' });
});


test('a transient network failure retries once, while authentication failures do not', async () => {
  const files = new Map([['diary/2026-09-05.md', '已完成 "CUDA" 练习。']]);
  for (const code of ['LLM_NETWORK_ERROR', 'LLM_AUTH_FAILED']) {
    const value = fixture(files, (input, number) => {
      if (number === 1) throw Object.assign(new Error('Synthetic provider failure'), { code });
      return factsFor(input);
    });
    if (code === 'LLM_AUTH_FAILED') {
      await assert.rejects(value.promise, { code });
      assert.equal(value.calls.length, 1);
      continue;
    }
    const result = await value.promise;
    assert.equal(value.calls.length, code === 'LLM_NETWORK_ERROR' ? 2 : 1);
    assert.equal(result.coverage.completeRecords, code === 'LLM_NETWORK_ERROR' ? 1 : 0);
    assert.equal(result.coverage.failedRecords, code === 'LLM_AUTH_FAILED' ? 1 : 0);
  }
});
