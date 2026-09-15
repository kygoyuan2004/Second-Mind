import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FAIR_MODEL_CONFIGURATION,
  summarizeOfflineResults,
  validateDataset,
} from '../scripts/lib/benchmark-core.mjs';
import {
  BenchmarkAdjudicationError,
  createBlindArbitrationPacket,
  generateBlindReviewBundle,
  mergeBlindReviewResults,
} from '../scripts/lib/benchmark-adjudication.mjs';

const DATASET_SHA256 = 'b'.repeat(64);
const SNAPSHOT_SHA256 = 'a'.repeat(64);
const EVIDENCE_SHA256 = 'c'.repeat(64);

function datasetFixture() {
  return {
    schemaVersion: 1,
    reviewStatus: 'approved',
    executionAllowed: true,
    snapshot: {
      manifestSha256: SNAPSHOT_SHA256,
      fileCount: 2,
      logicalDocumentCount: 2,
    },
    items: [{
      id: 'Q001',
      category: 'exact_fact',
      query: 'When does the synthetic launch happen?',
      priorMessages: [],
      answerable: true,
      goldAnswer: 'The synthetic launch is 5 September 2026.',
      goldFacts: [{
        id: 'F1',
        text: 'The synthetic launch is 5 September 2026.',
        evidence: [{
          path: 'notes/launch.md',
          startLine: 3,
          endLine: 3,
          textSha256: EVIDENCE_SHA256,
        }],
      }],
      relevant: [{
        path: 'notes/launch.md',
        grade: 3,
        evidence: [{
          startLine: 3,
          endLine: 3,
          textSha256: EVIDENCE_SHA256,
        }],
      }],
      review: { status: 'approved' },
    }],
  };
}

function schedulerRecord({ schedulerSystem, mode, round, phase }) {
  const inputTokens = schedulerSystem === 'agent' ? 120 : 80;
  return {
    pairId: `${phase}:${mode}:r${round}:Q001`,
    questionId: 'Q001',
    system: schedulerSystem,
    mode,
    round,
    phase,
    sessionId: `synthetic-${schedulerSystem}-${mode}-${round}`,
    status: 'success',
    usage: {
      inputTokens,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    costCny: 0.01,
    timing: {
      wallMs: schedulerSystem === 'agent' ? 250 : 120,
      indexBuildMs: 10,
      retrievalMs: 5,
      timeToFirstTokenMs: 40,
      ttftMs: 40,
      generationMs: 60,
      totalMs: schedulerSystem === 'agent' ? 240 : 110,
    },
  };
}

function rawPayload(record) {
  const systemId = record.system === 'agent' ? 'original-agent' : 'migrated-rag';
  return {
    schemaVersion: 1,
    schedulerRecord: record,
    rawResult: {
      schemaVersion: 1,
      system: systemId,
      anonymousId: `Synthetic-${record.system}-${record.mode}-${record.round}`,
      mode: record.mode,
      status: 'completed',
      answer: 'The synthetic launch is 5 September 2026. [notes/launch.md:3]',
      configuration: {
        model: 'qwen3.8-max',
        effort: 'medium',
        temperature: 0,
        maxOutputTokens: 3_000,
        webSearch: false,
        freshSession: true,
      },
      retrieval: {
        results: [{
          rank: 1,
          path: 'notes/launch.md',
          score: 0.9,
          lineStart: 3,
          lineEnd: 3,
        }],
      },
      toolEvents: record.system === 'agent'
        ? [{ id: 'tool-1', type: 'tool', toolName: 'search', stage: 'start' }]
        : [],
      model: {
        calls: [{}],
        turns: record.system === 'agent' ? 2 : null,
        telemetry: {
          records: [{
            anonymousId: `Synthetic-${record.system}-${record.mode}-${record.round}`,
            attempt: 1,
            usage: record.usage,
            timing: { firstVisibleTextMs: 40, completedMs: 100 },
            errorCode: null,
          }],
        },
      },
      timing: record.timing,
    },
  };
}

async function writeJson(filename, value) {
  await fsp.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await fsp.chmod(filename, 0o600);
}

async function cloudFixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultmind-adjudication-'));
  const cloudRunRoot = path.join(root, 'cloud-run');
  const rawRoot = path.join(cloudRunRoot, 'raw');
  await fsp.mkdir(rawRoot, { recursive: true, mode: 0o700 });
  await fsp.chmod(cloudRunRoot, 0o700);
  await fsp.chmod(rawRoot, 0o700);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const descriptors = [
    { schedulerSystem: 'agent', mode: 'normal', round: 1, phase: 'calibration' },
    { schedulerSystem: 'rag', mode: 'normal', round: 1, phase: 'calibration' },
    { schedulerSystem: 'agent', mode: 'deep', round: 1, phase: 'deep' },
    { schedulerSystem: 'rag', mode: 'deep', round: 1, phase: 'deep' },
    { schedulerSystem: 'agent', mode: 'normal', round: 2, phase: 'normal_repeat' },
    { schedulerSystem: 'rag', mode: 'normal', round: 2, phase: 'normal_repeat' },
  ];
  const records = descriptors.map(schedulerRecord);
  const rawFiles = [];
  if (options.writeRaw !== false) {
    for (let index = 0; index < records.length; index += 1) {
      const relative = `raw/${String(index + 1).padStart(3, '0')}.json`;
      rawFiles.push(relative);
      await writeJson(path.join(cloudRunRoot, relative), rawPayload(records[index]));
    }
  } else {
    rawFiles.push('raw/intentionally-missing.json');
  }
  const summaryRecords = options.writeRaw === false ? [records[0]] : records;
  await writeJson(path.join(cloudRunRoot, 'cloud-execution-summary.json'), {
    schemaVersion: 1,
    status: options.status || 'completed',
    calibrationOnly: false,
    configuration: {
      model: 'qwen3.8-max',
      effort: 'medium',
      temperature: 0,
      maxOutputTokens: 3_000,
      webSearch: false,
    },
    benchmark: { records: summaryRecords },
    budget: { openReservations: 0, uncertainCny: 0 },
    rawFiles,
    integrity: {
      snapshot: { unchanged: true },
      production: { unchanged: true },
    },
  });
  return { root, cloudRunRoot };
}

function correctEvaluation(caseValue) {
  return {
    questionCorrect: true,
    predictedFactCount: 1,
    supportedFactCount: 1,
    goldFactCount: caseValue.fixedDenominators.goldFactCount,
    matchedGoldFactCount: 1,
    citationCount: 1,
    validCitationCount: 1,
    goldEvidenceCount: caseValue.fixedDenominators.goldEvidenceCount,
    citedGoldEvidenceCount: 1,
    hallucinatedFactCount: 0,
    contradictionCount: 0,
    refused: false,
  };
}

function validIncorrectEvaluation(caseValue) {
  return {
    questionCorrect: false,
    predictedFactCount: 2,
    supportedFactCount: 1,
    goldFactCount: caseValue.fixedDenominators.goldFactCount,
    matchedGoldFactCount: 1,
    citationCount: 1,
    validCitationCount: 1,
    goldEvidenceCount: caseValue.fixedDenominators.goldEvidenceCount,
    citedGoldEvidenceCount: 1,
    hallucinatedFactCount: 1,
    contradictionCount: 0,
    refused: false,
  };
}

async function gradePackets(bundle, mutateSecond = null) {
  const gradeFiles = [];
  for (let index = 0; index < bundle.packetFiles.length; index += 1) {
    const descriptor = bundle.packetFiles[index];
    const packet = JSON.parse(await fsp.readFile(descriptor.file, 'utf8'));
    const evaluations = packet.cases.map((caseValue, caseIndex) => ({
      caseId: caseValue.caseId,
      answerEvaluation: index === 1 && mutateSecond
        ? mutateSecond(caseValue, caseIndex)
        : correctEvaluation(caseValue),
    }));
    const gradeFile = path.join(bundle.outputRoot, `${descriptor.graderId}.result.json`);
    await writeJson(gradeFile, {
      schemaVersion: 1,
      kind: 'blind-answer-review-result',
      graderId: descriptor.graderId,
      manifestSha256: bundle.manifestSha256,
      packetSha256: descriptor.sha256,
      evaluations,
    });
    gradeFiles.push(gradeFile);
  }
  return gradeFiles;
}

test('completed synthetic raw records produce two private identity-hidden packets', async (t) => {
  const fixture = await cloudFixture(t);
  const outputRoot = path.join(fixture.root, 'blind-review');
  const bundle = await generateBlindReviewBundle({
    dataset: datasetFixture(),
    datasetSha256: DATASET_SHA256,
    cloudRunRoot: fixture.cloudRunRoot,
    outputRoot,
    enforcePlan: false,
    blindSalt: 'd'.repeat(64),
    createdAt: '2026-08-31T00:00:00.000Z',
  });
  assert.equal(bundle.rawRecordCount, 6);
  assert.equal(bundle.gradeRequiredCount, 4);
  assert.equal((await fsp.stat(outputRoot)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(bundle.manifestFile)).mode & 0o777, 0o600);
  assert.notDeepEqual(
    JSON.parse(await fsp.readFile(bundle.packetFiles[0].file, 'utf8')).cases.map((entry) => entry.caseId),
    JSON.parse(await fsp.readFile(bundle.packetFiles[1].file, 'utf8')).cases.map((entry) => entry.caseId),
  );
  for (const descriptor of bundle.packetFiles) {
    assert.equal((await fsp.stat(descriptor.file)).mode & 0o777, 0o600);
    const packet = JSON.parse(await fsp.readFile(descriptor.file, 'utf8'));
    assert.equal(packet.systemIdentityIncluded, false);
    assert.equal(packet.caseCount, 4);
    const serialized = JSON.stringify(packet);
    for (const forbidden of [
      'original-agent', 'migrated-rag', 'schedulerRecord', 'toolEvents', 'inputTokens',
      'timeToFirstTokenMs', 'normal_repeat',
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('completed exhaustive retrieval may exceed top K but cannot exceed snapshot files', async (t) => {
  const fixture = await cloudFixture(t);
  const rawFile = path.join(fixture.cloudRunRoot, 'raw', '001.json');
  const raw = JSON.parse(await fsp.readFile(rawFile, 'utf8'));
  raw.rawResult.retrieval.results = Array.from({ length: 13 }, (_, index) => ({
    rank: index + 1,
    path: index === 0 ? 'notes/launch.md' : `notes/extra-${index}.md`,
    score: 1 - (index / 100),
    lineStart: 3,
    lineEnd: 3,
  }));
  await fsp.rm(rawFile);
  await writeJson(rawFile, raw);

  const acceptedDataset = datasetFixture();
  acceptedDataset.snapshot.fileCount = 13;
  const bundle = await generateBlindReviewBundle({
    dataset: acceptedDataset,
    datasetSha256: DATASET_SHA256,
    cloudRunRoot: fixture.cloudRunRoot,
    outputRoot: path.join(fixture.root, 'blind-review'),
    enforcePlan: false,
  });
  const manifest = JSON.parse(await fsp.readFile(bundle.manifestFile, 'utf8'));
  assert.equal(manifest.records[0].offlineBase.retrieval.results.length, 13);

  const rejectedDataset = datasetFixture();
  rejectedDataset.snapshot.fileCount = 12;
  await assert.rejects(
    generateBlindReviewBundle({
      dataset: rejectedDataset,
      datasetSha256: DATASET_SHA256,
      cloudRunRoot: fixture.cloudRunRoot,
      outputRoot: path.join(fixture.root, 'must-not-exist'),
      enforcePlan: false,
    }),
    (error) => error instanceof BenchmarkAdjudicationError && error.code === 'INVALID_CLOUD_RECORD',
  );
});

test('an incomplete cloud summary fails before any referenced raw file is opened', async (t) => {
  const fixture = await cloudFixture(t, { status: 'running', writeRaw: false });
  await assert.rejects(
    generateBlindReviewBundle({
      dataset: datasetFixture(),
      datasetSha256: DATASET_SHA256,
      cloudRunRoot: fixture.cloudRunRoot,
      outputRoot: path.join(fixture.root, 'must-not-exist'),
      enforcePlan: false,
    }),
    (error) => error instanceof BenchmarkAdjudicationError && error.code === 'CLOUD_RUN_INCOMPLETE',
  );
  assert.equal(await fsp.lstat(path.join(fixture.root, 'must-not-exist')).catch(() => null), null);
});

test('two matching blind reviews merge into compare-compatible offline results', async (t) => {
  const fixture = await cloudFixture(t);
  const bundle = await generateBlindReviewBundle({
    dataset: datasetFixture(),
    datasetSha256: DATASET_SHA256,
    cloudRunRoot: fixture.cloudRunRoot,
    outputRoot: path.join(fixture.root, 'blind-review'),
    enforcePlan: false,
    blindSalt: 'e'.repeat(64),
  });
  const gradeFiles = await gradePackets(bundle);
  const outputFile = path.join(bundle.outputRoot, 'offline-results.private.json');
  const merged = await mergeBlindReviewResults({
    manifestFile: bundle.manifestFile,
    graderResultFiles: gradeFiles,
    outputFile,
  });
  assert.equal(merged.systems, 2);
  assert.equal(merged.records, 6);
  assert.equal(merged.conflictCount, 0);
  assert.equal((await fsp.stat(outputFile)).mode & 0o777, 0o600);
  assert.equal(merged.offlineResults.systems[0].id, 'original-agent');
  assert.equal(merged.offlineResults.systems[1].id, 'migrated-rag');
  assert.equal(
    merged.offlineResults.systems.flatMap((system) => system.records)
      .filter((record) => record.answerEvaluation).length,
    4,
  );
  assert.equal(
    merged.offlineResults.systems.flatMap((system) => system.records)
      .filter((record) => record.repetition === 2)
      .every((record) => !record.answerEvaluation),
    true,
  );
  const validatedDataset = validateDataset(datasetFixture(), { enforcePlan: false });
  const summary = summarizeOfflineResults(merged.offlineResults, validatedDataset, {
    bootstrapIterations: 100,
  });
  assert.equal(summary.anonymous.systems.length, 2);
  assert.equal(summary.anonymous.systems[0].modes.normal.answers.questionAccuracy, 1);
  assert.equal(summary.anonymous.systems[0].modes.deep.answers.questionAccuracy, 1);
  assert.equal(summary.anonymous.systems[0].modes.normal.repeatedPerformanceRuns, 1);
  assert.deepEqual(merged.offlineResults.configuration, FAIR_MODEL_CONFIGURATION);
});

test('a valid blind disagreement requires and accepts a separate anonymous arbitration', async (t) => {
  const fixture = await cloudFixture(t);
  const bundle = await generateBlindReviewBundle({
    dataset: datasetFixture(),
    datasetSha256: DATASET_SHA256,
    cloudRunRoot: fixture.cloudRunRoot,
    outputRoot: path.join(fixture.root, 'blind-review'),
    enforcePlan: false,
    blindSalt: 'f'.repeat(64),
  });
  const gradeFiles = await gradePackets(bundle, (caseValue, caseIndex) => (
    caseIndex === 0 ? validIncorrectEvaluation(caseValue) : correctEvaluation(caseValue)
  ));
  await assert.rejects(
    mergeBlindReviewResults({
      manifestFile: bundle.manifestFile,
      graderResultFiles: gradeFiles,
    }),
    (error) => error instanceof BenchmarkAdjudicationError &&
      error.code === 'BLIND_EVALUATION_DISAGREEMENT' && error.conflictCount === 1,
  );
  const arbitrationFile = path.join(bundle.outputRoot, 'arbitration.packet.json');
  const arbitration = await createBlindArbitrationPacket({
    manifestFile: bundle.manifestFile,
    graderResultFiles: gradeFiles,
    outputFile: arbitrationFile,
  });
  assert.equal(arbitration.required, true);
  assert.equal(arbitration.conflictCount, 1);
  const packet = JSON.parse(await fsp.readFile(arbitrationFile, 'utf8'));
  const serialized = JSON.stringify(packet);
  assert.equal(serialized.includes('original-agent'), false);
  assert.equal(serialized.includes('migrated-rag'), false);
  const arbitrationResultFile = path.join(bundle.outputRoot, 'arbitration.result.json');
  await writeJson(arbitrationResultFile, {
    schemaVersion: 1,
    kind: 'blind-answer-arbitration-result',
    packetSha256: arbitration.packetSha256,
    evaluations: packet.cases.map((caseValue) => ({
      caseId: caseValue.caseId,
      answerEvaluation: correctEvaluation(caseValue),
    })),
  });
  const merged = await mergeBlindReviewResults({
    manifestFile: bundle.manifestFile,
    graderResultFiles: gradeFiles,
    arbitrationPacketFile: arbitrationFile,
    arbitrationResultFile,
  });
  assert.equal(merged.conflictCount, 1);
  assert.equal(
    merged.offlineResults.systems.flatMap((system) => system.records)
      .filter((record) => record.answerEvaluation)
      .every((record) => record.answerEvaluation.questionCorrect),
    true,
  );
});

test('tampered grader packet hashes and extra scoring fields fail closed', async (t) => {
  const fixture = await cloudFixture(t);
  const bundle = await generateBlindReviewBundle({
    dataset: datasetFixture(),
    datasetSha256: DATASET_SHA256,
    cloudRunRoot: fixture.cloudRunRoot,
    outputRoot: path.join(fixture.root, 'blind-review'),
    enforcePlan: false,
    blindSalt: '1'.repeat(64),
  });
  const gradeFiles = await gradePackets(bundle);
  const first = JSON.parse(await fsp.readFile(gradeFiles[0], 'utf8'));
  first.packetSha256 = '0'.repeat(64);
  await fsp.rm(gradeFiles[0]);
  await writeJson(gradeFiles[0], first);
  await assert.rejects(
    mergeBlindReviewResults({
      manifestFile: bundle.manifestFile,
      graderResultFiles: gradeFiles,
    }),
    (error) => error instanceof BenchmarkAdjudicationError && error.code === 'INVALID_GRADER_RESULT',
  );
});
