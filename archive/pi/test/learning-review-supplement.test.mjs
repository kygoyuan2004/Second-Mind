import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLearningReviewRequest } from '../src/learning-review.mjs';
import { runLearningReview } from '../src/learning-review-runner.mjs';

const NOW = Date.parse('2026-09-06T04:00:00Z');

async function runFixture(files, { maxContextChars = 24_000, question = '总结最近一个月的学习重点',
  supplement, extraction, budgetAvailable = () => true, documentMetadata = () => ({}),
  search = async () => ({ results: [] }) } = {}) {
  const inputs = [];
  const callOptions = [];
  const review = resolveLearningReviewRequest(question, { now: NOW, timeZone: 'Asia/Shanghai' });
  const result = await runLearningReview({
    task: { abortController: new AbortController() }, review, maxContextChars,
    index: {
      listDocuments: () => [...files.keys()].map((path) => ({ path, ...documentMetadata(path) })),
      readDocument: async (path) => ({ text: files.get(path) }),
      search,
    }, emit() {}, budgetAvailable,
    generate: async (messages, options) => {
      callOptions.push(options);
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
  return { ...result, inputs, callOptions };
}

test('event dates win when immutable index mtime points outside the requested period', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-08-31.md', '- [x] 彻底完成 CS336 Assignment 1。'],
    ['diary/2025-01-01.md', '已完成不在本期的旧任务。'],
  ]), {
    documentMetadata: () => ({ mtimeMs: Date.parse('1999-01-01T00:00:00Z') }),
  });
  assert.equal(result.coverage.candidateRecords, 1);
  assert.match(result.answer, /完成／已学习[\s\S]*2026-08-31/u);
  assert.doesNotMatch(result.answer, /1999|不在本期的旧任务/u);
});

test('the fixed candidate inventory cannot bypass the original 40 read/search-call gate', async () => {
  const files = new Map(Array.from({ length: 45 }, (_, index) => [
    `diary/2026-08-${String(index % 20 + 10).padStart(2, '0')}-${String(index).padStart(2, '0')}.md`,
    `已完成第 ${index + 1} 项学习。`,
  ]));
  const result = await runFixture(files);
  assert.equal(result.coverage.candidateRecords, 45);
  assert.equal(result.coverage.readSearchCalls, 40);
  assert.equal(result.coverage.completeRecords, 39);
  assert.equal(result.coverage.partialRecords, 0);
  assert.equal(result.coverage.failedRecords, 0);
  assert.equal(result.coverage.budgetUncoveredRecords, 6);
  assert.equal(
    result.coverage.completeRecords + result.coverage.partialRecords +
      result.coverage.failedRecords + result.coverage.budgetUncoveredRecords,
    result.coverage.candidateRecords,
  );
});

test('a merged or omitted model fact cannot erase a checked completion or promote a neighboring plan', async () => {
  for (const omit of [true, false]) {
    const result = await runFixture(new Map([
      ['plans/2026-08-25.md', '- [ ] 完成 Orion 作业一'],
      ['plans/2026-08-31.md', '- [x] 结束 Orion 作业一\n- [ ] 开始 Orion 作业二'],
    ]), { extraction: (input) => omit ? [] : [{
      topic: 'Orion', statement: '多次计划作业一，后来记录勾选。', status: 'planned',
      evidence: input.segments.flatMap((segment) => segment.text.split('\n').map((line, offset) => ({
        segmentId: segment.id, lineStart: segment.lineStart + offset, lineEnd: segment.lineStart + offset,
      }))),
    }] });
    assert.match(result.answer, /完成／已学习\*\* · 结束 Orion 作业一\n\n  证据：2026-08-31/u);
    assert.doesNotMatch(result.answer, /完成／已学习\*\* · 开始 Orion 作业二/u);
    assert.equal(result.coverage.modelTurns, 0, 'local receipt adds no fixture model sequence');
  }
});

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

test('a relevant activity checklist retains omitted unchecked tasks without importing an unrelated checklist', async () => {
  const result = await runFixture(new Map([
    ['plans/2026-08-31.md', '- [ ] 完成样本集的同步\n- [ ] 复习 Orion 模型'],
    ['plans/2026-09-01.md', '- [ ] 购买家居用品'],
  ]), { extraction: (input) => input.segments.filter((segment) => segment.path.endsWith('2026-08-31.md')).map((segment) => ({
    topic: 'Orion', statement: '计划复习 Orion 模型', status: 'planned',
    evidence: [{ segmentId: segment.id, lineStart: 2, lineEnd: 2 }],
  })) });
  assert.match(result.answer, /计划\*\* · 计划：完成样本集的同步/u);
  assert.doesNotMatch(result.answer, /完成／已学习\*\* · .*样本集/u);
  assert.doesNotMatch(result.answer, /购买家居用品/u);
});

test('a diary status snapshot is not asserted to have entirely completed within the review period', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-08-31.md', '目前我已经完成的部分：已完成 Orion 数据流程。'],
  ]));
  assert.match(result.answer, /截至记录日的阶段状态（实际完成日期未注明，不认定全部在本期产生）/u);
});

test('compact note evidence inherits the server-owned event without asking Pi to copy its identity', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-09-05.md', '计划阅读 CUDA。[[notes/kernel]]'],
    ['notes/kernel.md', '线程块共享内存说明。'],
  ]), { supplement: (input) => {
    const note = input.segments.find((segment) => segment.dateBasis === 'related');
    return [{ statement: '共享内存用于块内线程协作。', noteEvidence: [{
      segmentId: note.id, path: note.path, lineStart: note.lineStart, lineEnd: note.lineStart,
    }] }];
  } });
  assert.equal(result.coverage.rejectedFacts, 0);
  assert.equal(result.coverage.supplementalComplete, 1);
  assert.match(result.answer, /共享内存用于块内线程协作/u);
  assert.match(result.answer, /计划[\s\S]*2026-09-05/u);
});

test('compact note evidence cannot replace the fixed parent or cite only activity lines', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-09-05.md', '计划阅读 CUDA。[[notes/kernel]]'],
    ['notes/kernel.md', '线程块共享内存说明。'],
  ]), { supplement: (input) => {
    const anchor = input.segments.find((segment) => segment.dateBasis !== 'related');
    const note = input.segments.find((segment) => segment.dateBasis === 'related');
    return [
      { parentFactId: 'forged', statement: '错误父事件', noteEvidence: [{ segmentId: note.id, lineStart: note.lineStart, lineEnd: note.lineStart }] },
      { statement: '没有知识笔记', noteEvidence: [{ segmentId: anchor.id, lineStart: anchor.lineStart, lineEnd: anchor.lineEnd }] },
    ];
  } });
  assert.equal(result.coverage.rejectedFacts, 2);
  assert.doesNotMatch(result.answer, /错误父事件|没有知识笔记/u);
});

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
  assert.match(result.answer, /## 四、关联资料说明[\s\S]*CUDA：共享内存新练习说明/u);
  assert.equal(result.answer.split('共享内存新练习说明').length - 1, 1, 'knowledge explanation is not duplicated inline');
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
  assert.match(result.answer, /计划[\s\S]*2026-09-05/u);
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
  assert.ok(result.coverage.batches <= 49);
  assert.ok(result.coverage.characters <= 49 * 512);
  assert.equal(result.coverage.supplementalComplete, 1);
  assert.equal(result.coverage.supplementalPartial, 0);
});

test('the original 24-minute retrieval window is not shortened by reserving a full 10-minute request', async (t) => {
  let clock = NOW;
  t.mock.method(Date, 'now', () => clock);
  const result = await runFixture(new Map([
    ['diary/2026-09-05.md', '已完成 Orion。[[notes/kernel]]'],
    ['notes/kernel.md', '内核知识说明。'],
  ]), {
    budgetAvailable: (reserve = 0) => clock + reserve < NOW + 30 * 60_000,
    extraction: (input) => {
      clock = NOW + 21 * 60_000;
      return [{ topic: 'Orion', statement: '已完成 Orion。', status: 'completed', evidence: [{
        segmentId: input.segments[0].id, lineStart: 1, lineEnd: 1,
      }] }];
    },
  });
  assert.equal(result.coverage.supplementalComplete, 1, 'minute 21 still belongs to retrieval');
  assert.equal(result.callOptions[0].timeoutMs, 600_000);
  assert.equal(result.callOptions[1].timeoutMs, 3 * 60_000, 'remaining retrieval time caps this request');
  assert.ok(result.callOptions.every((options) => options.timeoutMs <= 600_000));
});

test('no new extraction starts at the 24-minute retrieval deadline', async (t) => {
  let clock = NOW;
  t.mock.method(Date, 'now', () => clock);
  const result = await runFixture(new Map([
    ['diary/2026-09-05.md', '已完成 Orion。[[notes/kernel]]'],
    ['notes/kernel.md', '内核知识说明。'],
  ]), {
    budgetAvailable: (reserve = 0) => clock + reserve < NOW + 30 * 60_000,
    extraction: (input) => {
      clock = NOW + 24 * 60_000;
      return [{ topic: 'Orion', statement: '已完成 Orion。', status: 'completed', evidence: [{
        segmentId: input.segments[0].id, lineStart: 1, lineEnd: 1,
      }] }];
    },
  });
  assert.equal(result.inputs.length, 1);
  assert.equal(result.coverage.supplementalComplete, 0);
  assert.equal(result.coverage.supplementalUncovered, 1);
});

test('global 960000-character budget includes repeated primary evidence for supplementary batches', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-09-05.md', '已完成 CUDA。[[notes/kernel]]'],
    ['notes/kernel.md', '合成说明'.repeat(260_000)],
  ]), { supplement: () => [] });
  assert.ok(result.coverage.characters <= 960_000);
  assert.ok(result.coverage.batches <= 49);
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

test('a long related note cannot starve the first page of another learning direction', async () => {
  const result = await runFixture(new Map([
    ['diary/2026-09-05.md', '已完成 CUDA。[[notes/long]]\n已完成 CS336。[[notes/short]]'],
    ['notes/long.md', ('内核背景说明。\n').repeat(500)],
    ['notes/short.md', '优化器说明。'],
  ]), { maxContextChars: 512, supplement: () => [] });
  const pages = result.inputs.filter((input) => input.relatedFacts.length)
    .map((input) => input.segments.find((segment) => segment.dateBasis === 'related').path);
  assert.deepEqual(new Set(pages.slice(0, 2)), new Set(['notes/long.md', 'notes/short.md']));
  assert.equal(result.coverage.supplementalComplete, 2);
});

test('scarce note reads are balanced across topic searches and exclude out-of-period activity plans', async () => {
  const files = new Map(Array.from({ length: 32 }, (_, index) => [
    `diary/2026-08-${String(index % 20 + 7).padStart(2, '0')}-${index}.md`, '已完成课程练习。',
  ]));
  const topics = ['代数', '编译', '数据库'];
  for (const topic of topics) for (let page = 0; page < 6; page += 1) {
    files.set(`notes/${topic}-${page}.md`, `${topic}知识说明。`);
  }
  files.set('plans/2026-01-01.md', '期外的课程计划。');
  const result = await runFixture(files, {
    extraction: (input) => topics.map((topic) => ({
      topic, statement: '已完成课程练习。', status: 'completed', evidence: [{
        segmentId: input.segments[0].id, lineStart: input.segments[0].lineStart,
        lineEnd: input.segments[0].lineStart, quote: '已完成课程练习。',
      }],
    })),
    search: async (topic) => ({ results: [
      { path: 'plans/2026-01-01.md' },
      ...Array.from({ length: 6 }, (_, page) => ({ path: `notes/${topic}-${page}.md` })),
    ] }),
  });
  const notes = result.inputs.filter((input) => input.relatedFacts.length)
    .map((input) => input.segments.find((segment) => segment.dateBasis === 'related').path);
  assert.equal(result.coverage.readSearchCalls, 40);
  assert.equal(notes.length, 4);
  assert.deepEqual(new Set(notes.slice(0, 3)), new Set(topics.map((topic) => `notes/${topic}-0.md`)));
  assert.ok(notes.every((path) => path.startsWith('notes/')));
});

test('older named subjects and title-only notes precede noisy recent-topic search results', async () => {
  const files = new Map([
    ['diary/2026-08-10.md', '已完成 Mercator 地图投影。\n已完成 岩相显微分析。'],
    ['notes/Mercator/操作手册.md', '# Mercator 地图投影\n投影知识说明。'],
    ['notes/实验手册.md', '# 岩相显微分析\n薄片知识说明。'],
    ['plans/2026-01-01.md', '已完成 Mercator。'],
    ['notes/Orion/原理.md', '# Orion 编译器\n编译知识说明。'],
    ['notes/泛化系统综述.md', '无关系统综述。'],
  ]);
  for (let day = 20; day <= 31; day += 1) {
    files.set(`diary/2026-08-${day}.md`, `已完成 Orion 第${day}次编译实验。`);
  }
  let searches = 0;
  const result = await runFixture(files, {
    extraction: (input) => input.segments.flatMap((segment) => segment.text.split('\n').map((line, offset) => ({
      topic: line, statement: line, status: 'completed', evidence: [{
        segmentId: segment.id, lineStart: segment.lineStart + offset, lineEnd: segment.lineStart + offset,
      }],
    }))),
    search: async () => {
      searches += 1;
      return { results: [{ path: 'notes/泛化系统综述.md' }, { path: 'plans/2026-01-01.md' }] };
    },
  });
  const notes = result.inputs.filter((input) => input.relatedFacts.length)
    .map((input) => input.segments.find((segment) => segment.dateBasis === 'related').path);
  assert.equal(searches, 8, 'retain the bounded query ceiling');
  assert.deepEqual(new Set(notes.slice(0, 3)), new Set([
    'notes/Orion/原理.md', 'notes/Mercator/操作手册.md', 'notes/实验手册.md',
  ]), 'all-period names and titles must beat semantic distractors, regardless of recency');
  assert.equal(notes.filter((name) => name === 'notes/Orion/原理.md').length, 1);
  assert.ok(notes.every((name) => !name.startsWith('plans/')));
  assert.ok(result.coverage.readSearchCalls <= 40);
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
  assert.match(result.answer, /计划[\s\S]*2026-09-05/u);
  assert.match(result.answer, /## 四、关联资料说明[\s\S]*CUDA：线程块共享内存说明/u);
  assert.match(result.answer, /三、时间归属未确认的资料[\s\S]*notes\/2026-09-04\.md/u);
  assert.equal(result.coverage.locallyExcludedSegments, 1);
  assert.ok(result.inputs.filter((input) => !input.relatedFacts.length).every((input) =>
    input.segments.every((segment) => segment.recordType !== 'note')));
});

test('request-inferred years stay in the local coverage ledger without wasting model turns', async () => {
  const result = await runFixture(new Map([
    ['weekly.md', '# 08-25–08-30\n计划阅读内核文档。'],
    ['diary/2026-08-31.md', '已完成课程练习。'],
  ]));
  assert.equal(result.coverage.candidateRecords, 2);
  assert.equal(result.coverage.completeRecords, 2);
  assert.equal(result.coverage.locallyExcludedSegments, 1);
  assert.ok(result.inputs.every((input) => input.segments.every((segment) => segment.path !== 'weekly.md')));
  assert.match(result.answer, /无明确年份/u);
  assert.match(result.answer, /年份未确认的计划片段[\s\S]*08-25–08-30[\s\S]*计划阅读内核文档/u);
  assert.doesNotMatch(result.answer.split('## 三、')[0], /计划阅读内核文档/u);
});
