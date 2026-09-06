import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessmentSystemPrompt,
  assessmentUserPrompt,
  contextualizerSystemPrompt,
  conversationStateXml,
  deterministicStandaloneContext,
  evidenceMatchesEntity,
  filterVaultEvidence,
  finalizeWebCitations,
  guardResearchQueries,
  parseContextualizerOutput,
  parseEvidenceAssessment,
  researchContextForSave,
  researchQueriesEquivalent,
  retainCitedVerifiedClaims,
  selectWebEvidence,
  webAuthority,
} from '../src/research-pipeline.mjs';

function groundedState(overrides = {}) {
  return {
    standaloneQuestion: '甲州投控集团党委书记、董事长测试人物甲是什么行政级别',
    subject: { name: '测试人物甲', type: 'person', aliases: [] },
    requiredAnchors: ['甲州', '投控集团', '投资控股'],
    intent: { label: '行政级别', terms: ['市管干部', '任前公示'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
    ...overrides,
  };
}

function webCandidate({
  title,
  url,
  snippet,
  source = '',
  publishedAt = '',
  queryIndex = 0,
}) {
  return { title, url, snippet, source, publishedAt, queryIndex };
}

test('contextualizer accepts only the complete strict JSON contract', () => {
  const payload = groundedState({
    queries: [
      '甲州投控集团 测试人物甲 行政级别',
      '甲州组织部 测试人物甲 市管干部 任前公示',
    ],
  });
  const parsed = parseContextualizerOutput(JSON.stringify(payload), {
    question: '测试人物甲是什么级别',
    history: [{ role: 'user', content: '甲州投控集团董事长是谁' }],
    deep: true,
  });

  assert.equal(parsed.valid, true);
  assert.equal(parsed.fallbackReason, '');
  assert.deepEqual(parsed.state, payload);
  assert.match(contextualizerSystemPrompt({ deep: true }), /strict JSON object only/u);
  assert.match(contextualizerSystemPrompt({ deep: true }), /2-4 complementary bounded queries/u);

  const incomplete = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: payload.standaloneQuestion,
    subject: payload.subject,
  }), {
    question: '甲州投控集团董事长是谁',
    deep: false,
  });
  assert.equal(incomplete.valid, false);
  assert.equal(incomplete.fallbackReason, 'raw_question_fallback');
});

test('relative-time learning inventories are deterministically contextualized without model planning', () => {
  const state = deterministicStandaloneContext('这两周我都学习了哪些内容', {
    history: [],
    researchContext: null,
    deep: false,
  });
  assert.equal(state.standaloneQuestion, '这两周我都学习了哪些内容');
  assert.equal(state.intent.label, '按文件更新时间盘点学习内容');
  assert.equal(state.temporal.mode, 'historical');
  assert.equal(state.ambiguous, false);
  assert.deepEqual(state.queries, []);
});

test('a complete technical topic switch stays standalone even with prior conversation state', () => {
  const researchContext = {
    subject: { name: '', type: 'topic', aliases: [] },
    requiredAnchors: [],
    intent: { label: '推理显存计算', terms: ['KV Cache'] },
    temporal: { mode: 'unspecified', asOf: null },
    lastStandaloneQuestion: '告诉我推理的显存怎么计算',
  };
  const state = deterministicStandaloneContext('告诉我训练的显存怎么计算', {
    history: [
      { role: 'user', content: '告诉我推理的显存怎么计算' },
      { role: 'assistant', content: '推理显存由权重、KV Cache 和工作区组成。' },
    ],
    researchContext,
    deep: false,
  });

  assert.ok(state);
  assert.equal(state.ambiguous, false);
  assert.equal(state.standaloneQuestion, '告诉我训练的显存怎么计算');
  assert.equal(state.subject.type, 'topic');
  assert.deepEqual(state.requiredAnchors, []);
});

test('a persisted context-switch confirmation consumes yes without model planning', () => {
  const state = deterministicStandaloneContext('是的', {
    history: [],
    researchContext: {
      subject: { name: '测试人物甲', type: 'person', aliases: [] },
      requiredAnchors: ['甲州'],
      intent: { label: '现任职务', terms: ['任命'] },
      temporal: { mode: 'current', asOf: null },
      pendingClarification: {
        kind: 'context_switch',
        proposedState: {
          standaloneQuestion: '训练显存怎么计算',
          subject: { name: '', type: 'topic', aliases: [] },
          requiredAnchors: [],
          intent: { label: '', terms: [] },
          temporal: { mode: 'unspecified', asOf: null },
        },
      },
    },
    deep: false,
  });

  assert.ok(state);
  assert.equal(state.ambiguous, false);
  assert.equal(state.standaloneQuestion, '训练显存怎么计算');
  assert.equal(state.subject.type, 'topic');
});

test('a bare confirmation without pending state asks what is being confirmed', () => {
  const state = deterministicStandaloneContext('是的', {
    history: [], researchContext: null, deep: false,
  });
  assert.equal(state.ambiguous, true);
  assert.match(state.clarificationQuestion, /确认哪一项/u);
});

test('malformed contextualizer output deterministically restores entity, anchors, and intent from research context', () => {
  const researchContext = {
    subject: { name: '测试人物甲', type: 'person', aliases: [] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '现任职务', terms: ['董事长', '任命'] },
    temporal: { mode: 'current', asOf: null },
    lastStandaloneQuestion: '甲州投控集团董事长是谁',
  };
  const parsed = parseContextualizerOutput('{ definitely not JSON', {
    question: '测试人物甲是什么级别',
    history: [
      { role: 'user', content: '甲州投控集团董事长是谁' },
      { role: 'assistant', content: '董事长是测试人物甲。' },
    ],
    researchContext,
    deep: true,
  });

  assert.equal(parsed.valid, false);
  assert.equal(parsed.fallbackReason, 'deterministic_context_recovery');
  assert.equal(parsed.state.subject.name, '测试人物甲');
  assert.deepEqual(parsed.state.requiredAnchors, ['甲州', '投控集团']);
  assert.equal(parsed.state.intent.label, '行政级别');
  assert.ok(parsed.state.intent.terms.includes('市管干部'));
  assert.match(parsed.state.standaloneQuestion, /测试人物甲/u);
  assert.match(parsed.state.standaloneQuestion, /甲州|投控集团/u);

  const queries = guardResearchQueries(parsed.state, {
    deep: true,
    proposed: parsed.state.queries,
  });
  assert.ok(queries.length >= 2);
  assert.ok(queries.every((query) => /测试人物甲/u.test(query)));
  assert.ok(queries.every((query) => /甲州|投控集团/u.test(query)));
  assert.ok(queries.every((query) => /行政级别|市管干部|任前公示/u.test(query)));
});

test('a linked organization-to-person follow-up repairs valid JSON that drifts to a namesake', () => {
  const researchContext = {
    subject: { name: '甲州投控集团', type: 'organization', aliases: ['甲州投控集团'] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '现任职务', terms: ['董事长', '任命'] },
    temporal: { mode: 'current', asOf: null },
    lastStandaloneQuestion: '甲州投控集团董事长是谁',
    verifiedClaims: [{
      text: '公开材料显示甲州投控集团董事长为测试人物甲。',
      sourceIds: ['W1'],
      direct: true,
    }],
  };
  const history = [
    { role: 'user', content: '甲州投控集团董事长是谁' },
    { role: 'assistant', content: '甲州投控集团董事长为测试人物甲。' },
  ];
  const drifted = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '演员测试人物甲是什么行业级别',
    subject: { name: '测试人物甲', type: 'person', aliases: ['演员测试人物甲'] },
    requiredAnchors: ['演员'],
    intent: { label: '行业地位', terms: ['示例高级演员职称'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: ['演员测试人物甲 示例高级演员职称', '示例影视演员测试人物甲 职称'],
  }), {
    question: '测试人物甲是什么级别',
    history,
    researchContext,
    deep: true,
  });

  assert.equal(drifted.valid, false);
  assert.equal(drifted.fallbackReason, 'context_drift_repaired');
  assert.equal(drifted.state.subject.name, '测试人物甲');
  assert.equal(drifted.state.subject.type, 'person');
  assert.deepEqual(drifted.state.requiredAnchors, ['甲州', '投控集团']);
  assert.equal(drifted.state.intent.label, '行政级别');
  assert.match(drifted.state.standaloneQuestion, /测试人物甲/u);
  assert.match(drifted.state.standaloneQuestion, /甲州|投控集团/u);
  assert.deepEqual(drifted.state.queries, []);
  const guarded = guardResearchQueries(drifted.state, { deep: true });
  assert.ok(guarded.length >= 2);
  assert.ok(guarded.every((query) => /测试人物甲/u.test(query)));
  assert.ok(guarded.every((query) => /甲州|投控集团/u.test(query)));
  assert.ok(guarded.every((query) => !/演员|示例影视|示例理工|教授/u.test(query)));

  const grounded = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '甲州投控集团董事长测试人物甲是什么行政级别',
    subject: { name: '测试人物甲', type: 'person', aliases: [] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '行政级别', terms: ['市管干部', '任前公示'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [
      '甲州投控集团 测试人物甲 行政级别',
      '甲州组织部 测试人物甲 市管干部 任前公示',
    ],
  }), {
    question: '测试人物甲是什么级别',
    history,
    researchContext,
    deep: true,
  });
  assert.equal(grounded.valid, true, 'a correctly anchored organization-to-person transition remains valid');
  assert.equal(grounded.state.subject.name, '测试人物甲');
});

test('an explicit occupation switch does not inherit anchors from the prior entity', () => {
  const researchContext = {
    subject: { name: '甲州投控集团', type: 'organization', aliases: ['甲州投控集团'] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '现任职务', terms: ['董事长', '任命'] },
    temporal: { mode: 'current', asOf: null },
    lastStandaloneQuestion: '甲州投控集团董事长是谁',
    verifiedClaims: [{
      text: '公开材料显示甲州投控集团董事长为测试人物甲。',
      sourceIds: ['W1'],
      direct: true,
    }],
  };
  const history = [
    { role: 'user', content: '甲州投控集团董事长是谁' },
    { role: 'assistant', content: '甲州投控集团董事长为测试人物甲。' },
  ];
  const switched = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '演员测试人物甲是什么行业地位',
    subject: { name: '测试人物甲', type: 'person', aliases: ['演员测试人物甲'] },
    requiredAnchors: ['演员'],
    intent: { label: '行业地位', terms: ['演员', '行业地位'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: ['演员测试人物甲 行业地位', '演员测试人物甲 获奖'],
  }), {
    question: '演员测试人物甲是什么级别',
    history,
    researchContext,
    deep: true,
  });

  assert.equal(switched.valid, true);
  assert.equal(switched.fallbackReason, '');
  assert.equal(switched.state.subject.name, '测试人物甲');
  assert.deepEqual(switched.state.requiredAnchors, ['演员']);
  assert.equal(switched.state.intent.label, '行业地位');
  assert.doesNotMatch(switched.state.standaloneQuestion, /甲州|投控集团/u);
  assert.ok(switched.state.queries.every((query) => !/甲州|投控集团/u.test(query)));

  const contaminated = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '演员测试人物甲在甲州是什么行业地位',
    subject: { name: '测试人物甲', type: 'person', aliases: ['演员测试人物甲'] },
    requiredAnchors: ['演员', '甲州'],
    intent: { label: '行业地位', terms: ['演员', '行业地位'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: ['演员测试人物甲 甲州 行业地位'],
  }), {
    question: '演员测试人物甲是什么级别',
    history,
    researchContext,
    deep: true,
  });
  assert.equal(contaminated.valid, false);
  assert.equal(contaminated.fallbackReason, 'explicit_context_switch_requires_clarification');
  assert.equal(contaminated.state.ambiguous, true);
  assert.deepEqual(contaminated.state.requiredAnchors, ['演员']);

  const malformed = parseContextualizerOutput('not-json', {
    question: '演员测试人物甲是什么级别',
    history,
    researchContext,
    deep: true,
  });
  assert.equal(malformed.valid, false);
  assert.equal(malformed.fallbackReason, 'explicit_context_switch_requires_clarification');
  assert.equal(malformed.state.ambiguous, true);
  assert.deepEqual(malformed.state.requiredAnchors, ['演员']);
  assert.doesNotMatch(malformed.state.standaloneQuestion, /甲州|投控集团/u);
  assert.deepEqual(malformed.state.queries, []);
});

test('a new conversation repairs valid JSON that changes an explicit region, subject, or strong intent', () => {
  const drifted = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '乙州投控集团负责人简介',
    subject: { name: '乙州投控集团', type: 'organization', aliases: [] },
    requiredAnchors: ['乙州', '投控集团'],
    intent: { label: '人物简介', terms: ['人物经历'] },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: ['乙州投控集团 负责人 简介'],
  }), {
    question: '甲州投控集团董事长是谁',
    history: [],
    researchContext: null,
    deep: true,
  });

  assert.equal(drifted.valid, false);
  assert.equal(drifted.fallbackReason, 'initial_context_drift_repaired');
  assert.equal(drifted.state.subject.name, '甲州投控集团');
  assert.equal(drifted.state.subject.type, 'organization');
  assert.deepEqual(drifted.state.requiredAnchors, ['甲州', '投控集团']);
  assert.equal(drifted.state.intent.label, '现任职务');
  assert.equal(drifted.state.standaloneQuestion, '甲州投控集团董事长是谁');
  assert.deepEqual(drifted.state.queries, []);
  assert.doesNotMatch(JSON.stringify(drifted.state), /乙州/u);

  const guarded = guardResearchQueries(drifted.state, { deep: true });
  assert.ok(guarded.length >= 2);
  assert.ok(guarded.every((query) => /甲州/u.test(query)));
  assert.ok(guarded.every((query) => /投控集团/u.test(query)));
  assert.ok(guarded.every((query) => /董事长|现任|任命/u.test(query)));

  const consistent = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '甲州投资控股集团有限公司现任董事长是谁',
    subject: {
      name: '甲州投资控股集团有限公司',
      type: 'organization',
      aliases: ['甲州投控集团'],
    },
    requiredAnchors: ['甲州', '投资控股'],
    intent: { label: '现任职务', terms: ['董事长', '任命'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  }), {
    question: '甲州投控集团董事长是谁',
    history: [],
    researchContext: null,
    deep: false,
  });
  assert.equal(consistent.valid, true, 'a grounded legal-name expansion remains valid');

  const explicitPerson = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '甲州投控集团党委书记、董事长测试人物甲是什么行政级别',
    subject: { name: '测试人物甲', type: 'person', aliases: [] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '行政级别', terms: ['市管干部', '任前公示'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  }), {
    question: '甲州投控集团党委书记、董事长测试人物甲是什么行政级别',
    history: [],
    researchContext: null,
    deep: false,
  });
  assert.equal(explicitPerson.valid, true, 'the named person remains the subject and the organization remains an anchor');
  assert.equal(explicitPerson.state.subject.name, '测试人物甲');
  assert.deepEqual(explicitPerson.state.requiredAnchors, ['甲州', '投控集团']);

  const wrongIntent = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '甲州投控集团人物简介',
    subject: { name: '甲州投控集团', type: 'organization', aliases: [] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '人物简介', terms: ['人物经历'] },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  }), {
    question: '甲州投控集团董事长是谁',
    history: [],
    researchContext: null,
    deep: false,
  });
  assert.equal(wrongIntent.fallbackReason, 'initial_context_drift_repaired');
  assert.equal(wrongIntent.state.intent.label, '现任职务');

  const wrongNamedSubject = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '周杰伦是谁',
    subject: { name: '周杰伦', type: 'person', aliases: [] },
    requiredAnchors: [],
    intent: { label: '人物简介', terms: ['身份'] },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  }), {
    question: '测试人物乙是谁',
    history: [],
    researchContext: null,
    deep: false,
  });
  assert.equal(wrongNamedSubject.fallbackReason, 'initial_context_drift_repaired');
  assert.equal(wrongNamedSubject.state.subject.name, '测试人物乙');
  assert.equal(wrongNamedSubject.state.standaloneQuestion, '测试人物乙是谁');
});

test('a standalone ambiguous two-character person follow-up asks for clarification without searches', () => {
  const parsed = parseContextualizerOutput('not-json', {
    question: '甲某是什么级别？',
    history: [],
    researchContext: null,
    deep: true,
  });

  assert.equal(parsed.valid, false);
  assert.equal(parsed.fallbackReason, 'ambiguous_without_context');
  assert.equal(parsed.state.ambiguous, true);
  assert.equal(parsed.state.subject.name, '甲某');
  assert.match(parsed.state.clarificationQuestion, /哪一位.*甲某/u);
  assert.deepEqual(parsed.state.queries, []);
});

test('a valid contextualizer payload cannot silently resolve a new ambiguous short name', () => {
  const parsed = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '演员甲某是什么级别',
    subject: { name: '甲某', type: 'person', aliases: [] },
    requiredAnchors: ['演员'],
    intent: { label: '行业地位', terms: ['演员'] },
    temporal: { mode: 'current', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  }), {
    question: '甲某是什么级别',
    history: [],
    researchContext: null,
    deep: false,
  });
  assert.equal(parsed.state.ambiguous, true);
  assert.equal(parsed.valid, false);
  assert.match(parsed.state.clarificationQuestion, /哪一位/u);
});

test('a valid contextualizer cannot turn an implicit fragment into a new subject', () => {
  const researchContext = {
    subject: { name: '测试人物乙', type: 'person', aliases: ['ARTIST_A'] },
    requiredAnchors: ['星光练习营', '虚构歌手'],
    intent: { label: '人物介绍', terms: ['身份'] },
    temporal: { mode: 'unspecified', asOf: null },
    lastStandaloneQuestion: '测试人物乙是谁',
  };
  const history = [
    { role: 'user', content: '测试人物乙是谁' },
    { role: 'assistant', content: '测试人物乙是虚构歌手。' },
  ];
  const drifted = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '灯是什么照明设备',
    subject: { name: '灯', type: 'object', aliases: [] },
    requiredAnchors: [],
    intent: { label: '物件介绍', terms: ['照明设备'] },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: ['灯 照明设备 介绍'],
  }), {
    question: '灯',
    history,
    researchContext,
    deep: true,
  });

  assert.equal(drifted.valid, false);
  assert.equal(drifted.fallbackReason, 'ambiguous_implicit_follow_up');
  assert.equal(drifted.state.ambiguous, true);
  assert.equal(drifted.state.subject.name, '测试人物乙');
  assert.match(drifted.state.clarificationQuestion, /测试人物乙.*灯/u);
  assert.deepEqual(drifted.state.queries, []);

  const unrelatedButMentionsPrior = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '测试人物乙是谁',
    subject: { name: '测试人物乙', type: 'person', aliases: [] },
    requiredAnchors: researchContext.requiredAnchors,
    intent: researchContext.intent,
    temporal: researchContext.temporal,
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  }), {
    question: '灯',
    history,
    researchContext,
    deep: false,
  });
  assert.equal(unrelatedButMentionsPrior.fallbackReason, 'ambiguous_implicit_follow_up');
  assert.equal(unrelatedButMentionsPrior.state.ambiguous, true);
});

test('a valid implicit-fragment resolution must preserve the prior entity and an explainable relation', () => {
  const researchContext = {
    subject: { name: '测试人物乙', type: 'person', aliases: ['ARTIST_A'] },
    requiredAnchors: ['星光练习营', '虚构歌手'],
    intent: { label: '人物介绍', terms: ['身份'] },
    temporal: { mode: 'unspecified', asOf: null },
    lastStandaloneQuestion: '测试人物乙是谁',
  };
  const history = [
    { role: 'user', content: '测试人物乙是谁' },
    { role: 'assistant', content: '测试人物乙是虚构歌手。' },
  ];
  const resolved = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '测试人物乙与灯是什么网络梗',
    subject: { name: '测试人物乙', type: 'person', aliases: ['ARTIST_A'] },
    requiredAnchors: researchContext.requiredAnchors,
    intent: { label: '网络梗来源', terms: ['灯', '梗', '来源'] },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: ['测试人物乙 灯 网络梗', '灯 是什么'],
  }), {
    question: '灯',
    history,
    researchContext,
    deep: true,
  });

  assert.equal(resolved.valid, true);
  assert.equal(resolved.fallbackReason, '');
  assert.equal(resolved.state.subject.name, '测试人物乙');
  assert.deepEqual(resolved.state.requiredAnchors, researchContext.requiredAnchors);
  assert.equal(resolved.state.standaloneQuestion, '测试人物乙与灯是什么网络梗');
  assert.deepEqual(resolved.state.queries, [], 'implicit-fragment paths are replanned from the safe standalone question');

  const explicitAmbiguity = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '灯',
    subject: { name: '测试人物乙', type: 'person', aliases: [] },
    requiredAnchors: researchContext.requiredAnchors,
    intent: researchContext.intent,
    temporal: researchContext.temporal,
    ambiguous: true,
    clarificationQuestion: '你想问测试人物乙与“灯”的哪个梵？',
    queries: ['must never execute'],
  }), {
    question: '灯',
    history,
    researchContext,
    deep: true,
  });
  assert.equal(explicitAmbiguity.valid, true);
  assert.equal(explicitAmbiguity.state.ambiguous, true);
  assert.deepEqual(explicitAmbiguity.state.queries, []);
});

test('legacy message-only sessions clarify malformed or drifting one-character follow-ups', () => {
  const history = [
    { role: 'user', content: '测试人物乙是谁' },
    { role: 'assistant', content: '测试人物乙是虚构歌手。' },
  ];
  const malformed = parseContextualizerOutput('', {
    question: '灯',
    history,
    researchContext: null,
    deep: true,
  });
  assert.equal(malformed.valid, false);
  assert.equal(malformed.fallbackReason, 'ambiguous_fragment_after_contextualizer_failure');
  assert.equal(malformed.state.ambiguous, true);
  assert.equal(malformed.state.subject.name, '测试人物乙');
  assert.deepEqual(malformed.state.queries, []);

  const drifted = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '灯是什么照明设备',
    subject: { name: '灯', type: 'object', aliases: [] },
    requiredAnchors: [],
    intent: { label: '物件介绍', terms: ['照明设备'] },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: ['灯 照明设备'],
  }), {
    question: '灯',
    history,
    researchContext: null,
    deep: true,
  });
  assert.equal(drifted.valid, false);
  assert.equal(drifted.fallbackReason, 'ambiguous_implicit_follow_up');
  assert.equal(drifted.state.subject.name, '测试人物乙');
  assert.deepEqual(drifted.state.queries, []);

  const resolved = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '测试人物乙与灯是什么网络梗',
    subject: { name: '测试人物乙', type: 'person', aliases: [] },
    requiredAnchors: [],
    intent: { label: '网络梗来源', terms: ['灯', '梗'] },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [],
  }), {
    question: '灯',
    history,
    researchContext: null,
    deep: false,
  });
  assert.equal(resolved.valid, true);
  assert.equal(resolved.state.subject.name, '测试人物乙');
});

test('query guard repairs missing subject, anchor, and intent and removes near-duplicates', () => {
  const state = groundedState({
    standaloneQuestion: '测试人物甲是什么级别',
    queries: [
      '演员测试人物甲 示例高级演员职称',
      '甲州投控集团 测试人物甲 行政级别',
      '测试人物甲 甲州投控集团 行政级别',
      '甲州组织部 任前公示',
    ],
  });
  const guarded = guardResearchQueries(state, {
    deep: true,
    proposed: state.queries,
    maximum: 8,
  });

  assert.ok(guarded.length >= 2);
  assert.ok(guarded.length < 5, 'near-identical permutations should be deduplicated');
  for (const query of guarded) {
    assert.match(query, /测试人物甲/u);
    assert.match(query, /甲州|投控集团|投资控股/u);
    assert.match(query, /行政级别|市管干部|任前公示/u);
  }
});

test('technical concept questions keep their retrieval wording and bypass namesake entity gates', () => {
  const question = '告诉我训练时候的显存占用和推理时候的显存占用怎么计算，给我公式';
  const contextualized = parseContextualizerOutput(JSON.stringify({
    standaloneQuestion: '深度学习模型训练时候的显存占用和推理时候的显存占用怎么计算？请给出公式。',
    subject: {
      name: '深度学习模型训练与推理显存占用计算',
      type: 'concept',
      aliases: [
        'GPU显存占用计算',
        '训练显存计算',
        '推理显存计算',
        'VRAM usage calculation',
      ],
    },
    requiredAnchors: ['训练', '推理', '显存占用', '计算公式'],
    intent: {
      label: 'calculation_formula',
      terms: ['显存占用', '训练', '推理', '公式', '参数', '梯度', '优化器状态', '激活值'],
    },
    temporal: { mode: 'unspecified', asOf: null },
    ambiguous: false,
    clarificationQuestion: '',
    queries: [
      'AdamW 混合精度训练显存 参数 梯度 主权重 优化器状态 激活值',
      '推理显存 权重 量化 scale KV Cache 激活 workspace',
      'KV Cache 每 token 层数 KV头 head_dim dtype',
    ],
  }), {
    question,
    history: [],
    researchContext: null,
    deep: true,
  });

  assert.equal(contextualized.valid, true);
  const queries = guardResearchQueries(contextualized.state, {
    deep: true,
    maximum: 4,
  });
  assert.deepEqual(queries, [
    '深度学习模型训练时候的显存占用和推理时候的显存占用怎么计算？请给出公式。',
    'AdamW 混合精度训练显存 参数 梯度 主权重 优化器状态 激活值',
    '推理显存 权重 量化 scale KV Cache 激活 workspace',
    'KV Cache 每 token 层数 KV头 head_dim dtype',
  ]);
  assert.ok(queries.every((query) => !query.includes('深度学习模型训练与推理显存占用计算')));

  const candidates = [
    {
      path: 'learning_doc/项目/CS336/L2_整理版.md',
      heading: '显存占用分析',
      snippet: 'BF16 参数和梯度各占 2 字节，FP32 主权重和 AdamW 一阶、二阶矩各占 4 字节。',
    },
    {
      path: 'learning_doc/项目/happy-llm/第四章 大语言模型_整理版.md',
      heading: 'ZeRO 显存优化',
      snippet: '混合精度训练中模型状态通常按每参数 16 字节估算，并可按数据并行度切分。',
    },
    {
      path: 'learning_doc/工具使用教学/大模型权重精度_整理版.md',
      heading: '推理显存组成',
      snippet: '推理总显存由模型权重、量化 scale、KV Cache、激活值和 workspace 相加。',
    },
  ];
  const filtered = filterVaultEvidence(candidates, contextualized.state);
  assert.deepEqual(filtered.accepted.map((item) => item.path), candidates.map((item) => item.path));
  assert.equal(filtered.rejectedCount, 0);
});

test('concept, topic, and unknown states never synthesize an entity query or hard-filter evidence', () => {
  for (const type of ['concept', 'topic', 'unknown']) {
    const state = groundedState({
      standaloneQuestion: '训练和推理显存如何计算？',
      subject: { name: '合成的显存计算概念标签', type, aliases: ['合成概念别名'] },
      requiredAnchors: ['训练', '推理'],
      intent: { label: '公式', terms: ['参数', 'KV Cache'] },
      queries: [],
    });

    assert.deepEqual(
      guardResearchQueries(state, { deep: true, proposed: [], maximum: 4 }),
      ['训练和推理显存如何计算？'],
      `${type} must not generate a query from a synthetic concept label`,
    );
    assert.equal(
      evidenceMatchesEntity('每层 KV Cache 显存等于 token 数乘以 KV 头数和 head_dim。', state),
      true,
      `${type} must use retrieval relevance instead of a namesake gate`,
    );
  }
});

test('query equivalence catches normalized near-duplicates across research rounds', () => {
  assert.equal(
    researchQueriesEquivalent(
      '甲州投控集团 测试人物甲 市管干部 任前公示',
      '甲州投控集团测试人物甲市管干部任前公示',
    ),
    true,
  );
  assert.equal(
    researchQueriesEquivalent(
      '甲州投控集团 测试人物甲 市管干部 任前公示',
      '甲州投控集团 测试人物甲 董事长 任命时间线',
    ),
    false,
  );
});

test('Vault and Web entity gates require both the subject and a distinguishing anchor', () => {
  const state = groundedState();
  assert.equal(evidenceMatchesEntity('测试人物甲任甲州投控集团党委书记、董事长', state), true);
  assert.equal(evidenceMatchesEntity('演员测试人物甲获得电影奖项', state), false);
  assert.equal(evidenceMatchesEntity('甲州投控集团召开董事会', state), false);

  const vault = filterVaultEvidence([
    { path: '任免.md', snippet: '测试人物甲任甲州投资控股集团董事长' },
    { path: '影视.md', snippet: '演员测试人物甲主演电影' },
    { path: '投控.md', snippet: '甲州投控集团召开会议' },
  ], state);
  assert.deepEqual(vault.accepted.map((item) => item.path), ['任免.md']);
  assert.equal(vault.rejectedCount, 2);

  const web = selectWebEvidence([
    webCandidate({
      title: '甲州投控集团党委书记、董事长测试人物甲出席会议',
      url: 'https://www.city-a.gov.cn/news/leader',
      snippet: '甲州投控集团党委书记、董事长测试人物甲讲话。',
    }),
    webCandidate({
      title: '演员测试人物甲人物介绍',
      url: 'https://baike.baidu.com/item/actor-test-person-a',
      snippet: '演员测试人物甲的电影与话剧经历。',
    }),
    webCandidate({
      title: '示例理工大学教师测试人物甲',
      url: 'https://teacher.example.edu.cn/test-person-a',
      snippet: '测试人物甲为示例理工大学副教授。',
    }),
  ], state, { maxSources: 10 });
  assert.equal(web.rejectedEntityCount, 2);
  assert.deepEqual(web.included.map((item) => item.url), [
    'https://www.city-a.gov.cn/news/leader',
  ]);
});

test('a distinctive subject remains an evidence gate without secondary anchors', () => {
  const state = {
    ...groundedState(),
    subject: { name: '测试人物乙', type: 'person', aliases: [] },
    requiredAnchors: [],
  };
  assert.equal(evidenceMatchesEntity('测试人物乙是歌手和音乐制作人', state), true);
  assert.equal(evidenceMatchesEntity('这是一篇泛泛讨论“是谁”的无关文章', state), false);
});

test('anchored organization abbreviations match formal SOE names without widening unrelated evidence', () => {
  const state = groundedState({
    standaloneQuestion: '甲州投控集团董事长是谁',
    subject: { name: '甲州投控集团', type: 'organization', aliases: [] },
    requiredAnchors: ['甲州', '投控集团'],
    intent: { label: '现任负责人', terms: ['董事长', '任命'] },
  });
  assert.equal(
    evidenceMatchesEntity('甲州投资控股集团有限公司董事长测试人物甲出席会议', state),
    true,
  );
  assert.equal(evidenceMatchesEntity('乙州投资控股集团有限公司发布公告', state), false);
  assert.equal(evidenceMatchesEntity('甲州产业投资发展集团发布公告', state), false);

  const unanchored = { ...state, requiredAnchors: [] };
  assert.equal(
    evidenceMatchesEntity('某市投资控股集团有限公司发布公告', unanchored),
    false,
  );
});

test('a combined organization anchor matches its location-qualified formal name without admitting namesakes', () => {
  const state = groundedState({
    subject: { name: '测试人物甲', type: 'person', aliases: [] },
    requiredAnchors: ['甲州投控集团'],
  });

  assert.equal(
    evidenceMatchesEntity('甲州投资控股集团有限公司公告载明测试人物甲任董事长', state),
    true,
  );
  assert.equal(evidenceMatchesEntity('演员测试人物甲获得电影奖项', state), false);
  assert.equal(evidenceMatchesEntity('示例理工大学副教授测试人物甲参与城市发展研究', state), false);
  assert.equal(
    evidenceMatchesEntity('乙州投资控股集团有限公司董事长测试人物甲出席会议', state),
    false,
  );
  assert.equal(
    evidenceMatchesEntity('甲州产业投资发展集团有限公司与测试人物甲交流', state),
    false,
  );
});

test('Web evidence is ordered by authority first and recency within the same authority tier', () => {
  const state = groundedState();
  const result = selectWebEvidence([
    webCandidate({
      title: '投控年度报告披露测试人物甲早期任职情况',
      url: 'https://zgh.city-a.gov.cn/appointment/old',
      snippet: '甲州投控集团年度工作报告记录测试人物甲在该阶段参加董事会。',
      publishedAt: '2024-05-08',
    }),
    webCandidate({
      title: '市委组织部发布干部任前公示',
      url: 'https://jw.city-a.gov.cn/appointment/new',
      snippet: '甲州组织部公示投控集团测试人物甲拟进一步使用。',
      publishedAt: '2025-03-14',
    }),
    webCandidate({
      title: '交易所公告：甲州投控集团测试人物甲任职',
      url: 'https://static.sse.com.cn/disclosure/test-person-a.pdf',
      snippet: '交易所公告载明甲州投控集团测试人物甲的任职。',
      publishedAt: '2026-01-01',
    }),
    webCandidate({
      title: '甲州投控集团官网：测试人物甲参加会议',
      url: 'https://www.group-a.example.com/news/test-person-a',
      source: '甲州投控集团官网',
      snippet: '集团官网称甲州投控集团党委书记、董事长测试人物甲参加会议。',
      publishedAt: '2026-02-01',
    }),
    webCandidate({
      title: '甲州投控集团测试人物甲履历报道',
      url: 'https://www.xinhuanet.com/region-a/test-person-a',
      snippet: '新华社报道甲州投控集团测试人物甲相关履历。',
      publishedAt: '2026-03-01',
    }),
    webCandidate({
      title: '甲州投控集团测试人物甲企业信息',
      url: 'https://www.qcc.com/firm/test-person-a',
      snippet: '企查查展示甲州投控集团测试人物甲企业任职。',
      publishedAt: '2026-04-01',
    }),
    webCandidate({
      title: '甲州投控集团测试人物甲百科条目',
      url: 'https://baike.baidu.com/item/test-person-a-city-a',
      snippet: '百科整理甲州投控集团测试人物甲资料。',
      publishedAt: '2026-05-01',
    }),
  ], state, { maxSources: 10, maxPerDomain: 2 });

  assert.deepEqual(result.included.map((item) => item.authority), [
    'government_or_appointment',
    'government_or_appointment',
    'exchange_filing',
    'major_media',
    'enterprise_database',
    'other_web',
    'encyclopedia_or_ugc',
  ]);
  assert.match(result.included[0].title, /任前公示/u);
  assert.match(result.included[1].title, /年度报告/u);
});

test('Web evidence prioritizes the current intent after entity and anchor gating', () => {
  const state = {
    standaloneQuestion: '测试人物乙与灯是什么网络梗',
    subject: { name: '测试人物乙', type: 'person', aliases: [] },
    requiredAnchors: ['星光练习营'],
    intent: { label: '网络梗', terms: ['灯', '网络梗'] },
  };
  const selected = selectWebEvidence([
    {
      title: '测试人物乙参加星光练习营的个人履历',
      url: 'https://www.city-a.gov.cn/unrelated-biography',
      snippet: '测试人物乙参加星光练习营，介绍歌手履历。',
      queryIndex: 0,
    },
    {
      title: '测试人物乙与灯的网络梗来源',
      url: 'https://example.com/relevant-meme',
      snippet: '解释测试人物乙、星光练习营以及灯这一网络梗的关联。',
      queryIndex: 0,
    },
  ], state, { maxSources: 2 });

  assert.equal(selected.included[0].url, 'https://example.com/relevant-meme');
  assert.equal(selected.included[0].intentMatchCount > selected.included[1].intentMatchCount, true);
});

test('untrusted snippets cannot promote a UGC page to an official source tier', () => {
  const authority = webAuthority({
    title: '甲州投控集团测试人物甲履历解读',
    source: '搜狐号',
    snippet: '自称转载人民政府、市委组织部任前公示。',
    url: 'https://www.sohu.com/a/example',
  });
  assert.equal(authority.label, 'encyclopedia_or_ugc');
});

test('only an explicitly allowlisted organization hostname or its subdomain is promoted', () => {
  const candidate = {
    title: '甲州投控集团官网',
    source: '官方组织网站',
    snippet: '甲州投控集团测试人物甲任职信息。',
    url: 'https://news.group-a.example.com/leader',
  };
  assert.equal(webAuthority(candidate).label, 'other_web');
  assert.equal(
    webAuthority(candidate, { officialDomains: ['group-a.example.com'] }).label,
    'organization_official',
  );
  assert.equal(
    webAuthority({ ...candidate, url: 'https://group-a.example.com.evil.example/leader' }, {
      officialDomains: ['group-a.example.com'],
    }).label,
    'other_web',
  );

  const selected = selectWebEvidence([
    webCandidate({
      title: '甲州投控集团测试人物甲任职信息',
      url: 'https://news.group-a.example.com/leader',
      snippet: '甲州投控集团官网披露党委书记、董事长测试人物甲的任职信息。',
    }),
  ], groundedState(), {
    officialDomains: ['group-a.example.com'],
    maxSources: 10,
  });
  assert.equal(selected.included[0].authority, 'organization_official');
  assert.equal(selected.included[0].authorityLevel, 2);
});

test('Web evidence enforces two results per registrable domain and Deep selection round-robins query paths', () => {
  const state = groundedState();
  const domainLimited = selectWebEvidence([
    webCandidate({
      title: '领导班子变动公告披露董事长信息',
      url: 'https://news.example.com/one',
      snippet: '甲州投控集团完成负责人调整，测试人物甲出席并签署董事会文件。',
    }),
    webCandidate({
      title: '重点工程集中开工活动新闻',
      url: 'https://sub.example.com/two',
      snippet: '甲州重点工程举行集中开工，投控集团测试人物甲代表建设单位讲话。',
    }),
    webCandidate({
      title: '国企改革年度考核结果公布',
      url: 'https://other.example.com/three',
      snippet: '国企改革年度考核名单包含甲州投控集团以及负责人测试人物甲。',
    }),
  ], state, { maxSources: 10, maxPerDomain: 2 });
  assert.equal(domainLimited.included.length, 2);
  assert.equal(domainLimited.candidates.filter((item) => item.reason === 'domain_limit').length, 1);

  const roundRobin = selectWebEvidence([
    webCandidate({
      title: '董事长变更债券临时公告',
      url: 'https://path-one-a.test/evidence',
      snippet: '债券临时公告披露甲州投控集团测试人物甲行政级别相关任职沿革。',
      queryIndex: 0,
    }),
    webCandidate({
      title: '年度职工篮球联赛闭幕',
      url: 'https://path-one-b.test/evidence',
      snippet: '甲州投控集团举办体育活动，测试人物甲以党委书记身份宣布赛事闭幕。',
      queryIndex: 0,
    }),
    webCandidate({
      title: '城市更新项目签约仪式',
      url: 'https://path-one-c.test/evidence',
      snippet: '城市更新合作协议由甲州投控集团测试人物甲代表企业签署，涉及任职身份。',
      queryIndex: 0,
    }),
    webCandidate({
      title: '选拔任用市管干部人选公示',
      url: 'https://path-two-a.test/evidence',
      snippet: '任前公示列出甲州投控集团测试人物甲，说明拟进一步使用。',
      queryIndex: 1,
    }),
    webCandidate({
      title: '纪委召开警示教育专题会议',
      url: 'https://path-two-b.test/evidence',
      snippet: '警示教育会议由甲州投控集团负责人测试人物甲主持并部署整改工作。',
      queryIndex: 1,
    }),
  ], state, {
    deep: true,
    queryCount: 2,
    maxSources: 4,
    maxPerQuery: 8,
  });
  assert.deepEqual(roundRobin.included.map((item) => item.queryIndex), [0, 1, 0, 1]);
});

test('evidence assessment restricts source IDs and preserves direct versus inferred claims', () => {
  const parsed = parseEvidenceAssessment(JSON.stringify({
    sufficient: true,
    confidence: 1.7,
    claims: [
      {
        text: '公开公示直接确认测试人物甲属于市管干部。',
        sourceIds: ['W1', 'W999'],
        direct: true,
        asOf: '2024-04-12',
      },
      {
        text: '该岗位通常对应正处级规格。',
        sourceIds: ['W2'],
        direct: false,
        asOf: null,
      },
      {
        text: '完全来自未知来源的断言不得保留。',
        sourceIds: ['W404'],
        direct: true,
      },
    ],
    conflicts: ['旧材料与新任命存在任职时间冲突'],
    gaps: [],
    nextQueries: ['query one', 'query two', 'query three', 'query four'],
    readSourceIds: ['W2', 'W404', 'W1'],
  }), {
    allowedSourceIds: ['W1', 'W2'],
    unreadSourceIds: ['W2'],
    hasEvidence: true,
    hasOfficialEvidence: true,
  });

  assert.equal(parsed.valid, true);
  assert.equal(parsed.sufficient, false);
  assert.equal(parsed.confidence, 1);
  assert.deepEqual(parsed.claims, [
    {
      text: '公开公示直接确认测试人物甲属于市管干部。',
      sourceIds: ['W1'],
      direct: true,
      asOf: '2024-04-12',
    },
    {
      text: '该岗位通常对应正处级规格。',
      sourceIds: ['W2'],
      direct: false,
      asOf: null,
    },
  ]);
  assert.deepEqual(parsed.readSourceIds, ['W2']);
  assert.equal(parsed.nextQueries.length, 3);
});

test('an assessment cannot declare sufficiency when no allowlisted evidence exists', () => {
  const parsed = parseEvidenceAssessment(JSON.stringify({
    sufficient: true,
    confidence: 0.99,
    claims: [{ text: 'unsupported', sourceIds: ['W404'], direct: true }],
    conflicts: [],
    gaps: [],
    nextQueries: [],
    readSourceIds: [],
  }), {
    allowedSourceIds: [],
    unreadSourceIds: [],
    hasEvidence: false,
    hasOfficialEvidence: false,
  });

  assert.equal(parsed.sufficient, false);
  assert.deepEqual(parsed.claims, []);
});

test('an assessment with unresolved conflicts or gaps is never sufficient', () => {
  const base = {
    sufficient: true,
    confidence: 0.95,
    claims: [{
      text: '甲州投控集团董事长测试人物甲属于市管干部。',
      sourceIds: ['W1'],
      direct: true,
    }],
    nextQueries: [],
    readSourceIds: [],
  };
  const options = {
    allowedSourceIds: ['W1'],
    officialSourceIds: ['W1'],
    hasEvidence: true,
    hasOfficialEvidence: true,
    requiresOfficialEvidence: true,
    requiredSubject: '测试人物甲',
    requiredIntentTerms: ['行政级别', '市管干部'],
  };

  const conflicted = parseEvidenceAssessment(JSON.stringify({
    ...base,
    conflicts: ['新旧任命尚未核清'],
    gaps: [],
  }), options);
  const incomplete = parseEvidenceAssessment(JSON.stringify({
    ...base,
    conflicts: [],
    gaps: ['缺少任前公示原文'],
  }), options);

  assert.equal(conflicted.sufficient, false);
  assert.equal(incomplete.sufficient, false);
});

test('official sufficiency requires a direct official claim about the required subject and intent', () => {
  const options = {
    allowedSourceIds: ['W1', 'W2'],
    officialSourceIds: ['W1'],
    hasEvidence: true,
    hasOfficialEvidence: true,
    requiresOfficialEvidence: true,
    requiredSubject: '测试人物甲',
    requiredIntentTerms: ['行政级别', '市管干部', '任前公示'],
  };
  const unrelatedOfficial = parseEvidenceAssessment(JSON.stringify({
    sufficient: true,
    confidence: 0.9,
    claims: [
      { text: '甲州政府公布了年度预算。', sourceIds: ['W1'], direct: true },
      { text: '测试人物甲属于市管干部。', sourceIds: ['W2'], direct: true },
    ],
    conflicts: [], gaps: [], nextQueries: [], readSourceIds: [],
  }), options);
  const subjectOnlyOfficial = parseEvidenceAssessment(JSON.stringify({
    sufficient: true,
    confidence: 0.9,
    claims: [{ text: '官方页面提到了测试人物甲。', sourceIds: ['W1'], direct: true }],
    conflicts: [], gaps: [], nextQueries: [], readSourceIds: [],
  }), options);
  const coreOfficial = parseEvidenceAssessment(JSON.stringify({
    sufficient: true,
    confidence: 0.9,
    claims: [{ text: '任前公示确认测试人物甲属于市管干部。', sourceIds: ['W1'], direct: true }],
    conflicts: [], gaps: [], nextQueries: [], readSourceIds: [],
  }), options);

  assert.equal(unrelatedOfficial.sufficient, false);
  assert.equal(subjectOnlyOfficial.sufficient, false);
  assert.equal(coreOfficial.sufficient, true);
});

test('assessment prompt carries unresolved prior conflicts and gaps into the next evaluation', () => {
  const prompt = assessmentUserPrompt({
    state: groundedState(),
    previousAssessment: {
      sufficient: false,
      confidence: 0.41,
      conflicts: ['旧任命与新任命冲突 <待核验>'],
      gaps: ['缺少组织部原文'],
    },
  });
  assert.match(assessmentSystemPrompt(), /re-evaluate every unresolved conflict and gap/u);
  assert.match(prompt, /<previous_assessment>/u);
  assert.match(prompt, /旧任命与新任命冲突 &lt;待核验&gt;/u);
  assert.match(prompt, /缺少组织部原文/u);
});

test('citation finalization strips model appendices and unknown links, then emits one allowlisted appendix', () => {
  const finalized = finalizeWebCitations([
    '公开公示确认测试人物甲属于市管干部[W1]。',
    '未知编号[W404]、不安全编号[W2]不得成为来源。',
    '模型伪造链接：[伪来源](https://evil.example/claim)；裸链 https://evil.example/raw。',
    '参考式伪造：[参考][evil-ref]。',
    '[evil-ref]: https://evil.example/reference',
    '协议相对：[相对](//evil.example/relative)；脚本：[脚本](javascript:alert(1))。',
    '数据链接：[数据](data:text/html,evil)；文件：[文件](file:///etc/passwd)。',
    '原始 HTML：<a href="https://evil.example/html">恶意链接</a>。',
    '自动链接：<https://evil.example/autolink>；FTP：ftp://evil.example/file。',
    '',
    '### 联网来源',
    '- [模型自行生成](https://evil.example/appendix)',
  ].join('\n'), [
    { id: 'W1', title: '甲州组织部任前公示', url: 'https://www.city-a.gov.cn/notice', source: '甲州政府' },
    { id: 'W2', title: '不安全 HTTP 来源', url: 'http://unsafe.example/item', source: 'unsafe' },
    { id: 'W3', title: '未在正文引用的候选', url: 'https://unused.example/item', source: 'unused' },
  ]);

  assert.equal((finalized.answer.match(/^### 联网来源$/gmu) || []).length, 1);
  assert.deepEqual(finalized.referencedSources.map((source) => source.id), ['W1']);
  assert.match(finalized.body, /<a href="https:\/\/www\.city-a\.gov\.cn\/notice" data-second-mind-verified-external="true">甲州组织部任前公示<\/a>/u);
  assert.match(finalized.body, /\[未核验来源\]/u);
  assert.equal(finalized.answer.includes('evil.example'), false);
  assert.equal(finalized.answer.includes('javascript:'), false);
  assert.equal(finalized.answer.includes('data:'), false);
  assert.equal(finalized.answer.includes('file:'), false);
  assert.equal(finalized.answer.includes('ftp:'), false);
  assert.equal((finalized.answer.match(/data-second-mind-verified-external="true"/gu) || []).length, 2);
  assert.equal(finalized.answer.includes('<a href="https://evil.example'), false);
  assert.equal(finalized.answer.includes('unsafe.example'), false);
  assert.equal(finalized.answer.includes('unused.example'), false);
  assert.equal(finalized.answer.includes('[W404]'), false);

  const appendixOnly = finalizeWebCitations(
    '### Sources\n- [伪造来源](https://evil.example/only)',
    [],
  );
  assert.equal(appendixOnly.answer, '');
});

test('citation finalization strips H1-H6 model source appendices with optional colons and spacing', () => {
  const source = {
    id: 'W1',
    title: '甲州组织部任前公示',
    url: 'https://www.city-a.gov.cn/notice',
  };
  const headings = [
    '# 联网来源',
    '##外部来源：',
    '### 参考来源 :',
    '#### Sources:',
    '##### REFERENCES ：',
    '###### sources',
  ];

  for (const heading of headings) {
    const finalized = finalizeWebCitations(
      `核心事实[W1]。\n\n${heading}\n- [模型伪造](https://evil.example/source)`,
      [source],
    );
    assert.equal((finalized.answer.match(/^### 联网来源$/gmu) || []).length, 1, heading);
    assert.equal(finalized.answer.includes('evil.example'), false, heading);
    assert.equal(finalized.body, '核心事实<a href="https://www.city-a.gov.cn/notice" data-second-mind-verified-external="true">甲州组织部任前公示</a>。', heading);
  }
});

test('citation finalization removes bare and concatenated internal Web source IDs', () => {
  const finalized = finalizeWebCitations(
    '服务器字段只有标题 W12W3W5W7。可核验事实 [W1]。',
    [{ id: 'W1', title: '核验来源', url: 'https://example.com/verified' }],
  );

  assert.doesNotMatch(finalized.answer, /W\d+/u);
  assert.match(finalized.body, /未核验来源标记已移除/u);
  assert.match(finalized.body, /<a href="https:\/\/example\.com\/verified" data-second-mind-verified-external="true">核验来源<\/a>/u);
  assert.equal(finalized.referencedSources.length, 1);
});

test('citation finalization never scrubs source-like text inside server-minted anchors', () => {
  const finalized = finalizeWebCitations(
    '版本事实 [W1]。裸标记 W9 必须移除。',
    [{
      id: 'W1',
      title: 'W3 Release Notes',
      url: 'https://example.test/W3?channel=W4',
    }],
  );

  assert.match(finalized.body, /href="https:\/\/example\.test\/W3\?channel=W4"/u);
  assert.match(finalized.body, />W3 Release Notes<\/a>/u);
  assert.match(finalized.body, /裸标记 \[未核验来源标记已移除\]/u);
  assert.deepEqual(finalized.referencedSources.map((source) => source.id), ['W1']);
});

test('citation finalization preserves Markdown structure and code literals without citing code examples', () => {
  const finalized = finalizeWebCitations([
    '> 保留引用块 A&B。',
    '',
    '行内代码 `<tag>A&B [W1]</tag>` 不算引用。',
    '',
    '```html',
    '<tag>A&B [W1]</tag>',
    '### Sources',
    '```',
    '',
    '正文事实 [W1]。',
  ].join('\n'), [{
    id: 'W1', title: '核验来源', url: 'https://example.test/source',
  }]);

  assert.match(finalized.body, /^> 保留引用块 A&amp;B。/u);
  assert.match(finalized.body, /<code class="knowledge-model-code">&#60;tag&#62;A&#38;B &#91;W1&#93;&#60;&#47;tag&#62;<\/code>/u);
  assert.match(finalized.body, /<pre><code class="knowledge-model-code">&#60;tag&#62;A&#38;B &#91;W1&#93;&#60;&#47;tag&#62;\n&#35;&#35;&#35; Sources\n<\/code><\/pre>/u);
  assert.equal((finalized.body.match(/data-second-mind-verified-external/gu) || []).length, 1);
  assert.deepEqual(finalized.referencedSources.map((source) => source.id), ['W1']);
});

test('code protection follows CommonMark fence and maximal inline delimiter rules', () => {
  const source = { id: 'W2', title: '正文来源', url: 'https://example.test/body' };
  const longerClosingFence = finalizeWebCitations([
    '```html',
    '<span>[W1]</span>',
    '````',
    '<img title="[W1]" src="https://evil.test/image">',
    '正文 [W2]。',
  ].join('\n'), [source]);
  assert.match(longerClosingFence.body, /<pre><code class="knowledge-model-code">&#60;span&#62;&#91;W1&#93;&#60;&#47;span&#62;\n<\/code><\/pre>/u);
  assert.doesNotMatch(longerClosingFence.body, /<img|evil\.test/u);
  assert.equal((longerClosingFence.body.match(/&#91;W1&#93;/gu) || []).length, 1);
  assert.deepEqual(longerClosingFence.referencedSources.map((item) => item.id), ['W2']);

  const invalidFence = finalizeWebCitations([
    '```bad`info',
    '<img title="[W1]" src="https://evil.test/fence">',
    '正文 [W2]。',
  ].join('\n'), [source]);
  assert.doesNotMatch(invalidFence.body, /<img|evil\.test|W1/u);
  assert.deepEqual(invalidFence.referencedSources.map((item) => item.id), ['W2']);

  const mismatchedInline = finalizeWebCitations([
    '`<img title="[W1]" src="https://evil.test/inline">``',
    '正文 [W2]。',
  ].join('\n'), [source]);
  assert.doesNotMatch(mismatchedInline.body, /<img|evil\.test|W1/u);
  assert.deepEqual(mismatchedInline.referencedSources.map((item) => item.id), ['W2']);

  const escapedInline = finalizeWebCitations([
    '\\`<img title="[W1]" src="https://evil.test/escaped">`',
    '正文 [W2]。',
  ].join('\n'), [source]);
  assert.doesNotMatch(escapedInline.body, /<img|evil\.test|W1/u);
  assert.deepEqual(escapedInline.referencedSources.map((item) => item.id), ['W2']);

  const nestedContainers = finalizeWebCitations([
    '> ```bad`info',
    '> <img title="[W1]" src="https://evil.test/quote">',
    '',
    '- 项目',
    '  <img title="[W1]" src="https://evil.test/list">',
    '',
    '正文 [W2]。',
  ].join('\n'), [source]);
  assert.doesNotMatch(nestedContainers.body, /<img|evil\.test|W1/u);
  assert.deepEqual(nestedContainers.referencedSources.map((item) => item.id), ['W2']);

  const indented = finalizeWebCitations([
    '代码：',
    '',
    '    <tag>A&B [W1]</tag>',
    '',
    '正文没有引用。',
  ].join('\n'), [{ id: 'W1', title: '代码示例', url: 'https://example.test/code' }]);
  assert.match(indented.body, /<pre><code class="knowledge-model-code">&#60;tag&#62;A&#38;B &#91;W1&#93;&#60;&#47;tag&#62;\n<\/code><\/pre>/u);
  assert.equal(indented.body.includes('data-second-mind-verified-external'), false);
  assert.deepEqual(indented.referencedSources, []);

  const mergedTagBoundary = finalizeWebCitations(
    '`<img src="/x">`<x>`',
    [],
  );
  assert.match(mergedTagBoundary.body, /<code class="knowledge-model-code">&#60;img src&#61;&#34;&#47;x&#34;&#62;<\/code>/u);
  assert.doesNotMatch(mergedTagBoundary.body, /<img/u);

  const mergedLinkBoundary = finalizeWebCitations(
    '`<img src="/x">`[](https://evil.test)`',
    [],
  );
  assert.match(mergedLinkBoundary.body, /<code class="knowledge-model-code">&#60;img src&#61;&#34;&#47;x&#34;&#62;<\/code>/u);
  assert.doesNotMatch(mergedLinkBoundary.body, /<img|evil\.test/u);

  const mergedBlockContext = finalizeWebCitations([
    'p<div',
    '>',
    '    <img src="/x">',
  ].join('\n'), []);
  assert.match(mergedBlockContext.body, /<pre><code class="knowledge-model-code">&#60;img src&#61;&#34;&#47;x&#34;&#62;\n<\/code><\/pre>/u);
  assert.doesNotMatch(mergedBlockContext.body, /<img/u);
});

test('only claims backed by actually cited sources can persist', () => {
  const retained = retainCitedVerifiedClaims([
    { text: 'W1 与未知来源共同支持的事实', sourceIds: ['W1', 'W404'], direct: true, asOf: '2025-03-14' },
    { text: '未附来源的直接断言', sourceIds: [], direct: true },
    { text: '只由未引用来源支持', sourceIds: ['W3'], direct: true },
    { text: '有引用依据的岗位规格推断', sourceIds: ['W2'], direct: false },
    { text: '无引用依据的推断', sourceIds: [], direct: false },
  ], [{ id: 'W1' }, { id: 'W2' }]);

  assert.deepEqual(retained, [
    {
      text: 'W1 与未知来源共同支持的事实',
      sourceIds: ['W1'],
      direct: true,
      asOf: '2025-03-14',
    },
    {
      text: '有引用依据的岗位规格推断',
      sourceIds: ['W2'],
      direct: false,
      asOf: null,
    },
  ]);
});

test('saved research context contains bounded verified facts and cited-source metadata, never snippets or page bodies', () => {
  const claims = Array.from({ length: 24 }, (_, index) => ({
    text: `已核验事实 ${index}`,
    sourceIds: [`W${index + 1}`],
    direct: index % 2 === 0,
    asOf: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
    snippet: `DO_NOT_SAVE_CLAIM_SNIPPET_${index}`,
    body: `DO_NOT_SAVE_CLAIM_BODY_${index}`,
  }));
  const sources = Array.from({ length: 24 }, (_, index) => ({
    id: `W${index + 1}`,
    title: `正式来源 ${index}`,
    url: `https://source-${index}.example/document`,
    source: `来源机构 ${index}`,
    publishedAt: '2026-01-01',
    snippet: `DO_NOT_SAVE_WEB_SNIPPET_${index}`,
    text: `DO_NOT_SAVE_WEB_DOCUMENT_${index}`,
    headers: { authorization: 'DO_NOT_SAVE_SECRET' },
  }));
  const context = researchContextForSave({
    ...groundedState(),
    queries: ['DO_NOT_SAVE_RAW_QUERY'],
    webDocuments: ['DO_NOT_SAVE_STATE_DOCUMENT'],
  }, claims, sources);
  const serialized = JSON.stringify(context);

  assert.deepEqual(Object.keys(context).sort(), [
    'citedSources',
    'intent',
    'lastStandaloneQuestion',
    'requiredAnchors',
    'subject',
    'temporal',
    'verifiedClaims',
  ]);
  assert.equal(context.verifiedClaims.length, 20);
  assert.equal(context.citedSources.length, 20);
  assert.equal(context.verifiedClaims[0].asOf, '2026-01-01');
  assert.equal(context.verifiedClaims[19].asOf, '2026-01-20');
  assert.deepEqual(Object.keys(context.verifiedClaims[0]).sort(), ['asOf', 'direct', 'sourceIds', 'text']);
  assert.deepEqual(Object.keys(context.citedSources[0]).sort(), ['id', 'publishedAt', 'source', 'title', 'url']);
  for (const forbidden of [
    'DO_NOT_SAVE_CLAIM_SNIPPET',
    'DO_NOT_SAVE_CLAIM_BODY',
    'DO_NOT_SAVE_WEB_SNIPPET',
    'DO_NOT_SAVE_WEB_DOCUMENT',
    'DO_NOT_SAVE_SECRET',
    'DO_NOT_SAVE_RAW_QUERY',
    'DO_NOT_SAVE_STATE_DOCUMENT',
  ]) {
  assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('research context retains only cited Vault source metadata and its backed claims', () => {
  const context = researchContextForSave(groundedState(), [{
    text: 'Vault 已核验事实',
    sourceIds: ['V0123456789abcdef'],
    direct: true,
  }], [{
    id: 'V0123456789abcdef',
    kind: 'vault',
    path: 'notes/verified.md',
    title: 'notes/verified.md',
    content: 'DO_NOT_SAVE_VAULT_BODY',
  }]);

  assert.deepEqual(context.citedSources, [{
    id: 'V0123456789abcdef',
    kind: 'vault',
    title: 'notes/verified.md',
    path: 'notes/verified.md',
  }]);
  assert.equal(context.verifiedClaims.length, 1);
  assert.equal(JSON.stringify(context).includes('DO_NOT_SAVE_VAULT_BODY'), false);
});

test('final conversation state carries bounded verified provenance without Web URLs or source bodies', () => {
  const value = conversationStateXml({
    ...groundedState(),
    verifiedClaims: [{
      text: '测试人物甲担任甲州投控集团党委书记、董事长。',
      sourceIds: ['V0123456789abcdef', 'W1'],
      direct: true,
    }],
    citedSources: [{
      id: 'V0123456789abcdef', kind: 'vault', path: 'records/任免.md', title: '任免记录',
      content: 'DO_NOT_INCLUDE_VAULT_BODY',
    }, {
      id: 'W1', url: 'https://www.city-a.gov.cn/notices/1', title: '任前公示',
      source: '甲州政府', snippet: 'DO_NOT_INCLUDE_WEB_SNIPPET',
    }],
  }, [{ role: 'user', content: '上一轮问题' }]);

  assert.match(value, /V0123456789abcdef/u);
  assert.match(value, /records\/任免\.md/u);
  assert.match(value, /W1/u);
  assert.match(value, /测试人物甲担任甲州投控集团/u);
  assert.doesNotMatch(value, /city-a\.gov\.cn/u);
  assert.doesNotMatch(value, /DO_NOT_INCLUDE/u);
});
