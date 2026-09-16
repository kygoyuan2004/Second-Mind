// Learning-event windows are separate from file modification-time searches.
const ALL_SCOPE = /^(?:所有(?:的)?|全部(?:的)?|全都|all)(?:[。！？.!?\s]*)$/iu;
const RECAP = /总结|回顾|汇总|盘点|学(?:习)?了什么|学过什么|学习(?:重点|情况|进展|成果)|\b(?:summari[sz]e|recap|review)\b/iu;
const LEARNING = /学习|学过|学了|复习|读书|阅读记录|\b(?:my learning|my studies|what i learned)\b/iu;
const PUBLIC_RESEARCH = /(?:机器学习|深度学习|强化学习|研究|论文|行业|领域|学术).{0,12}(?:最新|进展|趋势|动态|发展)|(?:最新|前沿).{0,12}(?:研究|论文|进展|趋势)/u;
const OWNED = /(?:我的|本人|自己|知识库|笔记|日记|我(?:最近|过去|这|本|上|在|学|复习|读))/u;

export const learningReviewExecutionBudget = Object.freeze({
  maxTurns: 50, timeoutMs: 30 * 60_000, maxToolCalls: 40,
  retrievalTimeoutMs: 24 * 60_000,
});

const REVIEW_RETRIEVAL_TOOLS = new Set(['Read', 'Glob', 'Grep', 'mcp__knowledge__KnowledgeSearch', 'Agent', 'Task']);

export const knowledgeEvidencePolicy = [
  '当前知识库证据规则适用于新会话和续聊，取代历史消息中的日记或计划佐证门槛：技术笔记、整理笔记、日记和计划均可作为依据，不要求另有日记或计划中的活动句，也不强制逐字短引文；须实际读取并就近引用来源。',
  '按当前用户问题区分学习回顾、笔记整理和文件变化，不沿用历史回顾的证据限制；与上一问相关的追问可沿用已明确的时间范围，明确指定新范围时以新范围为准。',
  '允许结合正文、整理日期、frontmatter 日期及相关记录综合判断，注明实际日期来源及其含义，例如“笔记标注于某日整理”。最后修改时间只能说明最后修改，不能直接当作首次创建或完成学习的日期；工具没有返回的文件时间不得编造。',
].join('\n');

const REVIEW_EVIDENCE_RULES = Object.freeze([
  knowledgeEvidencePolicy,
  '有期内整理日期和实质内容的技术笔记可以纳入本期回顾，无须日记佐证；表述为笔记记录、整理或涉及的学习内容，不自动推断已经掌握、实践或完成全部任务。',
  '日期不明确的相关笔记可以列出并概述，注明“时间待核”，不将其断言为本期完成；日期或记录有冲突时说明冲突，不编造不存在的文件、图片、附件或时间。',
  '覆盖统计按文件去重且类别互斥：候选记录数 = 完整处理数 + 部分处理数 + 读取失败数 + 预算未覆盖数。每个文件只能归入其中一类；补充资料单独统计。空文件成功 Read 应计完整处理并注明“无有效内容”，不能同时计读取失败；没有学习事件不等于读取失败。',
]);

/** Count actual SDK tool requests, including concurrent/child requests. Never
 * return an allow decision: existing path and tool permissions still apply. */
export function createLearningReviewToolBudget(task, { now = () => Date.now(), onLimit = () => {} } = {}) {
  const state = task.learningReviewToolBudget ||= {
    startedAt: Number(task.executionStartedAt) || now(),
    calls: 0, seen: new Set(), closed: false, notified: false,
  };
  const close = () => {
    state.closed = true;
    if (!state.notified) {
      state.notified = true;
      onLimit({ calls: state.calls, maxToolCalls: learningReviewExecutionBudget.maxToolCalls });
    }
  };
  const finishInstruction = () => (
    `服务端已关闭本次回顾的继续检索：已使用 ${state.calls}/${learningReviewExecutionBudget.maxToolCalls} 次工具调用或达到读取时限。` +
    '现在必须停止发起 Read/Glob/Grep/KnowledgeSearch/Agent，使用已经返回的证据直接生成最终回答；' +
    '保留首轮时间范围，说明已读及预算未覆盖数量，不能声称全覆盖，不能因没有产出证据断言未完成。子 Agent 立即返回已有证据给主 Agent。\n' +
    REVIEW_EVIDENCE_RULES.join('\n')
  );
  const preToolUse = async (input) => {
    if (!REVIEW_RETRIEVAL_TOOLS.has(String(input?.tool_name || ''))) return {};
    if (now() - state.startedAt >= learningReviewExecutionBudget.retrievalTimeoutMs) close();
    const useId = String(input?.tool_use_id || '');
    // SDK callbacks can be retried; the same accepted tool id consumes once.
    if (useId && state.seen.has(useId)) return {};
    if (state.closed || state.calls >= learningReviewExecutionBudget.maxToolCalls) {
      close();
      return { hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: finishInstruction(), additionalContext: finishInstruction(),
      } };
    }
    state.calls += 1;
    if (useId) state.seen.add(useId);
    if (state.calls >= learningReviewExecutionBudget.maxToolCalls) close();
    let context = state.closed
      ? `这是最后一次获准的只读调用。等待这批已发起调用返回后，${finishInstruction()}`
      : `服务端回顾工具预算：${state.calls}/${learningReviewExecutionBudget.maxToolCalls} 次。覆盖各类笔记的期内线索；独立短记录可在同轮并行 Read。`;
    // A review can finish before the 40-call gate. Reassert the evidence
    // contract during long reads rather than relying only on the final gate.
    if ([20, 32].includes(state.calls)) context += `\n阶段性证据核验提醒：\n${REVIEW_EVIDENCE_RULES.join('\n')}`;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } };
  };
  const postToolUse = async () => state.closed ? {
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: finishInstruction() },
  } : {};
  return { state, preToolUse, postToolUse };
}

export function reviewTimeZone(value) {
  const requested = String(value || 'Asia/Shanghai').trim();
  try {
    new Intl.DateTimeFormat('en', { timeZone: requested }).format(0);
    return requested;
  } catch {
    return 'Asia/Shanghai';
  }
}

function partsAt(epoch, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(epoch).filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, Number(value)]));
}

function midnight(year, month, day, timeZone) {
  const wallClock = Date.UTC(year, month - 1, day);
  let result = wallClock;
  for (let index = 0; index < 3; index += 1) {
    const p = partsAt(result, timeZone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - result;
    result = wallClock - offset;
  }
  return result;
}

function stamp(epoch, timeZone) {
  const p = partsAt(epoch, timeZone);
  const two = (number) => String(number).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
}

function monthStart(p, delta, keepDay, timeZone) {
  const target = new Date(Date.UTC(p.year, p.month - 1 + delta, 1));
  const maxDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return midnight(target.getUTCFullYear(), target.getUTCMonth() + 1,
    keepDay ? Math.min(p.day, maxDay) : 1, timeZone);
}

function daysFrom(p, delta, timeZone) {
  const target = new Date(Date.UTC(p.year, p.month - 1, p.day + delta));
  return midnight(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), timeZone);
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

export function createLearningReview(question, { now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const text = String(question || '').trim();
  if (!RECAP.test(text) || !LEARNING.test(text)) return null;
  if (PUBLIC_RESEARCH.test(text) && !OWNED.test(text)) return null;
  // Queries about files changing retain their original retrieval semantics.
  if (/(?:修改|更新|新增|创建).{0,8}(?:文件|笔记)|(?:文件|笔记).{0,8}(?:修改|更新|新增|创建)/u.test(text)) return null;
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return null;
  const zone = reviewTimeZone(timeZone);
  const p = partsAt(nowMs, zone);
  let startMs;
  let endMs = nowMs;
  let label;
  const explicit = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s*(?:到|至|[~～—–])\s*(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})日?/u);
  if (explicit) {
    const [, year, month, day, endYear, endMonth, endDay] = explicit.map((part, index) => index ? Number(part) : part);
    const finalYear = Number.isFinite(endYear) && endYear ? endYear : year;
    if (!validDate(year, month, day) || !validDate(finalYear, endMonth, endDay)) return null;
    startMs = midnight(year, month, day, zone);
    endMs = Math.min(daysFrom({ year: finalYear, month: endMonth, day: endDay }, 1, zone) - 1, nowMs);
    label = '指定日期范围';
  } else if (/(?:最近|过去|近|这)\s*(?:一|1)?个?月|last month|past month/iu.test(text)) {
    startMs = monthStart(p, -1, true, zone);
    label = '最近一个月';
  } else if (/上个?月/u.test(text)) {
    startMs = monthStart(p, -1, false, zone);
    endMs = monthStart(p, 0, false, zone) - 1;
    label = '上个月';
  } else if (/本月|这个月/u.test(text)) {
    startMs = monthStart(p, 0, false, zone);
    label = '本月';
  } else if (/本周|这周|上周|上个星期/u.test(text)) {
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const back = (weekday + 6) % 7;
    const last = /上周|上个星期/u.test(text);
    startMs = daysFrom(p, -back - (last ? 7 : 0), zone);
    if (last) endMs = daysFrom(p, -back, zone) - 1;
    label = last ? '上周' : '本周';
  } else if (/(?:最近|过去|近)\s*(?:一|1)?(?:周|个星期)/u.test(text)) {
    startMs = daysFrom(p, -7, zone);
    label = '最近一周';
  } else if (/今天|今日|昨天|昨日/u.test(text)) {
    const yesterday = /昨天|昨日/u.test(text);
    startMs = daysFrom(p, yesterday ? -1 : 0, zone);
    if (yesterday) endMs = daysFrom(p, 0, zone) - 1;
    label = yesterday ? '昨天' : '今天';
  } else if (/最近|近期|近来/u.test(text) && !/[零〇一二两三四五六七八九十百\d]+\s*个?\s*(?:天|周|星期|月|年)/u.test(text)) {
    startMs = monthStart(p, -1, true, zone);
    label = '近期（默认最近一个月）';
  } else {
    return null;
  }
  if (startMs > endMs) return null;
  return {
    version: 1, originalQuestion: text, scope: 'all',
    anchorTime: new Date(nowMs).toISOString(), timeZone: zone, label,
    startInclusive: new Date(startMs).toISOString(), endInclusive: new Date(endMs).toISOString(),
  };
}

export function normalizeLearningReview(value) {
  if (!value || value.version !== 1 || typeof value.originalQuestion !== 'string') return null;
  const canonical = createLearningReview(value.originalQuestion, {
    now: value.anchorTime, timeZone: value.timeZone,
  });
  if (!canonical || canonical.startInclusive !== value.startInclusive || canonical.endInclusive !== value.endInclusive) return null;
  return canonical;
}

export function resolveLearningReview(question, conversation, options = {}) {
  if (!ALL_SCOPE.test(String(question || '').trim())) return createLearningReview(question, options);
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const users = messages.filter((message) => message.role === 'user');
  // Prefer the latest turn's context: a newer unrelated question must not revive
  // a stale review. Historical conversations can reconstruct from the timestamp
  // on their most recent complete user question, even after repeated “所有”.
  for (const message of users.reverse()) {
    const saved = normalizeLearningReview(message.learningReview);
    if (saved) return saved;
    if (ALL_SCOPE.test(String(message.text || '').trim())) continue;
    return createLearningReview(message.text, { ...options, now: message.createdAt });
  }
  return normalizeLearningReview(conversation?.learningReview);
}

export function learningReviewPrompt(review) {
  if (!review) return '';
  return [
    '个人学习回顾（后端已确定范围，请直接开始读取知识库）：',
    `原始问题：${review.originalQuestion}`,
    `学习方向：默认覆盖当前知识库的所有学习方向；原问题明确指定主题时按该主题。`,
    `固定时间范围：${stamp(Date.parse(review.startInclusive), review.timeZone)} 至 ${stamp(Date.parse(review.endInclusive), review.timeZone)}（${review.timeZone}，包含端点）。`,
    `首轮时间锚点：${review.anchorTime}。后续“所有、全部、所有的”只表示全部学习方向，继承本问题及时间，不重新计算，不重复询问学科。`,
    '先使用 Glob/Grep 枚举全库的技术笔记、整理笔记、日记、计划、周计划和日期段落，建立覆盖清单，再按清单分批 Read；普通检索前几项不能代表覆盖全库。技术笔记不必由日记或计划引出，文件名无日期也应检查正文和 frontmatter 中的日期线索。',
    '识别日期文件名、日期标题、整理日期、frontmatter 日期、周计划日期范围和日期表格列，并说明日期含义；混合日期文档区分期内与期外片段，月日需有明确年份上下文并通过日历检查，页码和比例不是日期。',
    '长文用 Read 的 offset/limit 连续分段；按各类笔记的期内线索和相关主题读取，核验整理版及关联原文。只读过片段不能称已全文覆盖。',
    '本回顾最多 50 轮、30 分钟；服务端限制 40 次只读检索调用，并在读取阶段达到 24 分钟时关闭继续扩展，留出最终汇总时间。普通模式仍不创建子 Agent。',
    '独立且较短的日期记录应尽量在同一轮并行 Read，减少逐篇往返。工具预算提醒由后端计数；达到上限或收到停止扩展提示后，立刻以已读证据汇总并报告预算未覆盖数量，不再尝试额外检索。',
    '回顾结论须有已读取的笔记内容及来源，日期依据可以来自该笔记本身，不要求独立活动记录。明确属于范围外的内容应单独说明，不能写成本期成果；例如起点为 8 月 6 日，则 8 月 3—5 日不属于范围。',
    ...REVIEW_EVIDENCE_RULES,
    '严格区分“完成、进行中、计划、未确认”。计划或未勾选待办不能写成成果；没有找到产出只能说“未确认完成情况”，不能判断“未完成”。同一任务出现状态变化时按期内最新明确事件更新并保留依据。',
    '回答开头说明实际固定日期范围；最后分别报告候选记录数、完整处理数、部分处理数、读取失败或预算未覆盖数、补充笔记数。无法核实数量时说明未核实，不编造覆盖率或全覆盖。',
    '本流程仅使用本知识库，默认跳过联网；不得要求用户开启时间窗或先提供所学学科。',
  ].join('\n');
}
