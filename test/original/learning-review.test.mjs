import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeAgentManager } from '../../src/original/knowledge-agent.mjs';
import {
  createLearningReview, learningReviewPrompt, normalizeLearningReview, resolveLearningReview,
  createLearningReviewToolBudget, learningReviewExecutionBudget,
} from '../../src/original/learning-review.mjs';

const QUESTION = '总结最近一个月的学习重点';
const CLOCK = '2026-09-06T04:05:06.000Z';
const OPTIONS = { now: CLOCK, timeZone: 'Asia/Shanghai' };

test('个人学习回顾确定自然月窗口，拒绝公有研究与文件修改问题', () => {
  const review = createLearningReview(QUESTION, OPTIONS);
  assert.equal(review.scope, 'all');
  assert.equal(review.startInclusive, '2026-08-05T16:00:00.000Z');
  assert.equal(review.endInclusive, CLOCK);
  assert.equal(review.anchorTime, CLOCK);
  assert.match(learningReviewPrompt(review), /2026-08-06 00:00:00 至 2026-09-06 12:05:06/);
  for (const question of [
    '总结最近一个月机器学习研究进展', '总结最近一个月深度学习的最新进展',
    '最近一个月修改了哪些学习笔记', '列出最近一个月学习笔记的修改',
    '所有', '如何学习 CUDA？', '请总结 RAG 论文的结论',
  ]) assert.equal(createLearningReview(question, OPTIONS), null, question);
  assert.ok(createLearningReview('总结我最近一个月机器学习的学习进展', OPTIONS));
  assert.equal(createLearningReview('总结最近两个月的学习重点', OPTIONS), null, '不把未支持的两个月误解为一个月');
});

test('跨年、月末、闰年和指定日期范围严格按本地日历计算', () => {
  for (const [now, expected] of [
    ['2026-01-06T04:00:00Z', '2025-12-05T16:00:00.000Z'],
    ['2026-03-31T04:00:00Z', '2026-02-27T16:00:00.000Z'],
    ['2024-03-31T04:00:00Z', '2024-02-28T16:00:00.000Z'],
  ]) assert.equal(createLearningReview(QUESTION, { ...OPTIONS, now }).startInclusive, expected);
  const lastMonth = createLearningReview('总结上个月的学习重点', OPTIONS);
  assert.equal(lastMonth.startInclusive, '2026-07-31T16:00:00.000Z');
  assert.equal(lastMonth.endInclusive, '2026-08-31T15:59:59.999Z');
  const explicit = createLearningReview('总结2026-08-06至2026-09-05的学习重点', OPTIONS);
  assert.equal(explicit.startInclusive, '2026-08-05T16:00:00.000Z');
  assert.equal(explicit.endInclusive, '2026-09-05T15:59:59.999Z');
  assert.equal(createLearningReview('总结2026-02-30至2026-03-05的学习重点', OPTIONS), null);
  assert.equal(createLearningReview('总结2026-09-05至2026-08-06的学习重点', OPTIONS), null);
});

test('本周及上周按周一开始，时区边界不会多纳入前一天', () => {
  const week = createLearningReview('总结本周学习重点', OPTIONS);
  assert.equal(week.startInclusive, '2026-08-30T16:00:00.000Z');
  const previous = createLearningReview('总结上周学习重点', OPTIONS);
  assert.equal(previous.startInclusive, '2026-08-23T16:00:00.000Z');
  assert.equal(previous.endInclusive, '2026-08-30T15:59:59.999Z');
  const midnight = createLearningReview(QUESTION, { ...OPTIONS, now: '2026-09-05T16:00:00Z' });
  assert.equal(midnight.startInclusive, '2026-08-05T16:00:00.000Z');
  const dst = createLearningReview(QUESTION, { now: '2026-04-06T13:00:00Z', timeZone: 'America/New_York' });
  assert.equal(dst.startInclusive, '2026-03-06T05:00:00.000Z');
});

test('旧会话三轮原话复用首轮日期，新主题不继承陈旧范围', () => {
  const conversation = { messages: [
    { role: 'user', text: QUESTION, createdAt: CLOCK },
    { role: 'assistant', text: '请提供学科', createdAt: CLOCK },
  ] };
  const expected = createLearningReview(QUESTION, OPTIONS);
  for (const prompt of ['所有', '所有的', '全部']) {
    assert.deepEqual(resolveLearningReview(prompt, conversation, {
      ...OPTIONS, now: '2026-10-06T04:00:00Z',
    }), expected);
    conversation.messages.push({ role: 'user', text: prompt, createdAt: '2026-10-06T04:00:00Z' });
  }
  conversation.learningReview = expected;
  conversation.messages.push({ role: 'user', text: '最新公开论文有哪些？', createdAt: CLOCK });
  assert.equal(resolveLearningReview('所有', conversation, OPTIONS), null);
  assert.equal(normalizeLearningReview({ ...expected, startInclusive: '2026-08-02T16:00:00.000Z' }), null);
});

test('提示词要求期内事件、日期清单、分段覆盖及计划与完成区分', () => {
  const prompt = learningReviewPrompt(createLearningReview(QUESTION, OPTIONS));
  for (const required of [
    /Glob\/Grep 枚举全库/, /周计划和日期段落/, /日期表格列/, /offset\/limit 连续分段/,
    /8 月 3—5 日不属于范围/, /修改时间只辅助/, /复习或实践/, /仅主题相关/,
    /完成、进行中、计划、未确认/, /不能判断“未完成”/, /期内最新明确事件/,
    /部分处理数/, /预算未覆盖数/, /不编造覆盖率/, /不得要求用户开启时间窗/,
  ]) assert.match(prompt, required);
});

test('回顾生成与服务端收尾都要求活动短引文，禁止用笔记或图片元数据建立本期成果', async () => {
  const prompt = learningReviewPrompt(createLearningReview(QUESTION, OPTIONS));
  const budget = createLearningReviewToolBudget({});
  const intermediateReminders = [];
  for (let index = 0; index < 40; index += 1) {
    const decision = await budget.preToolUse({ tool_name: 'Read', tool_use_id: `evidence-${index}` });
    if ([20, 32].includes(index + 1)) intermediateReminders.push(decision.hookSpecificOutput.additionalContext);
  }
  const denied = await budget.preToolUse({ tool_name: 'Read', tool_use_id: 'evidence-extra' });
  const finalReminder = await budget.postToolUse();
  assert.equal(intermediateReminders.length, 2);
  for (const text of [prompt, ...intermediateReminders, denied.hookSpecificOutput.additionalContext,
    finalReminder.hookSpecificOutput.additionalContext]) {
    assert.match(text, /期内日记、计划或周计划中的明确活动句/u);
    assert.match(text, /每一项必须紧邻给出：事件日期、记录类型、原文逐字短引文/u);
    assert.match(text, /计划句只能支持本期计划，不能支持已学习或已完成/u);
    assert.match(text, /标题日期、frontmatter 日期、图片文件名、截图时间、附件时间及文件修改时间均不是学习活动日期/u);
    assert.match(text, /不得编造未读取或根本不存在的图片/u);
    assert.match(text, /“关联资料说明”/u);
    assert.match(text, /“未确认资料列表”/u);
    assert.match(text, /不计入本期学习、成果或已完成数量/u);
    assert.match(text, /候选记录数 = 完整处理数 \+ 部分处理数 \+ 读取失败数 \+ 预算未覆盖数/u);
    assert.match(text, /空文件成功 Read 应计完整处理/u);
    assert.match(text, /不能同时计读取失败/u);
  }
});

test('服务端工具预算按独立调用计数，并发第 41 次必须拒绝且留下最终汇总空间', async () => {
  const task = {};
  let notifications = 0;
  const budget = createLearningReviewToolBudget(task, { onLimit: () => { notifications += 1; } });
  const decisions = await Promise.all(Array.from({ length: 41 }, (_, index) => budget.preToolUse({
    tool_name: index % 2 ? 'Read' : 'Grep', tool_use_id: `tool-${index}`,
  })));
  assert.equal(budget.state.calls, 40);
  assert.equal(budget.state.closed, true);
  assert.equal(notifications, 1);
  assert.equal(decisions.slice(0, 40).some((decision) => decision.hookSpecificOutput?.permissionDecision), false,
    '预算 hook 不能用 allow 覆盖原路径权限');
  assert.equal(decisions[40].hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decisions[40].hookSpecificOutput.additionalContext, /直接生成最终回答/u);
  assert.match(decisions[39].hookSpecificOutput.additionalContext, /最后一次获准/u);
  assert.match((await budget.postToolUse()).hookSpecificOutput.additionalContext, /预算未覆盖/u);
  await budget.preToolUse({ tool_name: 'Read', tool_use_id: 'tool-0' });
  assert.equal(budget.state.calls, 40, '重试相同 tool_use_id 不重复计数');
  assert.equal(learningReviewExecutionBudget.maxTurns, 50);
});

test('读取阶段 24 分钟后后端停止扩展，保留 6 分钟汇总时间', async () => {
  let now = 1_000;
  const task = {};
  const budget = createLearningReviewToolBudget(task, { now: () => now });
  await budget.preToolUse({ tool_name: 'Glob', tool_use_id: 'initial' });
  now += 24 * 60_000;
  const decision = await budget.preToolUse({ tool_name: 'Read', tool_use_id: 'late' });
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(budget.state.calls, 1);
  assert.equal(learningReviewExecutionBudget.timeoutMs - learningReviewExecutionBudget.retrievalTimeoutMs, 6 * 60_000);
});

async function waitForTask(manager, id) {
  for (let index = 0; index < 100; index += 1) {
    const task = manager.getTask('review-test-user', id);
    if (['completed', 'failed'].includes(task.status)) {
      assert.equal(task.status, 'completed', JSON.stringify(task.events));
      await manager.persistQueue;
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Mock task did not finish');
}

test('原话三轮直接进入只读 Agent，固定范围跨重启恢复且联网默认关闭', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuan-learning-review-'));
  const vault = path.join(root, 'vault');
  await fsp.mkdir(vault);
  const marker = path.join(vault, 'synthetic.md');
  await fsp.writeFile(marker, '# Synthetic immutable source\n');
  const before = await fsp.stat(marker);
  const captured = [];
  let normalSearches = 0;
  let webFactories = 0;
  let clock = CLOCK;
  const managers = [];
  t.after(async () => {
    for (const manager of managers) { manager.close(); await manager.persistQueue; }
    await fsp.rm(root, { recursive: true, force: true });
  });
  const makeManager = () => {
    const manager = new KnowledgeAgentManager({
      now: () => clock, timeZone: 'Asia/Shanghai', index: false, hybridSearchEnabled: false,
      conversationFile: path.join(root, 'private', 'history.json'),
      store: {
        root: vault, realRoot: vault, attachIndex() {},
        async initialize() {}, async assertNoSymlinks() {}, async audit() {},
        async search() { normalSearches += 1; return []; },
      },
      videoProcessor: { ready: Promise.resolve(), async cleanupStale() {} },
      knowledgeSearchServerFactory: () => ({}),
      webSearchServerFactory: () => { webFactories += 1; return {}; },
      queryFn: (input) => (async function* () {
        captured.push(input);
        if (input.options.maxTurns === 50) {
          const pre = input.options.hooks.PreToolUse[0].hooks[0];
          for (let index = 0; index < 41; index += 1) {
            const decision = await pre({ tool_name: 'Read', tool_use_id: `read-${index}` });
            assert.equal(decision.hookSpecificOutput?.permissionDecision === 'deny', index >= 40);
          }
          assert.match((await input.options.hooks.PostToolUse[0].hooks[0]()).hookSpecificOutput.additionalContext, /直接生成最终回答/u);
        }
        yield { type: 'result', subtype: 'success', session_id: 'mock-review-session', result: '合成回顾结果', num_turns: 1 };
      })(),
    });
    managers.push(manager);
    return manager;
  };
  let manager = makeManager();
  await manager.ready;
  let conversationId;
  let window;
  for (const [index, prompt] of [QUESTION, '所有', '所有的'].entries()) {
    const result = await manager.createTask('review-test-user', {
      kind: 'qa', prompt, model: 'qwen', effort: 'xhigh', webSearch: true, conversationId,
    });
    conversationId = result.conversationId;
    const task = await waitForTask(manager, result.taskId);
    window ||= task.learningReview;
    assert.deepEqual(task.learningReview, window);
    assert.equal(task.webSearch, false);
    assert.equal(task.retrieval, null);
    assert.equal(task.taskMode.id, 'normal');
    assert.equal(task.taskMode.maxTurns, 50);
    assert.equal(task.taskMode.timeoutMs, 30 * 60_000);
    assert.equal(task.learningReviewToolBudget.calls, 40);
    assert.equal(captured[index].options.maxTurns, 50);
    assert.equal(captured[index].options.tools.includes('Agent'), false);
    assert.equal(captured[index].options.agents, undefined);
    assert.ok(task.events.some((event) => event.data.title === '学习回顾读取预算' && /50 轮、30 分钟/u.test(event.data.message)));
    assert.ok(task.events.some((event) => event.data.title === '学习回顾开始收尾'));
    assert.match(captured[index].prompt, /原始问题：总结最近一个月的学习重点/);
    assert.match(captured[index].prompt, /2026-08-06 00:00:00 至 2026-09-06 12:05:06/);
    assert.match(captured[index].options.systemPrompt.append, /不能判断“未完成”/);
    assert.deepEqual(captured[index].options.tools.slice(0, 3), ['Read', 'Glob', 'Grep']);
    assert.equal(captured[index].options.allowedTools.some((tool) => /tavily|Write|Edit|Bash/.test(tool)), false);
    assert.equal('tavily' in captured[index].options.mcpServers, false);
    if (index === 0) {
      manager.close();
      clock = '2026-10-06T04:00:00.000Z';
      manager = makeManager();
      await manager.ready;
    }
  }
  assert.equal(normalSearches, 0, '回顾不能先以 topK 召回作为覆盖清单');
  assert.equal(webFactories, 0);
  const history = JSON.parse(await fsp.readFile(path.join(root, 'private', 'history.json'), 'utf8'));
  assert.deepEqual(history.conversations[0].learningReview, window);
  assert.equal(history.conversations[0].messages.filter((message) => message.role === 'user')
    .every((message) => message.learningReview.anchorTime === CLOCK), true);
  assert.equal(await fsp.readFile(marker, 'utf8'), '# Synthetic immutable source\n');
  const after = await fsp.stat(marker);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode, before.mode);

  const ordinary = await manager.createTask('review-test-user', {
    kind: 'qa', prompt: '总结最近一个月机器学习研究进展', model: 'qwen', effort: 'xhigh',
    webSearch: true, conversationId,
  });
  const task = await waitForTask(manager, ordinary.taskId);
  assert.equal(task.learningReview, null);
  assert.equal(task.webSearch, true);
  assert.equal(task.taskMode.maxTurns, 20);
  assert.equal(task.taskMode.timeoutMs, 10 * 60_000);
  assert.equal(captured.at(-1).options.hooks, undefined);
  assert.equal(normalSearches, 1);
  assert.equal(webFactories, 1);
});
