import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  FAIR_MODEL_CONFIGURATION,
  sha256,
  validateDataset,
} from './benchmark-core.mjs';
import {
  blindEvaluationsEqual,
  resolveBlindEvaluation,
  validateBlindEvaluation,
} from './benchmark-blind-scoring.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_RELATIVE_JSON = /^(?!\.)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+\.json$/u;
const SYSTEM_IDS = Object.freeze({
  agent: 'original-agent',
  rag: 'migrated-rag',
});
const COMPLETED_RESULT_STATES = new Set(['completed', 'success', 'succeeded']);
const QUALITY_ROUND = 1;

export class BenchmarkAdjudicationError extends Error {
  constructor(message, code = 'BENCHMARK_ADJUDICATION_ERROR', options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BenchmarkAdjudicationError';
    this.code = code;
    if (Number.isInteger(options.conflictCount)) this.conflictCount = options.conflictCount;
  }
}

function fail(message, code, options = {}) {
  throw new BenchmarkAdjudicationError(message, code, options);
}

function clone(value) {
  return structuredClone(value);
}

function privateMode(stat, label) {
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(`${label} must be a regular, non-linked file.`, 'UNSAFE_PRIVATE_FILE');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    fail(`${label} must have mode 0600.`, 'UNSAFE_PRIVATE_MODE');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user.`, 'UNSAFE_PRIVATE_OWNER');
  }
}

async function privateDirectory(input, label) {
  if (!path.isAbsolute(String(input || ''))) {
    fail(`${label} must be an explicit absolute path.`, 'UNSAFE_PRIVATE_PATH');
  }
  const target = path.resolve(String(input));
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be an existing real directory.`, 'UNSAFE_PRIVATE_PATH');
  }
  if ((stat.mode & 0o077) !== 0) {
    fail(`${label} must not be accessible by group or other users.`, 'UNSAFE_PRIVATE_MODE');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user.`, 'UNSAFE_PRIVATE_OWNER');
  }
  return fsp.realpath(target);
}

function confinedPath(root, relative, label) {
  const supplied = String(relative || '');
  if (!SAFE_RELATIVE_JSON.test(supplied) || path.isAbsolute(supplied)) {
    fail(`${label} is not a safe relative JSON path.`, 'UNSAFE_PRIVATE_PATH');
  }
  const target = path.resolve(root, supplied);
  const relation = path.relative(root, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    fail(`${label} escaped its private root.`, 'UNSAFE_PRIVATE_PATH');
  }
  return target;
}

async function readPrivateJsonFile(filename, label) {
  let handle;
  try {
    handle = await fsp.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    fail(`${label} is unavailable.`, 'PRIVATE_FILE_UNAVAILABLE', { cause: error });
  }
  try {
    privateMode(await handle.stat(), label);
    const bytes = await handle.readFile();
    if (!bytes.length || bytes.length > 64 * 1024 * 1024) {
      fail(`${label} is outside the permitted size bound.`, 'INVALID_PRIVATE_JSON');
    }
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      fail(`${label} is not valid JSON.`, 'INVALID_PRIVATE_JSON', { cause: error });
    }
    return { bytes, value, sha256: sha256(bytes) };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readConfinedPrivateJson(root, relative, label) {
  return readPrivateJsonFile(confinedPath(root, relative, label), label);
}

async function writePrivateJsonNoReplace(directory, basename, value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(basename)) {
    fail('The private output filename is unsafe.', 'UNSAFE_PRIVATE_PATH');
  }
  const target = path.join(directory, basename);
  const temporary = path.join(directory, `.${basename}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.link(temporary, target);
    await fsp.unlink(temporary);
    await fsp.chmod(target, 0o600);
    const bytes = await fsp.readFile(target);
    return { target, bytes, sha256: sha256(bytes) };
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
    if (error?.code === 'EEXIST') {
      fail('A private output file already exists; refusing to overwrite it.', 'PRIVATE_OUTPUT_EXISTS');
    }
    throw error;
  }
}

function assertSha256(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) fail(`${label} must be a SHA-256 digest.`, 'INVALID_DIGEST');
  return normalized;
}

function assertSafeId(value, label) {
  const normalized = String(value || '');
  if (!SAFE_ID.test(normalized)) fail(`${label} is invalid.`, 'INVALID_ADJUDICATION_ID');
  return normalized;
}

function integer(value, label, options = {}) {
  const number = Number(value);
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(`${label} must be an integer in the permitted range.`, 'INVALID_CLOUD_RECORD');
  }
  return number;
}

function finite(value, label, options = {}) {
  if (value === undefined || value === null) return options.nullable ? null : 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    fail(`${label} must be a finite non-negative number.`, 'INVALID_CLOUD_RECORD');
  }
  return number;
}

function finiteSigned(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    fail(`${label} must be a finite number.`, 'INVALID_CLOUD_RECORD');
  }
  return number;
}

function safeRelativeDocumentPath(value) {
  const supplied = String(value || '').replaceAll('\\', '/');
  if (
    !supplied || supplied.startsWith('/') || supplied.includes('\0') ||
    supplied.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  ) {
    fail('A retrieval result contains an unsafe document path.', 'INVALID_CLOUD_RECORD');
  }
  return supplied;
}

function normalizeUsage(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} is missing Usage data.`, 'INVALID_CLOUD_RECORD');
  }
  return {
    inputTokens: integer(value.inputTokens ?? value.input_tokens ?? 0, `${label}.inputTokens`),
    outputTokens: integer(value.outputTokens ?? value.output_tokens ?? 0, `${label}.outputTokens`),
    cacheCreationTokens: integer(
      value.cacheCreationTokens ?? value.cacheCreationInputTokens ??
      value.cache_creation_input_tokens ?? 0,
      `${label}.cacheCreationTokens`,
    ),
    cacheReadTokens: integer(
      value.cacheReadTokens ?? value.cacheReadInputTokens ?? value.cache_read_input_tokens ?? 0,
      `${label}.cacheReadTokens`,
    ),
  };
}

function addUsage(left, right) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, left[key] + right[key]]));
}

function telemetryCalls(rawResult) {
  const records = rawResult?.model?.telemetry?.records;
  if (!Array.isArray(records) || !records.length) {
    fail('A successful raw result is missing complete model telemetry.', 'INVALID_CLOUD_RECORD');
  }
  return records.map((record, index) => {
    const usage = normalizeUsage(record?.usage, `telemetry[${index}].usage`);
    if (usage.inputTokens + usage.outputTokens <= 0) {
      fail('A telemetry call contains empty Usage data.', 'INVALID_CLOUD_RECORD');
    }
    const attempt = integer(record?.attempt ?? 1, `telemetry[${index}].attempt`, {
      minimum: 1,
      maximum: 20,
    });
    return {
      usage,
      attempt,
      errorCode: record?.errorCode ? 'MODEL_API_ERROR' : null,
    };
  });
}

function validateConfiguration(summary, rawResult) {
  const summaryConfig = summary?.configuration || {};
  const rawConfig = rawResult?.configuration || {};
  const invalid = (
    summaryConfig.model !== FAIR_MODEL_CONFIGURATION.model ||
    summaryConfig.effort !== FAIR_MODEL_CONFIGURATION.anthropic.output_config.effort ||
    Number(summaryConfig.temperature) !== FAIR_MODEL_CONFIGURATION.temperature ||
    Number(summaryConfig.maxOutputTokens) !== FAIR_MODEL_CONFIGURATION.maxOutputTokens ||
    summaryConfig.webSearch !== false ||
    rawConfig.model !== FAIR_MODEL_CONFIGURATION.model ||
    rawConfig.effort !== FAIR_MODEL_CONFIGURATION.anthropic.output_config.effort ||
    Number(rawConfig.temperature) !== FAIR_MODEL_CONFIGURATION.temperature ||
    Number(rawConfig.maxOutputTokens) !== FAIR_MODEL_CONFIGURATION.maxOutputTokens ||
    rawConfig.webSearch !== false || rawConfig.freshSession !== true
  );
  if (invalid) fail('A raw result differs from the locked fair configuration.', 'UNFAIR_CLOUD_RECORD');
}

function retrievalResults(rawResult, maximumResults) {
  const results = rawResult?.retrieval?.results;
  if (!Array.isArray(results) || results.length > maximumResults) {
    fail(
      'A successful raw result has more ranked retrieval results than the verified snapshot can contain.',
      'INVALID_CLOUD_RECORD',
    );
  }
  return results.map((result, index) => {
    const lineStart = result?.lineStart === null || result?.lineStart === undefined
      ? null
      : integer(result.lineStart, `retrieval.results[${index}].lineStart`, { minimum: 1 });
    const lineEnd = result?.lineEnd === null || result?.lineEnd === undefined
      ? null
      : integer(result.lineEnd, `retrieval.results[${index}].lineEnd`, { minimum: 1 });
    if ((lineStart === null) !== (lineEnd === null) ||
        (lineStart !== null && lineEnd < lineStart)) {
      fail('A retrieval result contains an invalid line range.', 'INVALID_CLOUD_RECORD');
    }
    return {
      rank: index + 1,
      path: safeRelativeDocumentPath(result?.path),
      score: result?.score === null || result?.score === undefined
        ? null
        : finiteSigned(result.score, `retrieval.results[${index}].score`),
      lineStart,
      lineEnd,
    };
  });
}

function uniqueToolCalls(rawResult) {
  const events = Array.isArray(rawResult?.toolEvents) ? rawResult.toolEvents : [];
  return new Set(events.filter((event) => event?.toolName).map((event, index) => (
    String(event.id || `${event.toolName}:${index}`)
  ))).size;
}

function timingRecord(schedulerRecord) {
  const source = schedulerRecord?.timing || {};
  const output = {};
  for (const field of [
    'indexBuildMs', 'retrievalMs', 'timeToFirstTokenMs', 'generationMs', 'totalMs', 'wallMs',
  ]) {
    const value = finite(source[field], `schedulerRecord.timing.${field}`, { nullable: true });
    if (value !== null) output[field] = value;
  }
  return output;
}

function evidenceCount(item) {
  const identifiers = new Set();
  for (const relevant of item.relevant) {
    for (const evidence of relevant.evidence) {
      identifiers.add([
        relevant.path,
        evidence.startLine,
        evidence.endLine,
        evidence.textSha256,
      ].join(':'));
    }
  }
  return identifiers.size;
}

function blindCase(item, answer) {
  return {
    query: item.query,
    priorMessages: clone(item.priorMessages),
    groundTruth: {
      answerable: item.answerable,
      referenceAnswer: item.goldAnswer,
      atomicFacts: clone(item.goldFacts),
      relevantEvidence: clone(item.relevant),
    },
    candidateAnswer: String(answer || ''),
    fixedDenominators: {
      goldFactCount: item.goldFacts.length,
      goldEvidenceCount: evidenceCount(item),
    },
  };
}

function rawRecordToSource(payload, itemById, summary, rawFileSha256, maximumRetrievalResults = 12) {
  if (!payload || payload.schemaVersion !== 1 || !payload.schedulerRecord) {
    fail('A cloud raw file does not match schemaVersion=1.', 'INVALID_CLOUD_RECORD');
  }
  const scheduler = payload.schedulerRecord;
  const questionId = assertSafeId(scheduler.questionId, 'schedulerRecord.questionId');
  const item = itemById.get(questionId);
  if (!item) fail('A cloud raw record refers to an unknown approved question.', 'UNKNOWN_QUESTION');
  const schedulerSystem = String(scheduler.system || '');
  const systemId = SYSTEM_IDS[schedulerSystem];
  if (!systemId) fail('A cloud raw record uses an unknown system identity.', 'UNKNOWN_SYSTEM');
  const mode = String(scheduler.mode || '').toLowerCase();
  if (!['normal', 'deep'].includes(mode)) fail('A cloud raw record has an invalid mode.', 'INVALID_CLOUD_RECORD');
  const repetition = integer(scheduler.round, 'schedulerRecord.round', { minimum: 1, maximum: 100 });
  const phase = assertSafeId(scheduler.phase, 'schedulerRecord.phase');
  const status = String(scheduler.status || '').toLowerCase();
  if (!['success', 'failed', 'timeout'].includes(status)) {
    fail('A cloud scheduler record has an invalid status.', 'INVALID_CLOUD_RECORD');
  }
  const rawResult = payload.rawResult;
  const succeeded = status === 'success';
  if (succeeded) {
    if (!rawResult || rawResult.system !== systemId || rawResult.mode !== mode ||
        !COMPLETED_RESULT_STATES.has(String(rawResult.status || '').toLowerCase())) {
      fail('A successful scheduler record disagrees with its raw result.', 'CLOUD_RECORD_MISMATCH');
    }
    validateConfiguration(summary, rawResult);
  }
  const calls = succeeded ? telemetryCalls(rawResult) : [];
  if (succeeded) {
    const callUsage = calls.reduce(
      (total, call) => addUsage(total, call.usage),
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    );
    const schedulerUsage = normalizeUsage(scheduler.usage, 'schedulerRecord.usage');
    if (!isDeepStrictEqual(callUsage, schedulerUsage)) {
      fail('Scheduler Usage differs from raw provider telemetry.', 'CLOUD_USAGE_MISMATCH');
    }
  }
  const errorCode = succeeded
    ? null
    : (/TIMEOUT/u.test(String(scheduler.errorCode || '')) ? 'TASK_TIMEOUT' : 'OTHER_ERROR');
  const offlineBase = {
    questionId,
    status: succeeded ? 'success' : (errorCode === 'TASK_TIMEOUT' ? 'timeout' : 'failed'),
    taskMode: mode,
    repetition,
    phase,
    retrieval: {
      results: succeeded ? retrievalResults(rawResult, maximumRetrievalResults) : [],
    },
    calls,
    timings: timingRecord(scheduler),
    modelCallCount: calls.length,
    agentTurns: succeeded ? integer(rawResult?.model?.turns ?? 0, 'rawResult.model.turns') : 0,
    toolCallCount: succeeded ? uniqueToolCalls(rawResult) : 0,
    retryCount: calls.reduce((sum, call) => sum + Math.max(0, call.attempt - 1), 0),
    apiErrorCount: calls.reduce((sum, call) => (
      sum + Math.max(0, call.attempt - 1) + Number(Boolean(call.errorCode))
    ), 0),
    embeddingRequestCount: 0,
    rerankRequestCount: 0,
    ...(errorCode ? { errorCode } : {}),
  };
  const gradeRequired = succeeded && repetition === QUALITY_ROUND;
  const privateKey = [questionId, systemId, mode, repetition].join('|');
  return {
    privateKey,
    systemId,
    gradeRequired,
    rawFileSha256,
    offlineBase,
    blindCase: gradeRequired ? blindCase(item, rawResult.answer) : null,
  };
}

function packetRubric() {
  return Object.freeze({
    independence: 'Do not infer or identify the implementation that produced the candidate answer.',
    evidenceRule: 'Use only the approved ground truth and evidence ranges in this packet.',
    outputRule: 'Return exactly one evaluation for every caseId; do not copy private content.',
    fields: Object.freeze({
      questionCorrect: 'Boolean: the answer is substantively correct for the question.',
      predictedFactCount: 'Number of externally checkable factual claims in the candidate answer.',
      supportedFactCount: 'Predicted claims supported by the approved evidence.',
      goldFactCount: 'Copy the fixed denominator supplied for the case.',
      matchedGoldFactCount: 'Approved atomic facts correctly covered by the answer.',
      citationCount: 'Explicit citations made by the answer.',
      validCitationCount: 'Citations that point to approved supporting evidence.',
      goldEvidenceCount: 'Copy the fixed denominator supplied for the case.',
      citedGoldEvidenceCount: 'Distinct approved evidence segments cited correctly.',
      hallucinatedFactCount: 'Predicted factual claims unsupported by approved evidence.',
      contradictionCount: 'Predicted factual claims contradicting approved evidence.',
      refused: 'Boolean: the answer refused or clearly said the knowledge base cannot answer.',
    }),
  });
}

function opaqueId(prefix, salt, ...parts) {
  const digest = crypto.createHmac('sha256', salt).update(parts.join('\0')).digest('hex').slice(0, 24);
  return `${prefix}-${digest}`;
}

function packetFor(graderId, records, salt, datasetSha256, snapshotManifestSha256) {
  const cases = records.filter((record) => record.gradeRequired).map((record) => ({
    caseId: opaqueId('Case', salt, graderId, record.recordId),
    ...clone(record.blindCase),
  }));
  cases.sort((left, right) => {
    const leftKey = opaqueId('Order', salt, graderId, left.caseId);
    const rightKey = opaqueId('Order', salt, graderId, right.caseId);
    return leftKey.localeCompare(rightKey);
  });
  return {
    schemaVersion: 1,
    kind: 'blind-answer-review-packet',
    graderId,
    datasetSha256,
    snapshotManifestSha256,
    systemIdentityIncluded: false,
    rubric: packetRubric(),
    caseCount: cases.length,
    cases,
  };
}

function validateCompletedSummary(summary) {
  if (!summary || summary.schemaVersion !== 1 || summary.status !== 'completed' ||
      summary.calibrationOnly !== false) {
    fail('The cloud run is not a completed full benchmark.', 'CLOUD_RUN_INCOMPLETE');
  }
  if (
    summary.integrity?.snapshot?.unchanged !== true ||
    summary.integrity?.production?.unchanged !== true ||
    Number(summary.budget?.openReservations) !== 0 || Number(summary.budget?.uncertainCny) !== 0
  ) {
    fail('The completed cloud run did not pass all integrity gates.', 'CLOUD_RUN_INTEGRITY_FAILED');
  }
  if (!Array.isArray(summary.rawFiles) || !summary.rawFiles.length ||
      !Array.isArray(summary.benchmark?.records) ||
      summary.rawFiles.length !== summary.benchmark.records.length) {
    fail('The completed cloud summary has an inconsistent raw record index.', 'CLOUD_RUN_INCOMPLETE');
  }
  if (new Set(summary.rawFiles).size !== summary.rawFiles.length) {
    fail('The cloud summary contains duplicate raw file references.', 'CLOUD_RUN_INCOMPLETE');
  }
}

function assertPacketBlind(packet) {
  const forbiddenKeys = new Set([
    'system', 'systemId', 'schedulerRecord', 'rawResult', 'tokens', 'usage', 'timings',
    'toolEvents', 'retrieval', 'model', 'phase', 'questionId', 'recordId',
  ]);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) {
        fail('A grader packet contains implementation-identifying metadata.', 'BLIND_PACKET_LEAK');
      }
      visit(child);
    }
  };
  visit(packet);
  if (packet.systemIdentityIncluded !== false) {
    fail('A grader packet did not declare identity hiding.', 'BLIND_PACKET_LEAK');
  }
}

/**
 * Build two independently shuffled, identity-hidden review packets. The cloud
 * summary is opened first and must prove a completed full run; raw files are
 * never opened for an in-progress or failed execution.
 */
export async function generateBlindReviewBundle(options = {}) {
  const dataset = validateDataset(options.dataset, {
    enforcePlan: options.enforcePlan !== false,
    requireApproved: true,
  });
  const datasetSha256 = assertSha256(options.datasetSha256, 'datasetSha256');
  const cloudRunRoot = await privateDirectory(options.cloudRunRoot, 'cloudRunRoot');
  const summaryFile = await readConfinedPrivateJson(
    cloudRunRoot,
    'cloud-execution-summary.json',
    'cloud execution summary',
  );
  validateCompletedSummary(summaryFile.value);

  const itemById = new Map(dataset.items.map((item) => [item.id, item]));
  const records = [];
  const privateKeys = new Set();
  for (let index = 0; index < summaryFile.value.rawFiles.length; index += 1) {
    const relative = String(summaryFile.value.rawFiles[index]);
    if (!relative.startsWith('raw/')) {
      fail('A cloud raw file is outside the fixed raw/ directory.', 'UNSAFE_PRIVATE_PATH');
    }
    const rawFile = await readConfinedPrivateJson(cloudRunRoot, relative, 'cloud raw result');
    const expectedScheduler = summaryFile.value.benchmark.records[index];
    if (!isDeepStrictEqual(rawFile.value?.schedulerRecord, expectedScheduler)) {
      fail('A cloud raw record differs from the completed summary index.', 'CLOUD_RECORD_MISMATCH');
    }
    const source = rawRecordToSource(
      rawFile.value,
      itemById,
      summaryFile.value,
      rawFile.sha256,
      dataset.snapshot.fileCount,
    );
    if (privateKeys.has(source.privateKey)) {
      fail('The cloud run contains a duplicate system/question/mode/round record.', 'DUPLICATE_CLOUD_RECORD');
    }
    privateKeys.add(source.privateKey);
    records.push(source);
  }

  const graderIds = (options.graderIds || ['Reviewer-1', 'Reviewer-2'])
    .map((graderId) => assertSafeId(graderId, 'graderId'));
  if (graderIds.length !== 2 || new Set(graderIds).size !== 2) {
    fail('Exactly two distinct blind grader ids are required.', 'INVALID_GRADER_SET');
  }
  const salt = options.blindSalt
    ? Buffer.from(assertSha256(options.blindSalt, 'blindSalt'), 'hex')
    : crypto.randomBytes(32);
  const numberedRecords = records.map((record, index) => ({
    ...record,
    recordId: `Record-${String(index + 1).padStart(4, '0')}`,
    arbitrationCaseId: opaqueId('Arbitration', salt, record.privateKey),
  }));
  const packets = graderIds.map((graderId) => (
    packetFor(graderId, numberedRecords, salt, datasetSha256, dataset.snapshot.manifestSha256)
  ));
  for (const packet of packets) assertPacketBlind(packet);

  const outputRoot = path.resolve(String(options.outputRoot || ''));
  if (!path.isAbsolute(String(options.outputRoot || ''))) {
    fail('outputRoot must be an explicit absolute path.', 'UNSAFE_PRIVATE_PATH');
  }
  if (await fsp.lstat(outputRoot).catch(() => null)) {
    fail('The blind-review output directory already exists.', 'PRIVATE_OUTPUT_EXISTS');
  }
  const outputParent = await privateDirectory(path.dirname(outputRoot), 'outputRoot parent');
  if (path.dirname(outputRoot) !== outputParent) {
    fail('outputRoot parent must not pass through a symbolic link.', 'UNSAFE_PRIVATE_PATH');
  }
  const staging = path.join(outputParent, `.blind-review-${crypto.randomUUID()}.tmp`);
  await fsp.mkdir(staging, { mode: 0o700 });
  let published = false;
  try {
    const packetFiles = [];
    for (const packet of packets) {
      const basename = `${packet.graderId}.blind-packet.json`;
      const written = await writePrivateJsonNoReplace(staging, basename, packet);
      const caseMap = packet.cases.map((entry) => {
        const record = numberedRecords.find((candidate) => (
          opaqueId('Case', salt, packet.graderId, candidate.recordId) === entry.caseId
        ));
        return { caseId: entry.caseId, recordId: record.recordId };
      });
      packetFiles.push({
        graderId: packet.graderId,
        file: basename,
        sha256: written.sha256,
        caseCount: packet.caseCount,
        cases: caseMap,
      });
    }
    const manifest = {
      schemaVersion: 1,
      kind: 'blind-review-private-manifest',
      createdAt: options.createdAt || new Date().toISOString(),
      datasetSha256,
      snapshotManifestSha256: dataset.snapshot.manifestSha256,
      configuration: FAIR_MODEL_CONFIGURATION,
      cloudExecutionSummarySha256: summaryFile.sha256,
      cloudRunStatus: 'completed',
      graderCount: graderIds.length,
      gradeRequiredCount: numberedRecords.filter((record) => record.gradeRequired).length,
      packetFiles,
      records: numberedRecords.map((record) => ({
        recordId: record.recordId,
        arbitrationCaseId: record.arbitrationCaseId,
        gradeRequired: record.gradeRequired,
        rawFileSha256: record.rawFileSha256,
        systemId: record.systemId,
        offlineBase: record.offlineBase,
        blindCase: record.blindCase,
      })),
    };
    const manifestFile = await writePrivateJsonNoReplace(
      staging,
      'blind-review.private-manifest.json',
      manifest,
    );
    await fsp.rename(staging, outputRoot);
    published = true;
    return {
      outputRoot,
      manifestFile: path.join(outputRoot, path.basename(manifestFile.target)),
      manifestSha256: manifestFile.sha256,
      packetFiles: packetFiles.map((entry) => ({
        graderId: entry.graderId,
        file: path.join(outputRoot, entry.file),
        sha256: entry.sha256,
        caseCount: entry.caseCount,
      })),
      rawRecordCount: numberedRecords.length,
      gradeRequiredCount: manifest.gradeRequiredCount,
    };
  } finally {
    if (!published) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== 'blind-review-private-manifest' ||
      !Array.isArray(value.packetFiles) || value.packetFiles.length !== 2 ||
      !Array.isArray(value.records) || !value.records.length) {
    fail('The blind-review manifest is invalid.', 'INVALID_BLIND_MANIFEST');
  }
  assertSha256(value.datasetSha256, 'manifest.datasetSha256');
  assertSha256(value.snapshotManifestSha256, 'manifest.snapshotManifestSha256');
  if (!isDeepStrictEqual(value.configuration, FAIR_MODEL_CONFIGURATION)) {
    fail('The blind-review manifest configuration changed.', 'INVALID_BLIND_MANIFEST');
  }
  const records = new Map();
  for (const record of value.records) {
    const recordId = assertSafeId(record?.recordId, 'manifest recordId');
    if (records.has(recordId) || !Object.values(SYSTEM_IDS).includes(record?.systemId) ||
        typeof record?.gradeRequired !== 'boolean' || !record?.offlineBase) {
      fail('The blind-review manifest contains an invalid record.', 'INVALID_BLIND_MANIFEST');
    }
    if (record.gradeRequired && !record.blindCase) {
      fail('A graded manifest record is missing blind case data.', 'INVALID_BLIND_MANIFEST');
    }
    records.set(recordId, record);
  }
  return records;
}

async function loadManifest(manifestFile) {
  const filename = path.resolve(String(manifestFile || ''));
  const loaded = await readPrivateJsonFile(filename, 'blind-review manifest');
  const records = validateManifest(loaded.value);
  return { ...loaded, records, directory: path.dirname(filename) };
}

function graderCaseMaps(manifest) {
  const output = new Map();
  for (const packet of manifest.value.packetFiles) {
    const graderId = assertSafeId(packet?.graderId, 'manifest graderId');
    const expectedHash = assertSha256(packet?.sha256, 'manifest packet sha256');
    if (!Array.isArray(packet?.cases) || packet.cases.length !== Number(packet.caseCount)) {
      fail('A manifest packet case map is invalid.', 'INVALID_BLIND_MANIFEST');
    }
    const cases = new Map();
    for (const entry of packet.cases) {
      const caseId = assertSafeId(entry?.caseId, 'manifest caseId');
      const recordId = assertSafeId(entry?.recordId, 'manifest recordId');
      if (cases.has(caseId) || !manifest.records.get(recordId)?.gradeRequired) {
        fail('A manifest packet maps an invalid or duplicate case.', 'INVALID_BLIND_MANIFEST');
      }
      cases.set(caseId, recordId);
    }
    if (output.has(graderId)) fail('The manifest repeats a grader id.', 'INVALID_BLIND_MANIFEST');
    output.set(graderId, { expectedHash, cases });
  }
  return output;
}

function fixedCounts(record) {
  return {
    goldFactCount: Number(record.blindCase.fixedDenominators.goldFactCount),
    goldEvidenceCount: Number(record.blindCase.fixedDenominators.goldEvidenceCount),
  };
}

async function loadGraderResults(manifest, graderResultFiles) {
  if (!Array.isArray(graderResultFiles) || graderResultFiles.length !== 2) {
    fail('Exactly two blind grader result files are required.', 'INVALID_GRADER_SET');
  }
  const packetMaps = graderCaseMaps(manifest);
  for (const descriptor of manifest.value.packetFiles) {
    const packetFile = await readConfinedPrivateJson(
      manifest.directory,
      String(descriptor.file || ''),
      'blind grader packet',
    );
    const expectedPacket = {
      schemaVersion: 1,
      kind: 'blind-answer-review-packet',
      graderId: descriptor.graderId,
      datasetSha256: manifest.value.datasetSha256,
      snapshotManifestSha256: manifest.value.snapshotManifestSha256,
      systemIdentityIncluded: false,
      rubric: packetRubric(),
      caseCount: descriptor.caseCount,
      cases: descriptor.cases.map((entry) => ({
        caseId: entry.caseId,
        ...clone(manifest.records.get(entry.recordId).blindCase),
      })),
    };
    if (packetFile.sha256 !== descriptor.sha256 ||
        !isDeepStrictEqual(packetFile.value, expectedPacket)) {
      fail('A blind grader packet differs from its private manifest.', 'BLIND_PACKET_MISMATCH');
    }
    assertPacketBlind(packetFile.value);
  }
  const output = new Map();
  for (const filename of graderResultFiles) {
    const loaded = await readPrivateJsonFile(path.resolve(String(filename || '')), 'blind grader result');
    const result = loaded.value;
    const graderId = assertSafeId(result?.graderId, 'grader result graderId');
    const packet = packetMaps.get(graderId);
    if (!packet || result?.schemaVersion !== 1 || result?.kind !== 'blind-answer-review-result' ||
        String(result.manifestSha256 || '') !== manifest.sha256 ||
        String(result.packetSha256 || '') !== packet.expectedHash ||
        !Array.isArray(result.evaluations) || result.evaluations.length !== packet.cases.size ||
        output.has(graderId)) {
      fail('A blind grader result does not match its packet.', 'INVALID_GRADER_RESULT');
    }
    const evaluations = new Map();
    for (const entry of result.evaluations) {
      const caseId = assertSafeId(entry?.caseId, 'grader result caseId');
      const recordId = packet.cases.get(caseId);
      if (!recordId || evaluations.has(recordId)) {
        fail('A blind grader result has an unknown or duplicate case.', 'INVALID_GRADER_RESULT');
      }
      const record = manifest.records.get(recordId);
      evaluations.set(recordId, validateBlindEvaluation(entry.answerEvaluation, fixedCounts(record)));
    }
    output.set(graderId, evaluations);
  }
  if ([...packetMaps.keys()].some((graderId) => !output.has(graderId))) {
    fail('The two expected blind graders are not both represented.', 'INVALID_GRADER_SET');
  }
  return output;
}

function evaluationPairs(manifest, graderResults) {
  const graders = manifest.value.packetFiles.map((packet) => packet.graderId);
  return [...manifest.records.values()].filter((record) => record.gradeRequired).map((record) => ({
    record,
    left: graderResults.get(graders[0]).get(record.recordId),
    right: graderResults.get(graders[1]).get(record.recordId),
  }));
}

function arbitrationPacketValue(manifest, pairs) {
  const cases = pairs.filter((pair) => !blindEvaluationsEqual(pair.left, pair.right)).map((pair) => ({
    caseId: pair.record.arbitrationCaseId,
    ...clone(pair.record.blindCase),
    reviews: [
      { reviewer: 'Reviewer-X', answerEvaluation: pair.left },
      { reviewer: 'Reviewer-Y', answerEvaluation: pair.right },
    ],
  }));
  cases.sort((left, right) => left.caseId.localeCompare(right.caseId));
  return {
    schemaVersion: 1,
    kind: 'blind-answer-arbitration-packet',
    manifestSha256: manifest.sha256,
    systemIdentityIncluded: false,
    rubric: packetRubric(),
    caseCount: cases.length,
    cases,
  };
}

/** Write only the disagreement cases, still without system or performance metadata. */
export async function createBlindArbitrationPacket(options = {}) {
  const manifest = await loadManifest(options.manifestFile);
  const graderResults = await loadGraderResults(manifest, options.graderResultFiles);
  const packet = arbitrationPacketValue(manifest, evaluationPairs(manifest, graderResults));
  assertPacketBlind(packet);
  if (!packet.caseCount) {
    return { required: false, conflictCount: 0, packetFile: null, packetSha256: null };
  }
  const outputFile = path.resolve(String(options.outputFile || ''));
  const parent = await privateDirectory(path.dirname(outputFile), 'arbitration output parent');
  if (path.dirname(outputFile) !== parent || path.extname(outputFile) !== '.json') {
    fail('The arbitration output path is unsafe.', 'UNSAFE_PRIVATE_PATH');
  }
  const written = await writePrivateJsonNoReplace(parent, path.basename(outputFile), packet);
  return {
    required: true,
    conflictCount: packet.caseCount,
    packetFile: written.target,
    packetSha256: written.sha256,
  };
}

async function arbitrationEvaluations(manifest, pairs, packetFile, resultFile) {
  const expected = arbitrationPacketValue(manifest, pairs);
  const packet = await readPrivateJsonFile(path.resolve(String(packetFile || '')), 'arbitration packet');
  if (!isDeepStrictEqual(packet.value, expected)) {
    fail('The arbitration packet differs from the blind-review disagreements.', 'INVALID_ARBITRATION');
  }
  const result = await readPrivateJsonFile(path.resolve(String(resultFile || '')), 'arbitration result');
  if (result.value?.schemaVersion !== 1 || result.value?.kind !== 'blind-answer-arbitration-result' ||
      result.value?.packetSha256 !== packet.sha256 || !Array.isArray(result.value?.evaluations) ||
      result.value.evaluations.length !== expected.caseCount) {
    fail('The arbitration result does not match its packet.', 'INVALID_ARBITRATION');
  }
  const idToPair = new Map(pairs.filter((pair) => !blindEvaluationsEqual(pair.left, pair.right))
    .map((pair) => [pair.record.arbitrationCaseId, pair]));
  const output = new Map();
  for (const entry of result.value.evaluations) {
    const caseId = assertSafeId(entry?.caseId, 'arbitration caseId');
    const pair = idToPair.get(caseId);
    if (!pair || output.has(pair.record.recordId)) {
      fail('The arbitration result has an unknown or duplicate case.', 'INVALID_ARBITRATION');
    }
    output.set(
      pair.record.recordId,
      validateBlindEvaluation(entry.answerEvaluation, fixedCounts(pair.record)),
    );
  }
  return output;
}

/** Merge agreed reviews plus explicit arbitration into compare CLI offline-results. */
export async function mergeBlindReviewResults(options = {}) {
  const manifest = await loadManifest(options.manifestFile);
  const graderResults = await loadGraderResults(manifest, options.graderResultFiles);
  const pairs = evaluationPairs(manifest, graderResults);
  const conflicts = pairs.filter((pair) => !blindEvaluationsEqual(pair.left, pair.right));
  let arbitrated = new Map();
  if (conflicts.length) {
    if (!options.arbitrationPacketFile || !options.arbitrationResultFile) {
      fail(
        'Blind reviews disagree; an identity-hidden arbitration result is required.',
        'BLIND_EVALUATION_DISAGREEMENT',
        { conflictCount: conflicts.length },
      );
    }
    arbitrated = await arbitrationEvaluations(
      manifest,
      pairs,
      options.arbitrationPacketFile,
      options.arbitrationResultFile,
    );
  } else if (options.arbitrationPacketFile || options.arbitrationResultFile) {
    fail('No blind-review disagreement exists, so arbitration input is unexpected.', 'INVALID_ARBITRATION');
  }
  const resolved = new Map();
  for (const pair of pairs) {
    resolved.set(pair.record.recordId, resolveBlindEvaluation(pair.left, pair.right, {
      ...(arbitrated.has(pair.record.recordId)
        ? { arbitration: arbitrated.get(pair.record.recordId) }
        : {}),
    }));
  }
  const systems = ['original-agent', 'migrated-rag'].map((systemId) => ({
    id: systemId,
    records: [...manifest.records.values()].filter((record) => record.systemId === systemId)
      .map((record) => ({
        ...clone(record.offlineBase),
        ...(record.gradeRequired
          ? { answerEvaluation: resolved.get(record.recordId) }
          : {}),
      })),
  }));
  if (systems.some((system) => !system.records.length)) {
    fail('The blind-review manifest does not contain both benchmark systems.', 'INVALID_BLIND_MANIFEST');
  }
  const offlineResults = {
    schemaVersion: 1,
    datasetSha256: manifest.value.datasetSha256,
    snapshotManifestSha256: manifest.value.snapshotManifestSha256,
    configuration: FAIR_MODEL_CONFIGURATION,
    systems,
  };
  if (!options.outputFile) return { offlineResults, conflictCount: conflicts.length };
  const outputFile = path.resolve(String(options.outputFile));
  const parent = await privateDirectory(path.dirname(outputFile), 'offline output parent');
  if (path.dirname(outputFile) !== parent || path.extname(outputFile) !== '.json') {
    fail('The offline-results output path is unsafe.', 'UNSAFE_PRIVATE_PATH');
  }
  const written = await writePrivateJsonNoReplace(parent, path.basename(outputFile), offlineResults);
  return {
    offlineResults,
    outputFile: written.target,
    outputSha256: written.sha256,
    conflictCount: conflicts.length,
    systems: systems.length,
    records: systems.reduce((sum, system) => sum + system.records.length, 0),
  };
}

export const benchmarkAdjudicationInternals = Object.freeze({
  assertPacketBlind,
  arbitrationPacketValue,
  blindCase,
  evidenceCount,
  rawRecordToSource,
  readPrivateJsonFile,
  writePrivateJsonNoReplace,
});
