import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertAnonymousReport } from './benchmark-core.mjs';

export const DEFAULT_BENCHMARK_REPORT_BASENAME =
  '迁移前Agent与迁移后RAG_Benchmark报告_2026-08-31';

const MODE_LABELS = Object.freeze({ normal: 'Normal 模式', deep: 'Deep 模式' });
const CI_METRICS = Object.freeze([
  ['questionAccuracy', '问题准确率', 'rate'],
  ['factF1', '原子事实 F1', 'rate'],
  ['hallucinationRate', '幻觉率', 'rate'],
  ['retrievalF1At12', '检索 F1@12', 'rate'],
  ['estimatedCostCny', '单题估算费用', 'currency'],
  ['totalMs', '总耗时', 'ms'],
]);
const PRIMARY_QUALITY_METRICS = Object.freeze([
  ['questionAccuracy', '问题准确率', true],
  ['factF1', '原子事实 F1', true],
  ['hallucinationRate', '幻觉率', false],
]);
const ERROR_LABELS = Object.freeze({
  TASK_TIMEOUT: '任务超时',
  BUDGET_ERROR: '预算拦截',
  AUTH_ERROR: '鉴权错误',
  RATE_LIMIT_ERROR: '限流',
  USAGE_ERROR: 'Usage 不确定',
  NETWORK_ERROR: '网络错误',
  RETRIEVAL_ERROR: '检索错误',
  MODEL_API_ERROR: '模型 API 错误',
  CANCELLED: '已取消',
  OTHER_ERROR: '其他错误',
});
const CAVEAT_TRANSLATIONS = Object.freeze({
  'Accuracy@k is auxiliary because true negatives dominate large document collections.':
    'Accuracy@k 容易受大量真阴性影响，仅作为辅助指标。',
  'Answer metrics require approved human or deterministic adjudication counts.':
    '回答质量指标依赖已批准的人工或确定性仲裁结果。',
  'Prices are estimates; the provider invoice is authoritative.':
    '费用按公开单价估算，最终以服务商账单为准。',
});

export class BenchmarkReportRenderError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BenchmarkReportRenderError';
    this.code = code;
  }
}

function fail(message, code, cause) {
  throw new BenchmarkReportRenderError(message, code, cause ? { cause } : {});
}

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function number(value, digits = 2) {
  const numeric = finite(value);
  if (numeric === null) return '—';
  return numeric.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function percent(value) {
  const numeric = finite(value);
  return numeric === null ? '—' : `${(numeric * 100).toFixed(1)}%`;
}

function currency(value) {
  const numeric = finite(value);
  return numeric === null ? '—' : `¥${numeric.toFixed(numeric < 0.01 ? 6 : 4)}`;
}

function milliseconds(value) {
  const numeric = finite(value);
  return numeric === null ? '—' : `${number(numeric, 1)} ms`;
}

function markdownEscape(value) {
  return String(value).replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/\r?\n/g, ' ');
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markdownTable(headers, rows) {
  const header = `| ${headers.map(markdownEscape).join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(markdownEscape).join(' | ')} |`).join('\n');
  return [header, separator, body].filter(Boolean).join('\n');
}

function htmlTable(title, headers, rows) {
  if (!rows.length) return '';
  return `<section class="metric-block">
    <h3>${htmlEscape(title)}</h3>
    <div class="table-wrap"><table>
      <thead><tr>${headers.map((header) => `<th>${htmlEscape(header)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => (
        `<td>${htmlEscape(cell)}</td>`
      )).join('')}</tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

function modeSystems(summary, mode) {
  return summary.systems
    .map((system) => ({ system, mode: system.modes?.[mode] }))
    .filter((entry) => entry.mode);
}

function answerQualityRows(summary, mode) {
  return modeSystems(summary, mode).map(({ system, mode: value }) => {
    const answers = value.answers || {};
    return [
      system.anonymousSystem,
      number(answers.evaluatedQuestions, 0),
      percent(answers.questionAccuracy),
      percent(answers.factPrecision),
      percent(answers.factRecall),
      percent(answers.factF1),
      percent(answers.answerCompleteness),
      percent(answers.unanswerableCorrectRefusalRate),
    ];
  });
}

function answerEvidenceRows(summary, mode) {
  return modeSystems(summary, mode).map(({ system, mode: value }) => {
    const answers = value.answers || {};
    return [
      system.anonymousSystem,
      percent(answers.citationPrecision),
      percent(answers.citationRecall),
      percent(answers.invalidCitationRate),
      percent(answers.hallucinationRate),
      percent(answers.contradictionRate),
    ];
  });
}

function retrievalAtKRows(summary, mode) {
  const rows = [];
  for (const { system, mode: value } of modeSystems(summary, mode)) {
    const byK = value.retrieval?.byK || {};
    for (const k of summary.benchmark.kValues || []) {
      const metrics = byK[k] || {};
      rows.push([
        system.anonymousSystem,
        String(k),
        percent(metrics.accuracy),
        percent(metrics.precision),
        percent(metrics.recall),
        percent(metrics.f1),
      ]);
    }
  }
  return rows;
}

function rankingRows(summary, mode) {
  return modeSystems(summary, mode).map(({ system, mode: value }) => {
    const retrieval = value.retrieval || {};
    return [
      system.anonymousSystem,
      number(retrieval.questions, 0),
      number(retrieval.answerableQuestions, 0),
      number(retrieval.meanReciprocalRank, 4),
      number(retrieval.meanAveragePrecision, 4),
      number(retrieval.meanNdcg, 4),
      percent(retrieval.exactLineHitRate),
      percent(retrieval.evidenceSegmentRecall),
      percent(retrieval.duplicateLogicalOccupancyRate),
      percent(retrieval.unanswerableFalseRetrievalRate),
    ];
  });
}

function tokenRows(summary, mode) {
  return modeSystems(summary, mode).map(({ system, mode: value }) => {
    const usage = value.usage || {};
    return [
      system.anonymousSystem,
      number(usage.requests, 0),
      number(usage.standardInputTokens, 0),
      number(usage.cacheReadInputTokens, 0),
      number(usage.cacheCreationInputTokens, 0),
      number(usage.totalInputTokens, 0),
      number(usage.outputTokens, 0),
      number(usage.totalTokens, 0),
      currency(value.estimatedCostCny),
      number(value.tokensPerCorrectAnswer, 0),
      currency(value.costPerCorrectAnswerCny),
      number(value.tokensPerCorrectFact, 0),
      currency(value.costPerCorrectFactCny),
    ];
  });
}

function latencyCell(value, field) {
  const metric = value.latency?.[field] || {};
  return `${milliseconds(metric.mean)} / ${milliseconds(metric.p50)} / ${milliseconds(metric.p95)}`;
}

function latencyRows(summary, mode) {
  return modeSystems(summary, mode).map(({ system, mode: value }) => [
    system.anonymousSystem,
    latencyCell(value, 'indexBuildMs'),
    latencyCell(value, 'retrievalMs'),
    latencyCell(value, 'timeToFirstTokenMs'),
    latencyCell(value, 'generationMs'),
    latencyCell(value, 'totalMs'),
    number(value.outputTokensPerSecond, 2),
  ]);
}

function operationRows(summary, mode) {
  return modeSystems(summary, mode).map(({ system, mode: value }) => [
    system.anonymousSystem,
    `${number(value.successfulRuns, 0)}/${number(value.runs, 0)}`,
    number(value.qualityRuns, 0),
    number(value.repeatedPerformanceRuns, 0),
    percent(value.successRate),
    percent(value.timeoutRate),
    number(value.modelCalls, 0),
    number(value.agentTurns, 0),
    number(value.toolCalls, 0),
    number(value.embeddingRequests, 0),
    number(value.rerankRequests, 0),
    number(value.retryCount, 0),
    percent(value.retryRate),
    number(value.apiErrorCount, 0),
    percent(value.apiErrorRate),
  ]);
}

function errorRows(summary, mode) {
  const rows = [];
  for (const { system, mode: value } of modeSystems(summary, mode)) {
    for (const [bucket, label] of Object.entries(ERROR_LABELS)) {
      const count = finite(value.errorCounts?.[bucket]);
      if (count > 0) rows.push([system.anonymousSystem, label, number(count, 0)]);
    }
  }
  return rows;
}

function ciFormat(value, kind) {
  if (kind === 'rate') return finite(value) === null ? '—' : `${(value * 100).toFixed(2)} pp`;
  if (kind === 'currency') return currency(value);
  if (kind === 'ms') return milliseconds(value);
  return number(value, 4);
}

function ciRows(summary, mode) {
  const rows = [];
  for (const comparison of summary.comparisons || []) {
    const label = (comparison.systems || []).join(' − ');
    const intervals = comparison.pairedBootstrap95?.[mode] || {};
    for (const [field, metricLabel, kind] of CI_METRICS) {
      const interval = intervals[field];
      if (!interval) continue;
      rows.push([
        label,
        metricLabel,
        ciFormat(interval.meanDifference, kind),
        `[${ciFormat(interval.lower95, kind)}, ${ciFormat(interval.upper95, kind)}]`,
        number(interval.pairedQuestions, 0),
      ]);
    }
  }
  return rows;
}

function intervalDecision(comparison, mode, field, higherIsBetter) {
  const interval = comparison?.pairedBootstrap95?.[mode]?.[field];
  const systems = comparison?.systems;
  const lower = finite(interval?.lower95);
  const upper = finite(interval?.upper95);
  const pairedQuestions = finite(interval?.pairedQuestions);
  if (
    !Array.isArray(systems) || systems.length !== 2 || lower === null || upper === null ||
    pairedQuestions === null || pairedQuestions < 2
  ) return { available: false, winner: null, interval };
  const firstIsHigher = lower > 0;
  const secondIsHigher = upper < 0;
  let winner = null;
  if (firstIsHigher) winner = higherIsBetter ? systems[0] : systems[1];
  if (secondIsHigher) winner = higherIsBetter ? systems[1] : systems[0];
  return { available: true, winner, interval };
}

function twoSystemComparison(summary) {
  if (summary.systems.length !== 2) return null;
  const names = new Set(summary.systems.map((system) => system.anonymousSystem));
  return (summary.comparisons || []).find((comparison) => (
    Array.isArray(comparison.systems) && comparison.systems.length === 2 &&
    comparison.systems.every((system) => names.has(system))
  )) || null;
}

function qualityConclusion(summary, mode) {
  const comparison = twoSystemComparison(summary);
  const entries = modeSystems(summary, mode);
  if (!comparison || entries.length !== 2) {
    return {
      status: 'insufficient',
      winner: null,
      text: `${MODE_LABELS[mode]}缺少完整的两系统配对结果，不判定质量胜者。`,
      basis: [],
    };
  }
  const decisions = PRIMARY_QUALITY_METRICS.map(([field, label, higherIsBetter]) => ({
    field,
    label,
    ...intervalDecision(comparison, mode, field, higherIsBetter),
  }));
  if (!decisions.every((entry) => entry.available)) {
    return {
      status: 'insufficient',
      winner: null,
      text: `${MODE_LABELS[mode]}的核心质量置信区间不完整或成对题数不足，不判定质量胜者。`,
      basis: [],
    };
  }
  const decisive = decisions.filter((entry) => entry.winner);
  const winners = new Set(decisive.map((entry) => entry.winner));
  const basis = decisive.map((entry) => (
    `${entry.label}支持 ${entry.winner}（95% CI ` +
    `[${ciFormat(entry.interval.lower95, 'rate')}, ${ciFormat(entry.interval.upper95, 'rate')}]）`
  ));
  if (winners.size > 1) {
    return {
      status: 'tradeoff',
      winner: null,
      text: `${MODE_LABELS[mode]}的核心质量指标分别支持不同系统，存在质量权衡，不宜合并为单一胜者。`,
      basis,
    };
  }
  if (winners.size === 1) {
    const [winner] = winners;
    return {
      status: 'clear',
      winner,
      text: `${MODE_LABELS[mode]}中，有统计支持的核心质量指标倾向 ${winner}，且没有核心指标明确支持另一系统。`,
      basis,
    };
  }
  return {
    status: 'no-clear-difference',
    winner: null,
    text: `${MODE_LABELS[mode]}中，问题准确率、原子事实 F1 和幻觉率的 95% CI 均跨越或接触 0，未显示明确质量差异。`,
    basis: [],
  };
}

function lowerValueWinner(firstName, firstValue, secondName, secondValue) {
  const first = finite(firstValue);
  const second = finite(secondValue);
  if (first === null || second === null) return { available: false, winner: null };
  const tolerance = Math.max(1e-9, Math.max(Math.abs(first), Math.abs(second)) * 1e-9);
  if (Math.abs(first - second) <= tolerance) return { available: true, winner: null };
  return { available: true, winner: first < second ? firstName : secondName };
}

function efficiencyConclusion(summary) {
  const entries = modeSystems(summary, 'normal');
  if (entries.length !== 2) return { status: 'insufficient', winner: null, basis: [] };
  const [first, second] = entries;
  const cost = lowerValueWinner(
    first.system.anonymousSystem,
    first.mode.costPerCorrectAnswerCny,
    second.system.anonymousSystem,
    second.mode.costPerCorrectAnswerCny,
  );
  const latency = lowerValueWinner(
    first.system.anonymousSystem,
    first.mode.latency?.totalMs?.p50,
    second.system.anonymousSystem,
    second.mode.latency?.totalMs?.p50,
  );
  const basis = [
    `每个正确答案费用：${first.system.anonymousSystem} ${currency(first.mode.costPerCorrectAnswerCny)}，` +
      `${second.system.anonymousSystem} ${currency(second.mode.costPerCorrectAnswerCny)}`,
    `p50 总耗时：${first.system.anonymousSystem} ${milliseconds(first.mode.latency?.totalMs?.p50)}，` +
      `${second.system.anonymousSystem} ${milliseconds(second.mode.latency?.totalMs?.p50)}`,
  ];
  if (!cost.available || !latency.available) {
    return { status: 'insufficient', winner: null, basis };
  }
  const nonTied = [cost.winner, latency.winner].filter(Boolean);
  const winners = new Set(nonTied);
  if (winners.size === 1) return { status: 'pareto', winner: nonTied[0], basis };
  if (winners.size > 1) return { status: 'tradeoff', winner: null, basis };
  return { status: 'tie', winner: null, basis };
}

function minimumModeCount(summary, mode, field) {
  const values = modeSystems(summary, mode).map(({ mode: value }) => finite(value[field]))
    .filter((value) => value !== null);
  return values.length ? Math.min(...values) : null;
}

function derivedLimitations(summary) {
  const datasetQuestions = finite(summary.benchmark.datasetQuestions);
  const normalQuality = minimumModeCount(summary, 'normal', 'qualityRuns');
  const deepQuality = minimumModeCount(summary, 'deep', 'qualityRuns');
  const limitations = [
    ...translatedCaveats(summary),
    '结果只代表本次只读、脱敏快照与获批真值集，不能直接外推到其他知识库、模型或长期运行。',
    '配对 Bootstrap 只描述当前成对样本的不确定性；区间跨越或接触 0 不等于两系统完全相同。',
    '时延受云端负载和本地资源波动影响，p50/p95 仅代表本次固定交错顺序的观测。',
    '回答质量表只统计成功且可仲裁的首轮运行；失败、超时和重试另计入可靠性指标。',
    'Normal 与 Deep 结果分开统计，Deep 不改写 Normal 的主推荐。',
    '本轮没有评测 vLLM、GPU 容器或 NVIDIA Container Toolkit，不得由此报告推断其性能。',
  ];
  if (
    datasetQuestions !== null && normalQuality !== null && normalQuality < datasetQuestions
  ) {
    limitations.push(
      `Normal 每个系统最少只有 ${number(normalQuality, 0)}/${number(datasetQuestions, 0)} ` +
      '道首轮质量题，属于预算或执行约束下的部分样本。',
    );
  }
  if (deepQuality !== null && datasetQuestions !== null && deepQuality < datasetQuestions) {
    limitations.push(
      `Deep 每个系统最少覆盖 ${number(deepQuality, 0)}/${number(datasetQuestions, 0)} ` +
      '道首轮质量题，只能作为复杂题子集的补充观察。',
    );
  }
  return [...new Set(limitations)];
}

/**
 * Build a conservative recommendation from aggregate-only fields. Normal is
 * authoritative; Deep is a separate observation and never changes the winner.
 */
export function deriveBenchmarkNarrative(input) {
  const summary = assertAnonymousReport(input);
  const normal = qualityConclusion(summary, 'normal');
  const deep = qualityConclusion(summary, 'deep');
  let status = normal.status;
  let recommendedSystem = null;
  let headline;
  let basis = [...normal.basis];
  if (normal.status === 'clear') {
    recommendedSystem = normal.winner;
    headline = `在本次评测范围内，建议优先选择 ${recommendedSystem}；主要依据是 Normal 核心质量的配对置信区间。`;
  } else if (normal.status === 'no-clear-difference') {
    const efficiency = efficiencyConclusion(summary);
    status = efficiency.status === 'pareto' ? 'efficiency-tiebreak' : efficiency.status;
    basis = [...basis, ...efficiency.basis];
    if (efficiency.status === 'pareto') {
      recommendedSystem = efficiency.winner;
      headline = `Normal 核心质量未见明确差异；${recommendedSystem} ` +
        '在每个正确答案成本和 p50 总时延上均不劣，因此作为效率优先的推荐。';
    } else if (efficiency.status === 'tradeoff') {
      headline = '质量未见明确差异，但成本与时延分别倾向不同系统；本报告不给出单一推荐。';
    } else if (efficiency.status === 'tie') {
      headline = '质量未见明确差异，每个正确答案成本和 p50 时延也相同；本报告不给出单一推荐。';
    } else {
      headline = '质量未见明确差异，正确答案成本或 p50 时延数据不足以完成效率破平；暂不推荐单一系统。';
    }
  } else if (normal.status === 'tradeoff') {
    headline = '核心质量指标存在相反结论；本报告保留权衡，不用成本或时延覆盖质量冲突。';
  } else {
    headline = '核心质量的完整配对数据不足，暂不判定哪个系统更好。';
  }
  return {
    status,
    recommendedSystem,
    headline,
    basis,
    modeFindings: [normal.text, deep.text],
    limitations: derivedLimitations(summary),
  };
}

function modeTables(summary, mode) {
  return [
    {
      title: '回答正确性与完整性',
      headers: [
        '系统', '可仲裁题数', '问题准确率', '事实 Precision', '事实 Recall',
        '事实 F1', '答案完整率', '不可回答正确拒答率',
      ],
      rows: answerQualityRows(summary, mode),
    },
    {
      title: '引用质量与风险',
      headers: [
        '系统', '引用 Precision', '引用 Recall', '无效引用率', '幻觉率', '矛盾事实率',
      ],
      rows: answerEvidenceRows(summary, mode),
    },
    {
      title: '检索指标 @k',
      headers: ['系统', 'k', 'Accuracy', 'Precision', 'Recall', 'F1'],
      rows: retrievalAtKRows(summary, mode),
    },
    {
      title: '检索排序与证据指标',
      headers: [
        '系统', '检索题数', '可回答题数', 'MRR@12', 'MAP@12', 'nDCG@12', '精确行命中率', '证据段召回率',
        '重复逻辑文档占位率', '不可回答错误召回率',
      ],
      rows: rankingRows(summary, mode),
    },
    {
      title: 'Token 与成本',
      headers: [
        '系统', 'Usage 请求', '普通输入', '缓存读取', '缓存创建', '总输入', '输出', '总 Token',
        '估算费用', '正确答案 Token', '正确答案费用', '正确事实 Token', '正确事实费用',
      ],
      rows: tokenRows(summary, mode),
    },
    {
      title: '调用量与可靠性',
      headers: [
        '系统', '成功/运行', '首轮质量运行', '性能重复运行', '成功率', '超时率', '模型调用', 'Agent 轮数',
        '工具调用', 'Embedding 请求', 'Rerank 请求', '重试数', '重试率',
        'API 错误数', 'API 错误率',
      ],
      rows: operationRows(summary, mode),
    },
    {
      title: '延迟与生成速度（均值 / p50 / p95）',
      headers: [
        '系统', '索引构建', '检索', 'TTFT', '流式生成', '总耗时', '输出 Token/s',
      ],
      rows: latencyRows(summary, mode),
    },
    {
      title: '脱敏失败类型',
      headers: ['系统', '失败类型', '次数'],
      rows: errorRows(summary, mode),
    },
    {
      title: '配对 Bootstrap 95% 置信区间',
      headers: ['比较（前者减后者）', '指标', '均值差', '95% CI', '成对题数'],
      rows: ciRows(summary, mode),
    },
  ];
}

function translatedCaveats(summary) {
  return (summary.benchmark.caveats || []).map((caveat) => CAVEAT_TRANSLATIONS[caveat] || caveat);
}

function setupRows(summary) {
  const benchmark = summary.benchmark;
  const model = benchmark.modelConfiguration || {};
  const pricing = benchmark.pricingCnyPerMillionTokens || {};
  const budget = benchmark.budget || {};
  const budgetStatus = benchmark.budgetStatus || {};
  const rows = [
    ['评测题数', number(benchmark.datasetQuestions, 0)],
    ['匿名系统数', number(summary.systems.length, 0)],
    ['模型', model.model || '—'],
    ['推理强度 / 温度 / 最大输出', `${model.anthropic?.output_config?.effort || '—'} / ${number(model.temperature, 1)} / ${number(model.maxOutputTokens, 0)}`],
    ['Web Search / 会话隔离', `${model.webSearch === false ? '关闭' : '—'} / ${model.freshSessionPerQuestion === true ? '每题新会话' : '—'}`],
    ['检索 k', (benchmark.kValues || []).join(', ') || '—'],
    ['输入 / 输出公开单价', `${currency(pricing.inputPerMillion)} / ${currency(pricing.outputPerMillion)}（每百万 Token）`],
    ['软停止 / 硬预算', `${currency(budget.startLimitCny)} / ${currency(budget.hardLimitCny)}`],
    ['快照摘要', String(benchmark.snapshotManifestSha256 || '').slice(0, 16)],
  ];
  if (finite(budgetStatus.actualCny) !== null) {
    rows.splice(rows.length - 1, 0, [
      '已结算 / 硬预算剩余',
      `${currency(budgetStatus.actualCny)} / ${currency(budgetStatus.remainingHardLimitCny)}`,
    ]);
  }
  return rows;
}

/** Render aggregate-only Chinese Markdown. No per-question rows are consumed. */
export function renderBenchmarkMarkdown(input) {
  const summary = assertAnonymousReport(input);
  const narrative = deriveBenchmarkNarrative(summary);
  const lines = [
    '# 迁移前 Agent 与迁移后 RAG Benchmark 报告',
    '',
    `生成时间：${markdownEscape(summary.generatedAt)}`,
    '',
    '> 本报告仅展示匿名系统代号和聚合指标；不包含私人问题、笔记路径、答案或模型原始输出。',
    '',
    '## 评测设置',
    '',
    markdownTable(['项目', '配置'], setupRows(summary)),
    '',
    '## 阅读方法',
    '',
    '- 回答准确率、事实 F1、Recall、MRR、MAP 和 nDCG 越高越好。',
    '- 幻觉率、矛盾率、费用和延迟越低越好。',
    '- 配对 Bootstrap 采用“前者减后者”；95% CI 跨越 0 时，不宜断言存在明确差异。',
    '',
    '## 自动结论与建议',
    '',
    `> ${markdownEscape(narrative.headline)}`,
    '',
    ...narrative.modeFindings.map((finding) => `- ${markdownEscape(finding)}`),
  ];
  if (narrative.basis.length) {
    lines.push('', '### 判定依据', '', ...narrative.basis.map((item) => `- ${markdownEscape(item)}`));
  }
  for (const mode of ['normal', 'deep']) {
    lines.push('', `## ${MODE_LABELS[mode]}`, '');
    const tables = modeTables(summary, mode);
    if (!tables.some((table) => table.rows.length)) {
      lines.push('本轮未执行该模式，暂无可比较结果。');
      continue;
    }
    for (const table of tables) {
      if (!table.rows.length) continue;
      lines.push(`### ${table.title}`, '', markdownTable(table.headers, table.rows), '');
    }
  }
  lines.push(
    '## 局限与结论边界',
    '',
    ...narrative.limitations.map((caveat) => `- ${markdownEscape(caveat)}`),
    '- 匿名报告不提供系统代号与真实实现的映射；映射仅保留在受控私有记录中。',
    '- 本报告只根据已完成且通过完整性校验的运行计算指标。',
    '',
  );
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderModeHtml(summary, mode) {
  const tables = modeTables(summary, mode);
  const contents = tables.filter((table) => table.rows.length)
    .map((table) => htmlTable(table.title, table.headers, table.rows)).join('\n');
  return `<section class="mode-section">
    <h2>${htmlEscape(MODE_LABELS[mode])}</h2>
    ${contents || '<p class="empty">本轮未执行该模式，暂无可比较结果。</p>'}
  </section>`;
}

/** Render a self-contained HTML document with no scripts or external assets. */
export function renderBenchmarkHtml(input) {
  const summary = assertAnonymousReport(input);
  const narrative = deriveBenchmarkNarrative(summary);
  const caveats = [
    ...narrative.limitations,
    '匿名报告不提供系统代号与真实实现的映射。',
    '本报告只根据已完成且通过完整性校验的运行计算指标。',
  ];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>迁移前 Agent 与迁移后 RAG Benchmark 报告</title>
  <style>
    :root { --ink:#18212f; --muted:#637083; --line:#dce2ea; --accent:#2456a6; --soft:#f3f6fa; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:#fff; font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif; font-size:12px; line-height:1.55; }
    main { max-width:1120px; margin:0 auto; padding:42px 48px 56px; }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:.02em; }
    h2 { margin:30px 0 14px; padding-bottom:7px; border-bottom:2px solid var(--accent); font-size:20px; }
    h3 { margin:18px 0 8px; font-size:14px; }
    p { margin:7px 0; }
    .meta { color:var(--muted); }
    .privacy { margin:18px 0 22px; padding:12px 15px; border-left:4px solid var(--accent); background:var(--soft); }
    .decision { margin:16px 0 22px; padding:14px 16px; border:1px solid #b8c8df; border-radius:6px; background:#f7f9fc; break-inside:avoid; }
    .decision strong { color:#173f7a; font-size:14px; }
    .decision ul { margin-bottom:0; }
    .table-wrap { overflow:hidden; border:1px solid var(--line); border-radius:5px; }
    table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
    th, td { padding:7px 8px; border-right:1px solid var(--line); border-bottom:1px solid var(--line); text-align:right; vertical-align:top; }
    th:first-child, td:first-child { text-align:left; }
    th:last-child, td:last-child { border-right:0; }
    tbody tr:last-child td { border-bottom:0; }
    th { background:var(--soft); color:#304057; font-weight:650; }
    .metric-block { break-inside:avoid; }
    .empty { color:var(--muted); font-style:italic; }
    ul { margin:8px 0; padding-left:20px; }
    footer { margin-top:32px; padding-top:10px; border-top:1px solid var(--line); color:var(--muted); font-size:10px; }
    @page { size:A4 landscape; margin:12mm; }
    @media print { main { max-width:none; padding:0; } h2 { break-after:avoid; } }
  </style>
</head>
<body>
<main>
  <header>
    <h1>迁移前 Agent 与迁移后 RAG Benchmark 报告</h1>
    <p class="meta">生成时间：${htmlEscape(summary.generatedAt)}</p>
    <p class="privacy">本报告仅展示匿名系统代号和聚合指标；不包含私人问题、笔记路径、答案或模型原始输出。</p>
  </header>
  <section>
    <h2>评测设置</h2>
    ${htmlTable('固定配置', ['项目', '配置'], setupRows(summary))}
  </section>
  <section>
    <h2>阅读方法</h2>
    <ul>
      <li>回答准确率、事实 F1 与检索排序指标越高越好。</li>
      <li>幻觉率、矛盾率、费用与延迟越低越好。</li>
      <li>95% CI 跨越 0 时，不宜断言存在明确差异。</li>
    </ul>
  </section>
  <section>
    <h2>自动结论与建议</h2>
    <div class="decision">
      <p><strong>${htmlEscape(narrative.headline)}</strong></p>
      <ul>${narrative.modeFindings.map((finding) => `<li>${htmlEscape(finding)}</li>`).join('')}</ul>
    </div>
    ${narrative.basis.length ? `<h3>判定依据</h3><ul>${narrative.basis.map((item) => (
      `<li>${htmlEscape(item)}</li>`
    )).join('')}</ul>` : ''}
  </section>
  ${renderModeHtml(summary, 'normal')}
  ${renderModeHtml(summary, 'deep')}
  <section>
    <h2>局限与结论边界</h2>
    <ul>${caveats.map((caveat) => `<li>${htmlEscape(caveat)}</li>`).join('')}</ul>
  </section>
  <footer>匿名聚合报告 · Normal / Deep 分开统计 · 费用为估算值</footer>
</main>
</body>
</html>`;
}

function safeBasename(value) {
  const input = String(value || DEFAULT_BENCHMARK_REPORT_BASENAME).normalize('NFC');
  if (!input || input.length > 160 || /[\/\\\0]/.test(input) || input === '.' || input === '..') {
    fail('Report basename is unsafe.', 'UNSAFE_REPORT_BASENAME');
  }
  return input;
}

async function fileDigest(filename) {
  const content = await fsp.readFile(filename);
  return {
    bytes: content.byteLength,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

async function writeFileNoSymlink(filename, content) {
  const existing = await fsp.lstat(filename).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    fail('Report target is not a regular file.', 'UNSAFE_REPORT_TARGET');
  }
  await fsp.writeFile(filename, content, { encoding: 'utf8', mode: 0o600 });
  await fsp.chmod(filename, 0o600);
}

/**
 * Write Markdown and self-contained HTML, then ask an injected renderer to
 * print the HTML to PDF. The callback receives no summary object.
 */
export async function generateBenchmarkReport(options = {}) {
  const summary = assertAnonymousReport(options.summary);
  if (typeof options.chromeRunner !== 'function') {
    fail('A chromeRunner function is required.', 'CHROME_RUNNER_REQUIRED');
  }
  const outputDir = path.resolve(String(options.outputDir || 'reports'));
  const basename = safeBasename(options.basename);
  await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const directory = await fsp.lstat(outputDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    fail('Report output directory is unsafe.', 'UNSAFE_REPORT_TARGET');
  }
  const markdownPath = path.join(outputDir, `${basename}.md`);
  const htmlPath = path.join(outputDir, `${basename}.html`);
  const pdfPath = path.join(outputDir, `${basename}.pdf`);
  const markdown = renderBenchmarkMarkdown(summary);
  const html = renderBenchmarkHtml(summary);
  await writeFileNoSymlink(markdownPath, `${markdown}\n`);
  await writeFileNoSymlink(htmlPath, html);
  const priorPdf = await fsp.lstat(pdfPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (priorPdf?.isSymbolicLink() || (priorPdf && !priorPdf.isFile())) {
    fail('PDF target is not a regular file.', 'UNSAFE_REPORT_TARGET');
  }
  let chromeResult;
  try {
    chromeResult = await options.chromeRunner({
      htmlPath,
      pdfPath,
      printOptions: Object.freeze({
        format: 'A4',
        landscape: true,
        printBackground: true,
        preferCSSPageSize: true,
      }),
    });
  } catch (error) {
    fail('Chrome failed to generate the anonymous PDF.', 'PDF_RENDER_FAILED', error);
  }
  const pdf = await fsp.lstat(pdfPath).catch(() => null);
  if (!pdf?.isFile() || pdf.isSymbolicLink() || pdf.size <= 0) {
    fail('Chrome did not create a non-empty regular PDF.', 'PDF_OUTPUT_MISSING');
  }
  await fsp.chmod(pdfPath, 0o600);
  const [markdownInfo, htmlInfo, pdfInfo] = await Promise.all([
    fileDigest(markdownPath),
    fileDigest(htmlPath),
    fileDigest(pdfPath),
  ]);
  return {
    basename,
    markdown: { path: markdownPath, ...markdownInfo },
    html: { path: htmlPath, ...htmlInfo, selfContained: true },
    pdf: {
      path: pdfPath,
      ...pdfInfo,
      pageCount: Number.isInteger(chromeResult?.pageCount) ? chromeResult.pageCount : null,
    },
    containsPrivateQuestionsPathsAnswersOrRawOutput: false,
  };
}
