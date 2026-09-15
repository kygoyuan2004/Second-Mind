import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_BENCHMARK_REPORT_BASENAME,
  deriveBenchmarkNarrative,
  generateBenchmarkReport,
  renderBenchmarkHtml,
  renderBenchmarkMarkdown,
} from '../scripts/lib/benchmark-report-renderer.mjs';

const CAVEATS = Object.freeze([
  'Accuracy@k is auxiliary because true negatives dominate large document collections.',
  'Answer metrics require approved human or deterministic adjudication counts.',
  'Prices are estimates; the provider invoice is authoritative.',
]);

function latency(mean) {
  return { count: 48, mean, p50: mean - 2, p95: mean + 10, min: mean - 5, max: mean + 20 };
}

function modeSummary(offset = 0) {
  return {
    runs: 48,
    qualityRuns: 48,
    repeatedPerformanceRuns: 0,
    successfulRuns: 47,
    successRate: 47 / 48,
    timeoutRate: 1 / 48,
    retryCount: 2,
    retryRate: 0.02,
    apiErrorCount: 1,
    apiErrorRate: 0.01,
    errorCounts: { TASK_TIMEOUT: 1 },
    retrieval: {
      questions: 48,
      answerableQuestions: 44,
      byK: {
        1: { accuracy: 0.9, precision: 0.8 + offset, recall: 0.4, f1: 0.53 },
        3: { accuracy: 0.92, precision: 0.7, recall: 0.7 + offset, f1: 0.7 },
        5: { accuracy: 0.93, precision: 0.6, recall: 0.8, f1: 0.69 },
        8: { accuracy: 0.94, precision: 0.5, recall: 0.9, f1: 0.64 },
        12: { accuracy: 0.95, precision: 0.4, recall: 0.95, f1: 0.56 + offset },
      },
      meanReciprocalRank: 0.82 + offset,
      meanAveragePrecision: 0.75 + offset,
      meanNdcg: 0.8 + offset,
      exactLineHitRate: 0.7,
      evidenceSegmentRecall: 0.84,
      duplicateLogicalOccupancyRate: 0.03,
      unanswerableFalseRetrievalRate: 0.1,
      perQuestion: [],
    },
    answers: {
      evaluatedQuestions: 48,
      questionAccuracy: 0.8 + offset,
      factPrecision: 0.86,
      factRecall: 0.83,
      factF1: 0.845 + offset,
      answerCompleteness: 0.83,
      citationPrecision: 0.9,
      citationRecall: 0.85,
      invalidCitationRate: 0.1,
      hallucinationRate: 0.04 - offset,
      contradictionRate: 0.01,
      unanswerableCorrectRefusalRate: 0.75,
    },
    usage: {
      requests: 48,
      standardInputTokens: 100_000,
      cacheReadInputTokens: 20_000,
      cacheCreationInputTokens: 10_000,
      outputTokens: 12_000,
      totalInputTokens: 130_000,
      totalTokens: 142_000,
    },
    estimatedCostCny: 2.4 + offset,
    tokensPerCorrectAnswer: 3_500,
    costPerCorrectAnswerCny: 0.06,
    tokensPerCorrectFact: 1_500,
    costPerCorrectFactCny: 0.03,
    modelCalls: 48,
    agentTurns: 60,
    toolCalls: 40,
    embeddingRequests: 48,
    rerankRequests: 0,
    outputTokensPerSecond: 42,
    latency: {
      indexBuildMs: latency(120),
      retrievalMs: latency(35),
      timeToFirstTokenMs: latency(500),
      generationMs: latency(900),
      totalMs: latency(1_600),
    },
  };
}

function interval(meanDifference) {
  return {
    pairedQuestions: 48,
    meanDifference,
    lower95: meanDifference - 0.02,
    upper95: meanDifference + 0.02,
    iterations: 10_000,
    seed: 20260831,
  };
}

function syntheticSummary() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-31T08:00:00.000Z',
    benchmark: {
      datasetQuestions: 48,
      snapshotManifestSha256: 'a'.repeat(64),
      kValues: [1, 3, 5, 8, 12],
      pricingCnyPerMillionTokens: {
        inputPerMillion: 12,
        outputPerMillion: 36,
        cacheReadPerMillion: 1.5,
        cacheCreationPerMillion: 15,
      },
      budget: { hardLimitCny: 100, startLimitCny: 90 },
      modelConfiguration: {
        model: 'qwen3.8-max',
        temperature: 0,
        maxOutputTokens: 3_000,
        anthropic: {
          temperature: 0,
          max_tokens: 3_000,
          output_config: { effort: 'medium' },
        },
        openaiChat: {
          temperature: 0,
          max_tokens: 3_000,
          reasoning_effort: 'medium',
        },
        webSearch: false,
        freshSessionPerQuestion: true,
      },
      caveats: [...CAVEATS],
    },
    systems: [
      {
        anonymousSystem: 'System-A',
        runs: 56,
        successfulRuns: 55,
        successRate: 55 / 56,
        timeoutRate: 1 / 56,
        retryCount: 2,
        usage: modeSummary().usage,
        estimatedCostCny: 3.2,
        modes: { normal: modeSummary(), deep: modeSummary(0.01) },
      },
      {
        anonymousSystem: 'System-B',
        runs: 56,
        successfulRuns: 56,
        successRate: 1,
        timeoutRate: 0,
        retryCount: 0,
        usage: modeSummary(0.02).usage,
        estimatedCostCny: 2.1,
        modes: { normal: modeSummary(0.02), deep: modeSummary(0.03) },
      },
    ],
    comparisons: [{
      systems: ['System-A', 'System-B'],
      difference: 'first system minus second system',
      pairedBootstrap95: {
        normal: {
          questionAccuracy: interval(-0.02),
          factF1: interval(-0.02),
          hallucinationRate: interval(0.02),
          retrievalF1At12: interval(-0.02),
          estimatedCostCny: interval(0.03),
          totalMs: interval(150),
        },
        deep: {
          questionAccuracy: interval(-0.02),
          factF1: interval(-0.02),
          hallucinationRate: interval(0.02),
          retrievalF1At12: interval(-0.02),
          estimatedCostCny: interval(0.04),
          totalMs: interval(250),
        },
      },
    }],
  };
}

test('renders concise Chinese aggregate Markdown and self-contained HTML by mode', () => {
  const summary = syntheticSummary();
  for (const system of summary.systems) system.modes.deep.qualityRuns = 8;
  summary.systems[0].modes.normal.answers.citationPrecision = null;
  summary.systems[0].modes.normal.retrieval.perQuestion = [{
    questionId: 'Question-001',
    metrics: { accuracy: 1 },
  }];
  const markdown = renderBenchmarkMarkdown(summary);
  const html = renderBenchmarkHtml(summary);

  for (const required of [
    '自动结论与建议', 'Normal 模式', 'Deep 模式', '回答正确性与完整性',
    '引用质量与风险', '事实 Precision', '事实 Recall', '引用 Precision',
    '无效引用率', '检索指标 @k', 'Token 与成本', '正确答案 Token',
    '调用量与可靠性', '模型调用', 'Agent 轮数', 'Embedding 请求',
    '超时率', '延迟与生成速度（均值 / p50 / p95）', '脱敏失败类型',
    '任务超时', 'Bootstrap 95% 置信区间', '局限与结论边界',
    'Deep 每个系统最少覆盖 8/48', 'vLLM',
  ]) {
    assert.ok(markdown.includes(required), required);
    assert.ok(html.includes(required), required);
  }
  assert.match(markdown, /System-A/);
  assert.match(markdown, /System-B/);
  assert.match(markdown, /\| System-A \| — \| 85\.0%/);
  assert.doesNotMatch(markdown, /Q001|Question-001|private question|note\.md|raw output/i);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /<script|\s(?:src|href)=|https?:\/\//i);
  assert.doesNotMatch(html, /Q001|Question-001|private question|note\.md|raw output/i);
});

test('automatic recommendation prioritizes Normal paired quality and keeps Deep separate', () => {
  const summary = syntheticSummary();
  const normal = summary.comparisons[0].pairedBootstrap95.normal;
  normal.questionAccuracy = interval(-0.05);
  normal.factF1 = interval(-0.04);
  normal.hallucinationRate = interval(0.05);
  const deep = summary.comparisons[0].pairedBootstrap95.deep;
  deep.questionAccuracy = interval(0.05);
  deep.factF1 = interval(0.04);
  deep.hallucinationRate = interval(-0.05);

  const narrative = deriveBenchmarkNarrative(summary);
  assert.equal(narrative.status, 'clear');
  assert.equal(narrative.recommendedSystem, 'System-B');
  assert.match(narrative.headline, /System-B/);
  assert.match(narrative.modeFindings[0], /System-B/);
  assert.match(narrative.modeFindings[1], /System-A/);
  assert.match(renderBenchmarkMarkdown(summary), /建议优先选择 System-B/);
});

test('automatic recommendation uses cost and p50 only after quality intervals are inconclusive', () => {
  const summary = syntheticSummary();
  const normal = summary.comparisons[0].pairedBootstrap95.normal;
  normal.questionAccuracy = interval(0);
  normal.factF1 = interval(0);
  normal.hallucinationRate = interval(0);
  summary.systems[0].modes.normal.costPerCorrectAnswerCny = 0.08;
  summary.systems[1].modes.normal.costPerCorrectAnswerCny = 0.04;
  summary.systems[0].modes.normal.latency.totalMs.p50 = 1_600;
  summary.systems[1].modes.normal.latency.totalMs.p50 = 1_200;

  const narrative = deriveBenchmarkNarrative(summary);
  assert.equal(narrative.status, 'efficiency-tiebreak');
  assert.equal(narrative.recommendedSystem, 'System-B');
  assert.match(narrative.headline, /成本和 p50 总时延/);
  assert.equal(narrative.basis.length, 2);
});

test('automatic recommendation refuses to hide conflicting core-quality results', () => {
  const summary = syntheticSummary();
  const normal = summary.comparisons[0].pairedBootstrap95.normal;
  normal.questionAccuracy = interval(0.05);
  normal.factF1 = interval(-0.05);
  normal.hallucinationRate = interval(0);
  summary.systems[0].modes.normal.costPerCorrectAnswerCny = 0.02;
  summary.systems[0].modes.normal.latency.totalMs.p50 = 900;

  const narrative = deriveBenchmarkNarrative(summary);
  assert.equal(narrative.status, 'tradeoff');
  assert.equal(narrative.recommendedSystem, null);
  assert.match(narrative.headline, /不用成本或时延覆盖质量冲突/);
});

test('automatic recommendation does not use efficiency when a core-quality CI is missing', () => {
  const summary = syntheticSummary();
  delete summary.comparisons[0].pairedBootstrap95.normal.factF1;
  summary.systems[1].modes.normal.costPerCorrectAnswerCny = 0.001;
  summary.systems[1].modes.normal.latency.totalMs.p50 = 1;

  const narrative = deriveBenchmarkNarrative(summary);
  assert.equal(narrative.status, 'insufficient');
  assert.equal(narrative.recommendedSystem, null);
  assert.match(narrative.headline, /完整配对数据不足/);
  assert.equal(narrative.basis.length, 0);
});

test('writes default Markdown/HTML names and delegates PDF creation to injected chromeRunner',
  async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'benchmark-report-renderer-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const calls = [];
    const result = await generateBenchmarkReport({
      summary: syntheticSummary(),
      outputDir: root,
      chromeRunner: async (request) => {
        calls.push({ ...request });
        assert.match(await fsp.readFile(request.htmlPath, 'utf8'), /System-A/);
        await fsp.writeFile(request.pdfPath, Buffer.from('%PDF-1.4\nsynthetic fixture\n'));
        return { pageCount: 4 };
      },
    });

    assert.equal(result.basename, DEFAULT_BENCHMARK_REPORT_BASENAME);
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]).sort(), ['htmlPath', 'pdfPath', 'printOptions']);
    assert.equal(calls[0].printOptions.format, 'A4');
    assert.equal(calls[0].printOptions.landscape, true);
    assert.equal(result.pdf.pageCount, 4);
    assert.equal(result.html.selfContained, true);
    assert.equal(result.containsPrivateQuestionsPathsAnswersOrRawOutput, false);
    for (const extension of ['md', 'html', 'pdf']) {
      const filename = path.join(root, `${DEFAULT_BENCHMARK_REPORT_BASENAME}.${extension}`);
      assert.equal((await fsp.stat(filename)).isFile(), true);
      assert.ok((await fsp.stat(filename)).size > 0);
    }
    for (const artifact of [result.markdown, result.html, result.pdf]) {
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      assert.ok(artifact.bytes > 0);
    }
  });

test('private leakage is rejected before output directory creation or Chrome invocation', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'benchmark-report-guard-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'must-not-exist');
  const summary = syntheticSummary();
  summary.benchmark.caveats[0] = ['', 'home', 'example', 'Private Vault', 'note.md'].join('/');
  let chromeCalls = 0;
  await assert.rejects(() => generateBenchmarkReport({
    summary,
    outputDir: target,
    chromeRunner: async () => { chromeCalls += 1; },
  }), { code: 'PRIVATE_DATA_IN_REPORT' });
  assert.equal(chromeCalls, 0);
  await assert.rejects(fsp.stat(target), (error) => error.code === 'ENOENT');
});

test('Chrome is mandatory and an unsafe custom basename is rejected', async () => {
  await assert.rejects(() => generateBenchmarkReport({
    summary: syntheticSummary(),
  }), { code: 'CHROME_RUNNER_REQUIRED' });
  await assert.rejects(() => generateBenchmarkReport({
    summary: syntheticSummary(),
    basename: '../private',
    chromeRunner: async () => {},
  }), { code: 'UNSAFE_REPORT_BASENAME' });
});
