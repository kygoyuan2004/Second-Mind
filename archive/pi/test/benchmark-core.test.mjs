import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BenchmarkValidationError,
  BudgetGate,
  FAIR_MODEL_CONFIGURATION,
  accumulateUsage,
  aggregateAnswers,
  assertAnonymousReport,
  deduplicateResults,
  estimateCostCny,
  latencySummary,
  logicalDocumentKey,
  pairedBootstrap,
  retrievalMetrics,
  sha256,
  summarizeOfflineResults,
  validateDataset,
  verifySnapshot,
} from '../scripts/lib/benchmark-core.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SYNTHETIC_EVIDENCE_SHA256 = 'f'.repeat(64);

function evidence(pathValue, startLine, endLine, textSha256 = SYNTHETIC_EVIDENCE_SHA256) {
  return {
    ...(pathValue ? { path: pathValue } : {}),
    startLine,
    endLine,
    textSha256,
  };
}

function approvedItem(overrides = {}) {
  return {
    id: 'Q001',
    category: 'exact_fact',
    query: '测试事实是什么？',
    answerable: true,
    goldAnswer: '事实一和事实二。',
    goldFacts: [
      {
        id: 'F1',
        text: '事实一',
        evidence: [evidence('notes/topic.md', 2, 3)],
      },
      {
        id: 'F2',
        text: '事实二',
        evidence: [evidence('notes/other.md', 8, 9)],
      },
    ],
    relevant: [
      {
        path: 'notes/topic.md',
        grade: 3,
        evidence: [evidence('', 2, 3)],
      },
      {
        path: 'notes/other.md',
        grade: 1,
        evidence: [evidence('', 8, 9)],
      },
    ],
    review: { status: 'approved' },
    ...overrides,
  };
}

function datasetFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    reviewStatus: 'approved',
    executionAllowed: true,
    snapshot: {
      manifestSha256: 'a'.repeat(64),
      fileCount: 5,
      logicalDocumentCount: 5,
    },
    items: [approvedItem()],
    ...overrides,
  };
}

test('strict dataset validation rejects pending approval, unsafe evidence, and wrong plan shape', () => {
  const valid = validateDataset(datasetFixture(), { enforcePlan: false, requireApproved: true });
  assert.equal(valid.items[0].goldFacts.length, 2);
  assert.equal(valid.executionAllowed, true);
  assert.throws(
    () => validateDataset(datasetFixture({ executionAllowed: undefined }), { enforcePlan: false }),
    (error) => error.details.some((detail) => detail.includes('executionAllowed must be boolean')),
  );
  assert.throws(
    () => validateDataset(datasetFixture({ reviewStatus: 'draft', executionAllowed: true }), {
      enforcePlan: false,
    }),
    (error) => error.details.some((detail) => detail.includes('executionAllowed=false')),
  );
  assert.throws(
    () => validateDataset(datasetFixture({ executionAllowed: false }), {
      enforcePlan: false,
      requireApproved: true,
    }),
    (error) => error.details.some((detail) => detail.includes('does not allow execution')),
  );
  assert.throws(
    () => validateDataset(datasetFixture({
      reviewStatus: 'draft',
      executionAllowed: false,
    }), {
      enforcePlan: false,
      requireApproved: true,
    }),
    (error) => error instanceof BenchmarkValidationError &&
      error.code === 'INVALID_BENCHMARK_DATASET' &&
      error.details.some((detail) => detail.includes('dataset-level')),
  );
  const unsafe = datasetFixture({
    items: [approvedItem({
      relevant: [{ path: '../private.md', grade: 3, evidence: [evidence('', 1, 1)] }],
    })],
  });
  assert.throws(() => validateDataset(unsafe, { enforcePlan: false }), /validation failed/);
  assert.throws(
    () => validateDataset(datasetFixture()),
    (error) => error instanceof BenchmarkValidationError &&
      error.details.some((detail) => detail.includes('category')),
  );
});

test('logical document variants are collapsed before ranked retrieval metrics', () => {
  assert.equal(
    logicalDocumentKey('notes/topic（整理版）.md'),
    logicalDocumentKey('notes/topic.md'),
  );
  const physical = [
    { path: 'notes/topic（整理版）.md', lineStart: 2, lineEnd: 3 },
    { path: 'notes/topic.md', lineStart: 20, lineEnd: 21 },
    { path: 'notes/noise.md', lineStart: 1, lineEnd: 2 },
    { path: 'notes/other.md', lineStart: 20, lineEnd: 21 },
  ];
  assert.equal(deduplicateResults(physical).duplicateSlots, 1);
  const metrics = retrievalMetrics(approvedItem(), physical, {
    universeSize: 5,
    kValues: [1, 3],
  });
  assert.deepEqual(metrics.byK[1], {
    truePositive: 1,
    falsePositive: 0,
    falseNegative: 1,
    trueNegative: 3,
    accuracy: 0.8,
    precision: 1,
    recall: 0.5,
    f1: 2 / 3,
  });
  assert.equal(metrics.byK[3].precision, 1 / 3);
  assert.equal(metrics.byK[3].recall, 0.5);
  assert.equal(metrics.byK[3].f1, 0.4);
  assert.equal(metrics.reciprocalRank, 1);
  assert.equal(metrics.averagePrecision, 0.5);
  assert.ok(metrics.ndcg > 0 && metrics.ndcg <= 1);
  assert.equal(metrics.exactLineHit, true);
  assert.equal(metrics.evidenceSegmentRecall, 0.5);
  assert.equal(metrics.duplicateLogicalOccupancyRate, 1 / 3);
});

test('MRR, AP, and nDCG are truncated at the requested maximum k', () => {
  const results = Array.from({ length: 13 }, (_, index) => ({
    path: index === 12 ? 'notes/topic.md' : `notes/noise-${index}.md`,
  }));
  const metrics = retrievalMetrics(approvedItem({
    goldFacts: [approvedItem().goldFacts[0]],
    relevant: [approvedItem().relevant[0]],
  }), results, { universeSize: 20, kValues: [12] });
  assert.equal(metrics.reciprocalRank, 0);
  assert.equal(metrics.averagePrecision, 0);
  assert.equal(metrics.ndcg, 0);
});

test('queries with no relevant document avoid zero-division and track false retrieval', () => {
  const item = approvedItem({
    id: 'Q002',
    category: 'unanswerable',
    answerable: false,
    goldAnswer: '',
    goldFacts: [],
    relevant: [],
  });
  const metrics = retrievalMetrics(item, [{ path: 'noise.md' }], {
    universeSize: 5,
    kValues: [1],
  });
  assert.equal(metrics.byK[1].accuracy, 0.8);
  assert.equal(metrics.byK[1].precision, 0);
  assert.equal(metrics.byK[1].recall, null);
  assert.equal(metrics.byK[1].f1, null);
  assert.equal(metrics.averagePrecision, null);
  assert.equal(metrics.ndcg, null);
  assert.equal(metrics.falseRetrievalForUnanswerable, true);
});

test('latency summaries, usage normalization, price calculation, and budget gate are deterministic', () => {
  assert.deepEqual(latencySummary([100, 200, 300, 400]), {
    count: 4,
    mean: 250,
    p50: 250,
    p95: 385,
    min: 100,
    max: 400,
  });
  const usage = accumulateUsage([
    { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } },
    { usage: {
      input_tokens: 80,
      output_tokens: 20,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    } },
  ]);
  assert.deepEqual(usage, {
    requests: 2,
    standardInputTokens: 140,
    cacheReadInputTokens: 50,
    cacheCreationInputTokens: 5,
    outputTokens: 40,
    totalInputTokens: 195,
    totalTokens: 235,
  });
  assert.equal(estimateCostCny(usage, {
    inputPerMillion: 10,
    outputPerMillion: 20,
    cacheReadPerMillion: 1,
    cacheCreationPerMillion: 10,
  }), 0.0023);
  const gate = new BudgetGate();
  const reservation = gate.reserve(89.5);
  gate.settle(reservation, 89);
  assert.equal(gate.canStart(1), true);
  assert.throws(() => gate.reserve(2), (error) => error.code === 'BUDGET_START_LIMIT_REACHED');
});

test('runtime camelCase cache usage keeps standard input separate and charges each token class', () => {
  const usage = accumulateUsage([
    {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheCreationTokens: 5,
    },
  ]);
  assert.deepEqual(usage, {
    requests: 1,
    standardInputTokens: 100,
    cacheReadInputTokens: 40,
    cacheCreationInputTokens: 5,
    outputTokens: 20,
    totalInputTokens: 145,
    totalTokens: 165,
  });
  assert.equal(estimateCostCny(usage, {
    inputPerMillion: 10,
    outputPerMillion: 20,
    cacheReadPerMillion: 1,
    cacheCreationPerMillion: 12,
  }), 0.0015);
});

test('answer aggregation exposes fact, citation, hallucination, and refusal metrics', () => {
  const unanswerable = approvedItem({
    id: 'Q002',
    category: 'unanswerable',
    answerable: false,
    goldAnswer: '',
    goldFacts: [],
    relevant: [],
  });
  const dataset = validateDataset(datasetFixture({ items: [approvedItem(), unanswerable] }), {
    enforcePlan: false,
  });
  const summary = aggregateAnswers([
    {
      questionId: 'Q001',
      answerEvaluation: {
        questionCorrect: true,
        predictedFactCount: 3,
        supportedFactCount: 2,
        goldFactCount: 2,
        matchedGoldFactCount: 2,
        citationCount: 2,
        validCitationCount: 1,
        goldEvidenceCount: 2,
        citedGoldEvidenceCount: 1,
        hallucinatedFactCount: 1,
        contradictionCount: 0,
        refused: false,
      },
    },
    {
      questionId: 'Q002',
      answerEvaluation: {
        questionCorrect: true,
        predictedFactCount: 0,
        supportedFactCount: 0,
        goldFactCount: 0,
        matchedGoldFactCount: 0,
        citationCount: 0,
        validCitationCount: 0,
        goldEvidenceCount: 0,
        citedGoldEvidenceCount: 0,
        hallucinatedFactCount: 0,
        contradictionCount: 0,
        refused: true,
      },
    },
  ], dataset);
  assert.equal(summary.questionAccuracy, 1);
  assert.equal(summary.factPrecision, 0.666667);
  assert.equal(summary.factRecall, 1);
  assert.equal(summary.citationPrecision, 0.5);
  assert.equal(summary.hallucinationRate, 0.333333);
  assert.equal(summary.unanswerableCorrectRefusalRate, 1);
});

test('paired bootstrap is seeded and reports the paired direction', () => {
  assert.deepEqual(
    pairedBootstrap([3, 4, 5], [1, 2, 3], { iterations: 1_000, seed: 7 }),
    {
      meanDifference: 2,
      lower95: 2,
      upper95: 2,
      iterations: 1_000,
      seed: 7,
    },
  );
});

async function snapshotFixture(t) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultmind-benchmark-'));
  const workspace = path.join(temporary, 'workspace');
  const snapshot = path.join(workspace, 'snapshot');
  const note = path.join(snapshot, 'note.md');
  await fsp.mkdir(snapshot, { recursive: true, mode: 0o700 });
  const content = Buffer.from('# Fixture\n\nA public synthetic fact.\n');
  await fsp.writeFile(note, content, { mode: 0o600 });
  const manifest = Buffer.from(`${sha256(content)}  ./note.md\n`);
  const manifestFile = path.join(workspace, 'snapshot.sha256');
  await fsp.writeFile(manifestFile, manifest, { mode: 0o600 });
  await fsp.chmod(note, 0o400);
  await fsp.chmod(snapshot, 0o500);
  t.after(async () => {
    await fsp.chmod(snapshot, 0o700).catch(() => {});
    await fsp.chmod(note, 0o600).catch(() => {});
    await fsp.rm(temporary, { recursive: true, force: true });
  });
  return { temporary, workspace, snapshot, note, manifest, manifestFile };
}

test('snapshot validation pins the manifest root and detects any byte drift', async (t) => {
  const fixture = await snapshotFixture(t);
  const verified = await verifySnapshot({
    snapshotRoot: fixture.snapshot,
    manifestFile: fixture.manifestFile,
    expectedManifestSha256: sha256(fixture.manifest),
  });
  assert.equal(verified.fileCount, 1);
  assert.deepEqual(verified.paths, ['note.md']);
  await fsp.chmod(fixture.snapshot, 0o700);
  await fsp.chmod(fixture.note, 0o600);
  await fsp.writeFile(fixture.note, '# Drift\n');
  await fsp.chmod(fixture.note, 0o400);
  await fsp.chmod(fixture.snapshot, 0o500);
  await assert.rejects(
    verifySnapshot({
      snapshotRoot: fixture.snapshot,
      manifestFile: fixture.manifestFile,
      expectedManifestSha256: sha256(fixture.manifest),
    }),
    (error) => error.code === 'SNAPSHOT_VERIFICATION_FAILED',
  );
});

function offlineRecord() {
  return {
    questionId: 'Q001',
    status: 'success',
    retrieval: { results: [{ path: 'notes/topic.md', lineStart: 2, lineEnd: 3 }] },
    calls: [{ usage: { input_tokens: 1_000, output_tokens: 100 } }],
    timings: {
      indexBuildMs: 10,
      retrievalMs: 5,
      timeToFirstTokenMs: 50,
      generationMs: 100,
      totalMs: 155,
    },
    answerEvaluation: {
      questionCorrect: true,
      predictedFactCount: 2,
      supportedFactCount: 2,
      goldFactCount: 2,
      matchedGoldFactCount: 2,
      citationCount: 2,
      validCitationCount: 2,
      goldEvidenceCount: 2,
      citedGoldEvidenceCount: 2,
      hallucinatedFactCount: 0,
      contradictionCount: 0,
      refused: false,
    },
  };
}

test('offline result summary is aggregate-only and enforces the locked fair configuration', () => {
  const dataset = validateDataset(datasetFixture(), { enforcePlan: false });
  const input = {
    schemaVersion: 1,
    snapshotManifestSha256: dataset.snapshot.manifestSha256,
    configuration: FAIR_MODEL_CONFIGURATION,
    systems: [
      { id: 'original-agent', records: [offlineRecord()] },
      { id: 'migrated-rag', records: [offlineRecord()] },
    ],
  };
  const summary = summarizeOfflineResults(input, dataset, { generatedAt: '2026-08-31T00:00:00.000Z' });
  assert.deepEqual(summary.private.systemMapping, {
    'System-A': 'original-agent',
    'System-B': 'migrated-rag',
  });
  assert.equal(summary.anonymous.systems[0].usage.totalTokens, 1_100);
  assert.equal(summary.anonymous.systems[0].modes.normal.answers.questionAccuracy, 1);
  assert.equal(summary.anonymous.systems[0].modes.normal.tokensPerCorrectFact, 550);
  assert.equal(
    summary.anonymous.comparisons[0].pairedBootstrap95.normal.questionAccuracy.meanDifference,
    0,
  );
  assert.equal(
    summary.anonymous.systems[0].modes.normal.retrieval.perQuestion[0].questionId,
    'Question-001',
  );
  const anonymousJson = JSON.stringify(summary.anonymous);
  assert.equal(anonymousJson.includes('Q001'), false);
  assert.equal(anonymousJson.includes('original-agent'), false);
  assert.equal(anonymousJson.includes('migrated-rag'), false);
  assert.equal(anonymousJson.includes('测试事实是什么'), false);
  assert.equal(anonymousJson.includes('事实一和事实二'), false);
  assert.doesNotThrow(() => assertAnonymousReport(summary.anonymous));

  const leakMutations = [
    (report) => {
      report.benchmark.caveats[0] = ['', 'home', 'example', 'Private Vault', 'note.md'].join('/');
    },
    (report) => { report.benchmark.caveats[0] = '![[Private Note]]'; },
    (report) => { report.generatedAt = 'C:\\Users\\Example\\Private.md'; },
    (report) => { report.comparisons[0].difference = 'Synthetic private question or answer.'; },
    (report) => {
      report.systems[0].modes.normal.retrieval.perQuestion[0].questionId = 'Q001';
    },
    (report) => { report.systems[0].raw_output = 'Synthetic raw model output.'; },
    (report) => { report.systems[0].metadata = { nested: ['Synthetic private text.'] }; },
  ];
  for (const mutate of leakMutations) {
    const report = structuredClone(summary.anonymous);
    mutate(report);
    assert.throws(
      () => assertAnonymousReport(report),
      (error) => error.code === 'PRIVATE_DATA_IN_REPORT' &&
        !/Private Vault|Private Note|Synthetic private|raw model output/.test(error.message),
    );
  }

  const failedRecord = { ...offlineRecord(), status: 'failed', errorCode: 'PRIVATE_NOTE_IDENTIFIER' };
  const failureSummary = summarizeOfflineResults({
    ...input,
    systems: [{ id: 'original-agent', records: [offlineRecord(), failedRecord] }],
  }, dataset, { generatedAt: '2026-08-31T00:00:00.000Z' });
  assert.deepEqual(
    failureSummary.anonymous.systems[0].modes.normal.errorCounts,
    { OTHER_ERROR: 1 },
  );
  assert.equal(JSON.stringify(failureSummary.anonymous).includes('PRIVATE_NOTE_IDENTIFIER'), false);
  assert.throws(
    () => summarizeOfflineResults({
      ...input,
      configuration: { ...FAIR_MODEL_CONFIGURATION, temperature: 0.2 },
    }, dataset),
    (error) => error.code === 'UNFAIR_MODEL_CONFIGURATION',
  );
});

test('CLI report refuses a recursively nested private string before writing output', async (t) => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultmind-report-guard-'));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const input = path.join(temporary, 'input.json');
  const output = path.join(temporary, 'anonymous.json');
  await fsp.writeFile(input, `${JSON.stringify({
    anonymous: {
      schemaVersion: 1,
      generatedAt: '2026-08-31T00:00:00.000Z',
      benchmark: {
        caveats: ['[synthetic](../Private Vault/note.md)'],
      },
      systems: [],
      comparisons: [],
    },
  })}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    'scripts/benchmark-compare.mjs',
    'report',
    '--input', input,
    '--output', output,
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PRIVATE_DATA_IN_REPORT/);
  await assert.rejects(fsp.stat(output), (error) => error.code === 'ENOENT');
});

test('CLI run fails closed before approval and scores only explicit offline results', async (t) => {
  const fixture = await snapshotFixture(t);
  const item = approvedItem({
    goldAnswer: 'A public synthetic fact.',
    goldFacts: [{
      id: 'F1',
      text: 'A public synthetic fact.',
      evidence: [evidence('note.md', 3, 3, sha256('A public synthetic fact.'))],
    }],
    relevant: [{
      path: 'note.md',
      grade: 3,
      evidence: [evidence('', 3, 3, sha256('A public synthetic fact.'))],
    }],
  });
  const dataset = datasetFixture({
    reviewStatus: 'draft',
    executionAllowed: false,
    snapshot: { manifestSha256: sha256(fixture.manifest), fileCount: 1 },
    items: [item],
  });
  const datasetFile = path.join(fixture.workspace, 'dataset.json');
  await fsp.writeFile(datasetFile, `${JSON.stringify(dataset)}\n`, { mode: 0o600 });
  const common = [
    'scripts/benchmark-compare.mjs',
    'run',
    '--workspace', fixture.workspace,
    '--dataset', datasetFile,
    '--snapshot', fixture.snapshot,
    '--snapshot-manifest', fixture.manifestFile,
    '--allow-nonstandard',
    '--offline-results', path.join(fixture.workspace, 'offline.json'),
  ];
  const rejected = spawnSync(process.execPath, common, { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /INVALID_BENCHMARK_DATASET/);

  dataset.reviewStatus = 'approved';
  dataset.executionAllowed = true;
  await fsp.writeFile(datasetFile, `${JSON.stringify(dataset)}\n`, { mode: 0o600 });
  const datasetBytes = await fsp.readFile(datasetFile);
  const record = offlineRecord();
  record.retrieval.results = [{ path: 'note.md', lineStart: 3, lineEnd: 3 }];
  record.answerEvaluation.predictedFactCount = 1;
  record.answerEvaluation.supportedFactCount = 1;
  record.answerEvaluation.goldFactCount = 1;
  record.answerEvaluation.matchedGoldFactCount = 1;
  record.answerEvaluation.citationCount = 1;
  record.answerEvaluation.validCitationCount = 1;
  record.answerEvaluation.goldEvidenceCount = 1;
  record.answerEvaluation.citedGoldEvidenceCount = 1;
  const offline = {
    schemaVersion: 1,
    datasetSha256: sha256(datasetBytes),
    snapshotManifestSha256: sha256(fixture.manifest),
    configuration: FAIR_MODEL_CONFIGURATION,
    systems: [{ id: 'system-one', records: [record] }],
  };
  await fsp.writeFile(
    path.join(fixture.workspace, 'offline.json'),
    `${JSON.stringify(offline)}\n`,
    { mode: 0o600 },
  );
  const accepted = spawnSync(process.execPath, common, { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /"networkUsed": false/);
  const privateSummary = JSON.parse(await fsp.readFile(
    path.join(fixture.workspace, 'run-private-summary.json'),
    'utf8',
  ));
  assert.equal(privateSummary.anonymous.systems[0].modes.normal.answers.questionAccuracy, 1);
  assert.equal(privateSummary.private.datasetSha256, sha256(datasetBytes));

  const anonymousOutput = path.join(fixture.workspace, 'anonymous-report.json');
  const reported = spawnSync(process.execPath, [
    'scripts/benchmark-compare.mjs',
    'report',
    '--input', path.join(fixture.workspace, 'run-private-summary.json'),
    '--output', anonymousOutput,
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(reported.status, 0, reported.stderr);
  const anonymousText = await fsp.readFile(anonymousOutput, 'utf8');
  for (const forbidden of [
    fixture.temporary,
    fixture.snapshot,
    datasetFile,
    item.query,
    item.goldAnswer,
    'note.md',
    'system-one',
  ]) assert.equal(anonymousText.includes(forbidden), false);
  assert.match(anonymousText, /"questionId": "Question-001"/);
});
