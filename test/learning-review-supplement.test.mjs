import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLearningReviewRequest } from '../src/learning-review.mjs';
import { runLearningReview } from '../src/learning-review-runner.mjs';

const NOW = Date.parse('2026-09-06T04:00:00Z');

async function runFixture(files, { maxContextChars = 24_000, question = '总结最近一个月的学习重点',
  supplement, extraction, budgetAvailable = () => true } = {}) {
  const inputs = [];
  const review = resolveLearningReviewRequest(question, { now: NOW, timeZone: 'Asia/Shanghai' });
  const result = await runLearningReview({
    task: { abortController: new AbortController() }, review, maxContextChars,
    index: {
      listDocuments: () => [...files.keys()].map((path) => ({ path })),
      readDocument: async (path) => ({ text: files.get(path) }),
      search: async () => ({ results: [] }),
    }, emit() {}, budgetAvailable,
    generate: async (messages) => {
      const input = JSON.parse(messages[1].content);
      inputs.push(input);
      if (input.relatedFacts.length) {
        if (supplement) return { facts: await supplement(input) };
        return { facts: [supplementFact(input)] };
      }
      if (extraction) return { facts: extraction(input) };
      return { facts: input.segments.flatMap((segment) => segment.text.split('\n')
        .flatMap((line, offset) => {
          if (!/已完成|计划|彻底完成/u.test(line)) return [];
          return [{ topic: line.includes('CS336') ? 'CS336' : 'CUDA',
            statement: line.split('[[')[0], status: line.includes('计划') ? 'planned' : 'completed',
            evidence: [{ segmentId: segment.id, path: segment.path,
              lineStart: segment.lineStart + offset, lineEnd: segment.lineStart + offset, quote: line }],
          }];
        })) };
    }, generateFinal: async () => ({ groups: [] }),
  });
  return { ...result, inputs };
}

function supplementFact(input, statement = null) {
  const parent = input.relatedFacts[0];
  const note = input.segments.find((segment) => segment.dateBasis === 'related');
  const line = note.text.split('\n')[0];
  return {
    parentFactId: parent.id, topic: parent.topic, status: parent.status,
    eventDate: parent.eventDate, dateRange: parent.dateRange,
    statement: statement || line,
    evidence: [parent.evidence[0], { segmentId: note.id, path: note.path,
      lineStart: note.lineStart, lineEnd: note.lineStart, quote: line.slice(0, 100) }],
  };
}

test('supplementary notes bind to the exact dated event and cited lines, including repeated topics', async () => {
  const files = new Map([
    ['diary/2026-08-10.md', '已完成 CUDA 基础。[[notes/基础]]'],
    ['diary/2026-09-05.md', '已完成 CUDA 新练习。[[notes/新练习]]\n已完成 CS336。[[notes/CS336]]'],
    ['notes/基础.md', '线程块基础说明。'], ['notes/新练习.md', '共享内存新练习说明。'],
    ['notes/CS336.md', '优化器说明。'],
  ]);
  const result = await runFixture(files);
  const supplemental = result.inputs.filter((input) => input.relatedFacts.length);
  assert.equal(supplemental.length, 3);
  const byNote = new Map(supplemental.map((input) => [
    input.segments.find((segment) => segment.dateBasis === 'related').path, input,
  ]));
  assert.equal(byNote.get('notes/基础.md').relatedFacts[0].eventDate, '2026-08-10');
  assert.equal(byNote.get('notes/新练习.md').relatedFacts[0].eventDate, '2026-09-05');
  assert.equal(byNote.get('notes/CS336.md').relatedFacts[0].topic, 'CS336');
  const csAnchor = byNote.get('notes/CS336.md').segments.find((segment) => segment.dateBasis !== 'related');
  assert.equal(csAnchor.lineStart, 2);
  assert.equal(csAnchor.lineEnd, 2);
  assert.doesNotMatch(csAnchor.text, /CUDA/u);
  assert.equal(result.coverage.supplementalComplete, 3);
  assert.match(result.answer, /关联笔记说明：共享内存新练习说明/u);
  assert.equal((result.answer.match(/^- \*\*/gmu) || []).length, 3, 'supporting text cannot add new learning events');
  assert.equal(result.sources.length, 5);
});

test('supplement cannot invent its parent, date, topic, completion, or omit either primary and note evidence', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-09-05.md', '计划阅读 CUDA。[[notes/kernel]]'],
    ['notes/kernel.md', '线程块共享内存说明。'],
  ]), { supplement: (input) => {
    const valid = supplementFact(input, '允许保留的笔记解释');
    return [valid,
      { ...valid, parentFactId: 'invented', statement: '错误父事件' },
      { ...valid, eventDate: '2026-08-03', statement: '错误日期' },
      { ...valid, status: 'completed', statement: '错误完成状态' },
      { ...valid, topic: 'RC-flow', statement: '错误主题' },
      { ...valid, evidence: [valid.evidence[1]], statement: '缺少期内证据' },
      { ...valid, evidence: [valid.evidence[0]], statement: '缺少笔记原文' },
      { ...valid, evidence: [{ ...valid.evidence[0], quote: 'CUDA' }, valid.evidence[1]], statement: '省略原事实引文' },
    ];
  } });
  assert.match(result.answer, /计划.*2026-09-05/u);
  assert.match(result.answer, /允许保留的笔记解释/u);
  assert.doesNotMatch(result.answer, /错误父事件|错误日期|错误完成状态|错误主题|缺少期内证据|缺少笔记原文|省略原事实引文|RC-flow/u);
  assert.equal(result.coverage.rejectedFacts, 7);
});

test('a long single-line supplement respects each source budget and accounts for missing pieces', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-09-05.md', '已完成 CUDA。[[notes/kernel]]'],
    ['notes/kernel.md', '合成说明'.repeat(2500)],
  ]), { maxContextChars: 512, supplement: () => [] });
  for (const input of result.inputs) {
    assert.ok(input.segments.reduce((sum, segment) => sum + segment.text.length, 0) <= 512);
  }
  assert.equal(result.coverage.batches, 12);
  assert.ok(result.coverage.characters <= 12 * 512);
  assert.equal(result.coverage.supplementalComplete, 0);
  assert.equal(result.coverage.supplementalPartial, 1);
  assert.match(result.answer, /存在覆盖缺口/u);
});

test('global 240000-character budget includes repeated primary evidence for supplementary batches', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-09-05.md', '已完成 CUDA。[[notes/kernel]]'],
    ['notes/kernel.md', '合成说明'.repeat(70_000)],
  ]), { supplement: () => [] });
  assert.ok(result.coverage.characters <= 240_000);
  assert.ok(result.coverage.batches <= 12);
  assert.equal(result.coverage.supplementalPartial, 1);
  assert.equal(result.coverage.supplementalComplete, 0);
  assert.equal(result.coverage.characters, result.inputs.reduce((sum, input) => sum +
    input.segments.reduce((chars, segment) => chars + segment.text.length, 0), 0));
});

test('multiple references to one note retain both original events and bind its explanation to the latest event', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-08-10.md', '已完成 CUDA 基础。[[notes/kernel]]'],
    ['diary/2026-09-05.md', '已完成 CUDA 复习。[[notes/kernel]]'],
    ['notes/kernel.md', '共享内存说明。'],
  ]));
  const supplementary = result.inputs.filter((input) => input.relatedFacts.length);
  assert.equal(supplementary.length, 1);
  assert.equal(supplementary[0].relatedFacts[0].eventDate, '2026-09-05');
  assert.match(result.answer, /2026-08-10/u);
  assert.match(result.answer, /2026-09-05/u);
});

test('supplementary batches across notes run concurrently with at most two isolated parent bindings', { timeout: 2_000 }, async () => {
  const started = [];
  const releases = [];
  let active = 0;
  let peak = 0;
  const result = await runFixture(new Map([
    ['diary/2026-08-10.md', '已完成 CUDA 基础。[[notes/kernel]]'],
    ['diary/2026-09-05.md', '已完成 CS336 优化器。[[notes/optimizer]]\n已完成 CUDA 新练习。[[notes/new]]'],
    ['notes/kernel.md', '线程块基础说明。'], ['notes/optimizer.md', '优化器说明。'],
    ['notes/new.md', '共享内存新练习说明。'],
  ]), { supplement: async (input) => {
    const note = input.segments.find((segment) => segment.dateBasis === 'related');
    started.push({ path: note.path, parentId: input.relatedFacts[0].id, topic: input.relatedFacts[0].topic });
    active += 1;
    peak = Math.max(peak, active);
    try {
      if (started.length <= 2) {
        await new Promise((resolve) => {
          releases.push(resolve);
          if (releases.length === 2) releases.forEach((release) => release());
        });
      }
      return [supplementFact(input)];
    } finally { active -= 1; }
  } });
  assert.equal(peak, 2, 'distinct single-batch notes must overlap, while never exceeding two calls');
  assert.equal(new Set(started.slice(0, 2).map((item) => item.path)).size, 2);
  assert.equal(started.find((item) => item.path === 'notes/optimizer.md').topic, 'CS336');
  assert.equal(started.find((item) => item.path === 'notes/kernel.md').topic, 'CUDA');
  assert.equal(result.coverage.supplementalComplete, 3);
  assert.ok(result.inputs.filter((input) => input.relatedFacts.length).every((input) =>
    input.segments.reduce((sum, segment) => sum + segment.text.length, 0) <= 8_000));
});

test('uncertain cross-boundary activity contributes to the displayed coverage gap', async () => {
  const result = await runFixture(new Map([
    ['weekly/2026-08-03~2026-08-09.md', '- [x] 已完成 CUDA 练习。'],
  ]));
  assert.equal(result.coverage.temporalUncertainCount, 1);
  assert.match(result.answer, /时间归属未确认 1 条/u);
  assert.match(result.answer, /存在覆盖缺口/u);
  assert.doesNotMatch(result.answer, /完成／已学习/u);
});

test('last month displays the last included calendar day and no claim it extends to task start', async () => {
  const result = await runFixture(new Map(), { question: '总结上个月的学习重点' });
  assert.match(result.answer, /2026-08-01 至 2026-08-31/u);
  assert.doesNotMatch(result.answer, /至 2026-09-01|截至首轮提问/u);
});


test('dated reference material may explain a real event after being rejected as a personal activity anchor', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-09-05.md', '计划阅读 CUDA。[[notes/2026-09-04]]'],
    ['notes/2026-09-04.md', '线程块共享内存说明。'],
  ]));
  assert.equal(result.coverage.candidateRecords, 2);
  assert.equal(result.coverage.completeRecords, 2);
  assert.equal(result.coverage.supplementalComplete, 1);
  assert.equal((result.answer.match(/^- \*\*/gmu) || []).length, 1);
  assert.match(result.answer, /计划.*2026-09-05/u);
  assert.match(result.answer, /关联笔记说明：线程块共享内存说明/u);
});
