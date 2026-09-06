import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveLearningReviewRequest, normalizeLearningReview, learningReviewSegments,
  buildLearningReviewBatches, validateLearningReviewFacts,
} from '../src/learning-review.mjs';

const NOW = Date.parse('2026-09-06T03:00:00+08:00');
const options = { now: NOW, timeZone: 'Asia/Shanghai' };
const review = resolveLearningReviewRequest('总结最近一个月的学习重点', options);

test('implicit personal review resolves a calendar month without a model clarification', () => {
  assert.equal(review.kind, 'personal_learning_review');
  assert.equal(review.range.startLocal, '2026-08-06 00:00:00');
  assert.equal(review.range.endLocal, '2026-09-06 03:00:00');
  assert.equal(review.range.endExclusive, new Date(NOW + 1).toISOString());
  for (const question of ['总结我最近一个月的学习重点', '回顾本月学习内容', '总结上个月学习情况']) {
    assert.ok(resolveLearningReviewRequest(question, options), question);
  }
  const march = resolveLearningReviewRequest('总结最近一个月的学习重点', {
    ...options, now: Date.parse('2026-03-31T12:00:00+08:00'),
  });
  assert.equal(march.range.startLocal, '2026-02-28 00:00:00');
});

test('all-scope follow-ups preserve the captured window across refreshes', () => {
  for (const question of ['所有', '所有的', '全部', '全部方向']) {
    assert.deepEqual(resolveLearningReviewRequest(question, { ...options, now: NOW + 20 * 86_400_000, previousReview: review }), review);
    assert.deepEqual(resolveLearningReviewRequest(question, {
      ...options, history: [{ role: 'user', content: review.originalQuestion, at: new Date(NOW).toISOString() },
        { role: 'assistant', content: '您想总结哪个学科？' }, { role: 'user', content: '所有' }],
    }), review);
  }
  assert.equal(resolveLearningReviewRequest('所有', {
    ...options, history: [{ role: 'user', content: review.originalQuestion }, { role: 'user', content: '苹果的颜色是什么' }],
  }), null);
  assert.equal(normalizeLearningReview({ ...review, range: { ...review.range, timeZone: 'Not/AZone' } }), null);
});

test('public research, external subjects and file inventories keep their own routes', () => {
  for (const question of [
    '总结最近一个月人工智能研究进展', '最近两周学生学习了哪些内容',
    '总结最近一个月机器学习进展', '总结最近一个月深度学习的最新进展',
    '帮我总结最近一个月机器学习进展',
    '总结这个模型最近一个月的学习进展', '我想知道最近一个月人工智能研究进展',
    '最近一个月修改了哪些文件', 'RC-Flow 的原理是什么', '所有',
    '总结我最近一个月更新的学习笔记',
  ]) assert.equal(resolveLearningReviewRequest(question, options), null, question);
});

test('month/day dates honor explicit document years and cannot borrow this year in generic notes', () => {
  assert.deepEqual(learningReviewSegments('notes.md', '# 09-05\n已读旧论文。', review), []);
  assert.deepEqual(learningReviewSegments('daily_doc/周计划/计划.md', '---\nyear: 2025\n---\n# 09-05\n已读旧论文。', review), []);
  assert.deepEqual(learningReviewSegments('notes.md', 'year: 2025\n# 09-05\n已读旧论文。', review), []);
  const explicit = learningReviewSegments('notes.md', '# 2026年学习记录\n## 9月5日\n已读 CUDA 文档。', review);
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0].eventDate, '2026-09-05');
  assert.equal(explicit[0].yearBasis, 'explicit');
  assert.equal(explicit[0].recordType, 'activity');
  const inferred = learningReviewSegments('daily_doc/周计划/计划.md', '# 08-25–08-30\n计划学习 CUDA。', review);
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].yearBasis, 'request_window');
  assert.ok(resolveLearningReviewRequest('总结我最近一个月机器学习课程的学习进展', options));
  assert.ok(resolveLearningReviewRequest('总结最近一个月的学习重点', options));
});

test('daily records use actual date names, preserve all lines and ignore old/future records', () => {
  const text = '# 学习记录\n\n- [x] 已完成 CUDA 入门\n- [ ] 计划学习新课程\n最后一行是 [[notes/kernel.md]]。';
  const segments = learningReviewSegments('daily_doc/日记/2026-08-6.md', text, review);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, text);
  assert.equal(segments[0].lineEnd, 5);
  assert.equal(segments[0].eventDate, '2026-08-06');
  assert.equal(segments[0].recordType, 'diary');
  assert.deepEqual(segments[0].references, ['notes/kernel.md']);
  assert.deepEqual(learningReviewSegments('daily_doc/日记/2026-08-5.md', text, review), []);
  assert.deepEqual(learningReviewSegments('daily_doc/日记/2026-09-7.md', text, review), []);
  assert.deepEqual(learningReviewSegments('notes/old-rc-flow.md', '旧笔记今天被重新整理。', review), []);
});

test('weekly headings and date columns select the intersecting period without interpreting fractions', () => {
  const text = [
    '# 周计划', '## 第一阶段 08-03–08-07', '| 日期 | 任务 |', '| --- | --- |',
    '| 08-05 | 窗口前的任务 |', '| 08-06 | 计划学习 CUDA |',
    '| 08-07 | 比例 2/3，阅读第 6-35 页 |', '',
    '## 第二阶段 08-25–08-30', '计划复习 CS336。',
    '## 第三阶段 09-07–09-13', '未来的任务。',
  ].join('\n');
  const segments = learningReviewSegments('daily_doc/周计划/学习计划.md', text, review);
  assert.ok(segments.some((segment) => segment.eventDate === '2026-08-06' && segment.text.includes('CUDA')));
  assert.ok(segments.some((segment) => segment.dateRange.start === '2026-08-25' && segment.text.includes('CS336')));
  assert.ok(!segments.some((segment) => segment.text.includes('窗口前的任务') || segment.text.includes('未来的任务')));
  assert.ok(segments.filter((segment) => segment.dateBasis === 'table').every((segment) => segment.context.includes('日期')));
  assert.equal(learningReviewSegments('notes/ratios.md', '# 1/2\n比例\n# 6-35 页\n页码', review).length, 0);
});

test('bold week section dates override broader project headings and exclude future bodies', () => {
  const text = '# 主项目 08-31–11-01\n**W1（08-31–09-06）** 当前阶段\n计划复习 CUDA。\n**W2（09-07–09-13）**\n未来课程计划。';
  const segments = learningReviewSegments('weekly.md', text, review);
  assert.ok(segments.some((segment) => segment.text.includes('计划复习 CUDA') && segment.recordDateRange.end === '2026-09-06'));
  assert.ok(!segments.some((segment) => segment.text.includes('未来课程计划')));
});

test('code examples cannot change the enclosing event date and ambiguous years are not invented', () => {
  const text = '# 2026-08-25\n当天内容\n```md\n# 2020-01-01\n```\n继续当天内容';
  assert.ok(learningReviewSegments('notes/log.md', text, review).every((segment) => segment.eventDate === '2026-08-25'));
  const newYear = resolveLearningReviewRequest('总结最近一个月的学习重点', {
    ...options, now: Date.parse('2027-01-06T03:00:00+08:00'),
  });
  assert.deepEqual(learningReviewSegments('weekly.md', '# 12-25\n年份不明', newYear), []);
});

test('batching reads the end of long records and reports budget truncation', () => {
  const text = Array.from({ length: 60 }, (_, index) => `第${index + 1}行 ${'知识'.repeat(30)}`).join('\n');
  const segments = learningReviewSegments('daily/2026-08-25.md', text, review);
  const result = buildLearningReviewBatches(segments, { maxBatchChars: 500 });
  const pieces = result.batches.flatMap((batch) => batch.segments);
  assert.ok(pieces.some((segment) => segment.text.includes('第60行')));
  assert.equal(pieces[0].lineStart, 1);
  assert.equal(pieces.at(-1).lineEnd, 60);
  assert.ok(result.batches.every((batch) => batch.characters <= 500));
  assert.equal(result.coverage.truncated, false);
  const truncated = buildLearningReviewBatches(segments, { maxBatchChars: 500, maxBatches: 1 });
  assert.equal(truncated.coverage.truncated, true);
  assert.ok(truncated.coverage.omittedSegments > 0);
});

function proposedFact(segment, overrides = {}) {
  return { topic: 'CUDA', statement: '学习 CUDA 基础', status: 'completed',
    evidence: [{ segmentId: segment.id, path: segment.path,
      lineStart: segment.lineStart, lineEnd: segment.lineEnd, quote: segment.text }], ...overrides };
}

test('dated reference notes cannot independently establish the owner learned their contents', () => {
  for (const [path, text] of [
    ['notes/2026-08-30.md', '作者经历：我已完成课程，之后继续推进求职。'],
    ['notes/agent.md', '# 2026-08-30\n术语解释：Agent 包含工具和记忆系统。'],
    ['notes/2026-08-30.md', '# 如何写学习记录\n作者复习过 CUDA。'],
  ]) {
    const [segment] = learningReviewSegments(path, text, review);
    assert.equal(segment.recordType, 'note');
    for (const status of ['completed', 'in_progress', 'planned', 'unconfirmed']) {
      const result = validateLearningReviewFacts({ facts: [proposedFact(segment, { status })] }, [segment], review);
      assert.equal(result.facts.length, 0);
      assert.equal(result.rejectedCount, 1);
    }
  }
});

test('explicit learning activity sections qualify without promoting neighboring reference sections', () => {
  for (const label of ['学习记录', '复习记录', '实践记录', '阅读记录', '学习日志']) {
    const text = `# 2026-09-05\n## ${label}\n已读 CUDA 文档。\n## 参考资料\n作者已完成一个月课程。`;
    const segments = learningReviewSegments('notes.md', text, review);
    const activity = segments.find((segment) => segment.recordType === 'activity');
    assert.equal(activity.eventDate, '2026-09-05');
    assert.ok(activity.text.includes('已读 CUDA 文档。'));
    assert.ok(!activity.text.includes('作者'));
    assert.equal(validateLearningReviewFacts({ facts: [proposedFact(activity)] }, segments, review).facts[0].status, 'completed');
    const reference = segments.find((segment) => segment.text.includes('作者'));
    assert.equal(reference.recordType, 'note');
    assert.equal(validateLearningReviewFacts({ facts: [proposedFact(reference)] }, segments, review).facts.length, 0);
    const [fileRecord] = learningReviewSegments(`${label}/2026-09-05.md`, '已读 CUDA 文档。', review);
    assert.equal(fileRecord.recordType, 'activity');
  }
  const [generic] = learningReviewSegments('notes.md', '# 2026年学习记录\n## 9月5日\n已读 CUDA 文档。', review);
  assert.equal(validateLearningReviewFacts({ facts: [proposedFact(generic)] }, [generic], review).facts[0].status, 'completed');
  const bold = learningReviewSegments('notes/2026-09-05.md', '**阅读记录**\n已读 CUDA 文档。\n**参考资料**\n作者已读其他课程。', review);
  assert.equal(bold[0].recordType, 'activity');
  assert.equal(bold[1].recordType, 'note');
});

test('ordinary notes support anchored learning details without lending their dates or completion', () => {
  const [anchor] = learningReviewSegments('plans/2026-09-05.md', '- [ ] 计划阅读 CUDA 线程块文档。', review);
  const [reference] = learningReviewSegments('notes/2026-08-30.md', '作者已完成 CUDA 学习：线程块包含多个线程。', review);
  const fact = proposedFact(anchor, { statement: '计划阅读 CUDA 线程块文档，涉及线程组织。' });
  fact.evidence.push({ segmentId: reference.id, quote: reference.text });
  const result = validateLearningReviewFacts({ facts: [fact] }, [anchor, reference], review);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].status, 'planned');
  assert.equal(result.facts[0].eventDate, '2026-09-05');
  assert.equal(result.facts[0].evidence.length, 2);
});

test('facts require exact source quotes/lines and dates; completion cannot be manufactured', () => {
  const [planned] = learningReviewSegments('plans/2026-08-25.md', '- [ ] 计划学习 CUDA', review);
  const result = validateLearningReviewFacts({ facts: [proposedFact(planned)] }, { segments: [planned] }, review);
  assert.equal(result.facts[0].status, 'planned');
  assert.equal(result.facts[0].eventDate, '2026-08-25');
  const [completed] = learningReviewSegments('diary/2026-08-25.md', '- [x] 已完成 CUDA 入门', review);
  assert.equal(validateLearningReviewFacts({ facts: [proposedFact(completed)] }, [completed], review).facts[0].status, 'completed');
  const forged = [
    proposedFact(planned, { eventDate: '2026-08-26' }),
    proposedFact(planned, { evidence: [{ segmentId: planned.id, quote: '根本不存在的句子' }] }),
    proposedFact(planned, { evidence: [{ segmentId: planned.id, path: 'other.md', quote: planned.text }] }),
  ];
  const rejected = validateLearningReviewFacts({ facts: forged }, [planned], review);
  assert.equal(rejected.facts.length, 0);
  assert.equal(rejected.rejectedCount, 3);
});

test('unique verbatim quotes repair model line numbers but duplicate or forged quotes cannot', () => {
  const [segment] = learningReviewSegments('diary/2026-09-05.md',
    '# 学习记录\n- [ ] 彻底完成 CUDA 练习。\n当天阅读记录。\n重复句。\n重复句。', review);
  const fact = proposedFact(segment, { statement: 'CUDA 练习',
    evidence: [{ segmentId: segment.id, path: segment.path, lineStart: 80, lineEnd: 88, quote: '彻底完成 CUDA 练习。' }] });
  const result = validateLearningReviewFacts({ facts: [fact] }, [segment], review);
  assert.equal(result.facts[0].status, 'planned');
  assert.equal(result.facts[0].evidence[0].lineStart, 2);
  assert.equal(result.facts[0].evidence[0].lineEnd, 2);
  const multiline = { ...fact, status: 'unconfirmed', evidence: [{ segmentId: segment.id,
    lineStart: 90, lineEnd: 99, quote: '彻底完成 CUDA 练习。\n当天阅读记录。' }] };
  assert.equal(validateLearningReviewFacts({ facts: [multiline] }, [segment], review).facts[0].evidence[0].lineEnd, 3);
  for (const quote of ['重复句。', '不存在的内容。']) {
    const invalid = { ...fact, evidence: [{ segmentId: segment.id, lineStart: 80, lineEnd: 88, quote }] };
    assert.equal(validateLearningReviewFacts({ facts: [invalid] }, [segment], review).facts.length, 0);
  }
  const [old] = learningReviewSegments('diary/2026-09-05.md', '2026-08-03 已完成旧论文阅读。', review);
  const outdated = proposedFact(old, { evidence: [{ segmentId: old.id, lineStart: 99, lineEnd: 99, quote: '已完成旧论文阅读。' }] });
  assert.equal(validateLearningReviewFacts({ facts: [outdated] }, [old], review).facts.length, 0);
});

test('retrospective old dates and related-only sources cannot manufacture in-window activity', () => {
  const [retrospective] = learningReviewSegments('diary/2026-08-25.md', '2026-07-01 已完成旧论文学习。', review);
  assert.equal(validateLearningReviewFacts({ facts: [proposedFact(retrospective)] }, [retrospective], review).facts.length, 0);
  const related = { id: 'related-1', path: 'notes/kernel.md', lineStart: 1, lineEnd: 1,
    text: 'GPU 线程组成线程块。', dateBasis: 'related', dateRange: null, recordType: 'note' };
  assert.equal(validateLearningReviewFacts({ facts: [proposedFact(related)] }, [related], review).facts.length, 0);
  const [primary] = learningReviewSegments('diary/2026-08-25.md', '已完成 CUDA 线程块学习。', review);
  const fact = proposedFact(primary);
  fact.evidence.push({ segmentId: related.id, quote: related.text });
  const validated = validateLearningReviewFacts({ facts: [fact] }, [primary, related], review).facts[0];
  assert.equal(validated.eventDate, '2026-08-25');
  assert.equal(validated.evidence.length, 2);
});

test('selective quotes cannot hide an old event date or make a planned statement completed', () => {
  for (const text of ['2026-08-03 已完成 RC-flow 阅读。', '08-03 已完成 RC-flow 阅读。']) {
    const [primary] = learningReviewSegments('diary/2026-09-05.md', text, review);
    const fact = proposedFact(primary);
    fact.evidence[0].quote = '已完成 RC-flow 阅读';
    assert.equal(validateLearningReviewFacts({ facts: [fact] }, [primary], review).facts.length, 0);
  }
  const [planned] = learningReviewSegments('plans/2026-08-25.md', '计划学习 CUDA。', review);
  assert.equal(validateLearningReviewFacts({ facts: [proposedFact(planned, { statement: '已完成 CUDA 学习' })] }, [planned], review).facts.length, 0);
  const [read] = learningReviewSegments('diary/2026-08-25.md', '已读 CUDA 文档，复习过线程调度。', review);
  assert.equal(validateLearningReviewFacts({ facts: [proposedFact(read)] }, [read], review).facts[0].status, 'completed');
});

test('unchecked and proposed completion remain plans even with selective quotations', () => {
  for (const text of [
    '- [ ] 彻底完成 assignment_1', '计划彻底完成 assignment_1',
    '- [ ] 今日任务\n  彻底完成 assignment_1',
  ]) {
    const [segment] = learningReviewSegments('plans/2026-08-25.md', text, review);
    const fact = proposedFact(segment, { statement: 'assignment_1 学习' });
    fact.evidence[0].quote = '彻底完成 assignment_1';
    if (text.includes('\n')) fact.evidence[0].lineStart = 2;
    assert.equal(validateLearningReviewFacts({ facts: [fact] }, [segment], review).facts[0].status, 'planned', text);
  }
});

test('negated prior learning, checked plans and completion paraphrases keep honest statuses', () => {
  for (const text of ['尚未读过 CUDA 文档。', '没有复习过 CUDA 文档。', '还没学过 CUDA。']) {
    const [segment] = learningReviewSegments('diary/2026-09-05.md', text, review);
    assert.equal(validateLearningReviewFacts({ facts: [proposedFact(segment)] }, [segment], review).facts[0].status, 'unconfirmed');
  }
  const [checked] = learningReviewSegments('plans/2026-09-05.md', '- [x] 计划学习 CUDA 基础。', review);
  assert.equal(validateLearningReviewFacts({ facts: [proposedFact(checked)] }, [checked], review).facts[0].status, 'completed');
  const [unchecked] = learningReviewSegments('plans/2026-09-05.md', '- [ ] 彻底完成 CUDA 基础。', review);
  assert.equal(validateLearningReviewFacts({ facts: [proposedFact(unchecked, { statement: '已经完成 CUDA 基础' })] }, [unchecked], review).facts.length, 0);
});

test('plans or missing deliverables cannot establish non-completion, while uncertainty remains expressible', () => {
  for (const text of ['- [ ] 计划学习 CUDA。', '本次没有找到 CUDA 学习产出记录。']) {
    const [segment] = learningReviewSegments('plans/2026-09-05.md', text, review);
    for (const statement of ['没有完成 CUDA 学习', 'CUDA 尚未完成', 'CUDA 还没有完全完成']) {
      assert.equal(validateLearningReviewFacts({ facts: [proposedFact(segment, { statement, status: 'unconfirmed' })] }, [segment], review).facts.length, 0);
    }
    const uncertain = validateLearningReviewFacts({ facts: [proposedFact(segment, { statement: 'CUDA 完成情况未确认', status: 'unconfirmed' })] }, [segment], review);
    assert.equal(uncertain.facts.length, 1);
    assert.equal(uncertain.facts[0].status, 'unconfirmed');
  }
  const [negative] = learningReviewSegments('diary/2026-09-05.md', 'CUDA 练习尚未完成。', review);
  const recorded = validateLearningReviewFacts({ facts: [proposedFact(negative, { statement: 'CUDA 练习尚未完成', status: 'unconfirmed' })] }, [negative], review);
  assert.equal(recorded.facts.length, 1);
});

test('all explicit event dates are checked, while page ranges and linked-note dates are not event dates', () => {
  for (const text of ['2026-08-25 学习 CUDA；2026-08-03 已完成 RC-flow 阅读。', '08-25 学习 CUDA；08-03 已完成 RC-flow 阅读。']) {
    const [segment] = learningReviewSegments('diary/2026-09-05.md', text, review);
    const fact = proposedFact(segment, { evidence: [{ segmentId: segment.id, lineStart: 1, lineEnd: 1, quote: '已完成 RC-flow 阅读。' }] });
    assert.equal(validateLearningReviewFacts({ facts: [fact] }, [segment], review).facts.length, 0);
  }
  for (const text of ['今天已读 CUDA 文档第 5-15 页。', '已读旧笔记 [[notes/2026-07-01.md]]。', '已读 [旧笔记](notes/2026-07-01.md)。']) {
    const [segment] = learningReviewSegments('diary/2026-09-05.md', text, review);
    const result = validateLearningReviewFacts({ facts: [proposedFact(segment)] }, [segment], review);
    assert.equal(result.facts[0].eventDate, '2026-09-05');
    assert.equal(result.facts[0].status, 'completed');
  }
});

test('overlapping week ranges retain original bounds and cannot date undated work inside the window', () => {
  const segments = learningReviewSegments('weekly.md', '# 2026-08-03–08-09\n已完成论文阅读。', review);
  assert.deepEqual(segments[0].recordDateRange, { start: '2026-08-03', end: '2026-08-09' });
  const fact = proposedFact(segments[0]);
  fact.evidence[0].lineStart = 2;
  fact.evidence[0].quote = '已完成论文阅读。';
  const result = validateLearningReviewFacts({ facts: [fact] }, segments, review);
  assert.equal(result.facts.length, 0);
  assert.equal(result.temporalUncertainCount, 1);
  const explicit = learningReviewSegments('weekly.md', '# 2026-08-03–08-09\n08-07 已完成论文阅读。', review);
  const datedFact = proposedFact(explicit[0]);
  datedFact.evidence[0].lineStart = 2;
  datedFact.evidence[0].quote = '已完成论文阅读。';
  assert.equal(validateLearningReviewFacts({ facts: [datedFact] }, explicit, review).facts[0].eventDate, '2026-08-07');
});


test('fact overflow is reported as rejected evidence instead of silently claiming complete verification', () => {
  const segments = learningReviewSegments('diary/2026-09-05.md', '已完成 CUDA 练习。', review);
  const segment = segments[0];
  const facts = Array.from({ length: 106 }, (_, index) => ({
    topic: `CUDA ${index}`, statement: '已完成 CUDA 练习。', status: 'completed',
    evidence: [{ segmentId: segment.id, path: segment.path, lineStart: 1, lineEnd: 1, quote: segment.text }],
  }));
  const result = validateLearningReviewFacts({ facts }, { segments }, review);
  assert.equal(result.facts.length, 100);
  assert.equal(result.rejectedCount, 6);
});


test('a year inferred only from the request can discover candidates but cannot establish an event', () => {
  const segments = learningReviewSegments('weekly/计划.md', '# 09-05\n已完成 CUDA 练习。', review);
  const segment = segments[0];
  const proposal = { topic: 'CUDA', statement: '已完成 CUDA 练习。', status: 'completed',
    evidence: [{ segmentId: segment.id, path: segment.path, lineStart: 2, lineEnd: 2, quote: '已完成 CUDA 练习。' }] };
  const unresolved = validateLearningReviewFacts({ facts: [proposal] }, { segments }, review);
  assert.equal(unresolved.facts.length, 0);
  assert.equal(unresolved.temporalUncertainCount, 1);
  const dated = learningReviewSegments('weekly/计划.md', '# 09-05\n2026-09-05 已完成 CUDA 练习。', review);
  const verified = validateLearningReviewFacts({ facts: [{ ...proposal,
    evidence: [{ ...proposal.evidence[0], segmentId: dated[0].id, quote: '2026-09-05 已完成 CUDA 练习。' }],
  }] }, { segments: dated }, review);
  assert.equal(verified.facts.length, 1);
  assert.equal(verified.facts[0].eventDate, '2026-09-05');
});
