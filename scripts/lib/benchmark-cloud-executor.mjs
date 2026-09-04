import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChatModelClient } from '../../src/llm-client.mjs';
import {
  BENCHMARK_BUDGET_CNY,
  BENCHMARK_EFFORT,
  BENCHMARK_MAX_OUTPUT_TOKENS,
  BENCHMARK_MODEL,
  BudgetLedger,
  createInstrumentedAnthropicFetch,
  startAnthropicBenchmarkProxy,
} from './benchmark-runtime.mjs';
import { assertDatasetApproved, runPairedBenchmark } from './benchmark-scheduler.mjs';
import {
  DEFAULT_LIVE_VAULT_ROOT,
  MigratedRagRunner,
  OriginalAgentRunner,
  snapshotManifest,
} from './benchmark-systems.mjs';
import {
  captureProductionState,
  compareProductionState,
} from './benchmark-production-guard.mjs';

export const OFFICIAL_ANTHROPIC_COMPATIBLE_BASE_URL =
  'https://dashscope.aliyuncs.com/apps/anthropic';
export const OFFICIAL_ANTHROPIC_MESSAGES_URL =
  `${OFFICIAL_ANTHROPIC_COMPATIBLE_BASE_URL}/v1/messages`;
export const CREDENTIAL_JSON_SELECTOR = Object.freeze([
  'env',
  'ANTHROPIC_AUTH_TOKEN',
]);

const PUBLIC_PROBE_ID = 'PUBLIC-PROBE';
const PUBLIC_PROBE_PROMPT =
  'Public synthetic connectivity check. Reply with exactly the two letters OK.';
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;
const SAFE_FILE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export class BenchmarkCloudExecutorError extends Error {
  constructor(message, code = 'BENCHMARK_CLOUD_EXECUTOR_ERROR', options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BenchmarkCloudExecutorError';
    this.code = code;
  }
}

function cloudError(message, code, cause) {
  return new BenchmarkCloudExecutorError(message, code, cause ? { cause } : {});
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameManifest(left, right) {
  return left?.sha256 === right?.sha256 && left?.fileCount === right?.fileCount &&
    left?.directoryCount === right?.directoryCount && left?.totalBytes === right?.totalBytes;
}

function safePart(input, fallback = 'record') {
  const candidate = String(input || '').trim();
  if (SAFE_FILE_PART.test(candidate)) return candidate;
  if (!candidate) return fallback;
  return `anon-${crypto.createHash('sha256').update(candidate).digest('hex').slice(0, 16)}`;
}

function safeErrorCode(error, fallback = 'CLOUD_EXECUTION_FAILED') {
  const candidate = String(error?.code || error?.name || fallback).toUpperCase();
  return /^[A-Z0-9_]{2,80}$/u.test(candidate) ? candidate : fallback;
}

function exactUpstreamUrl(value) {
  const supplied = String(value || OFFICIAL_ANTHROPIC_MESSAGES_URL);
  if (supplied !== OFFICIAL_ANTHROPIC_MESSAGES_URL) {
    throw cloudError(
      'The cloud executor accepts only the pinned official Anthropic-compatible Messages URL.',
      'UPSTREAM_URL_NOT_PINNED',
    );
  }
  const parsed = new URL(supplied);
  if (
    parsed.protocol !== 'https:' || parsed.origin !== 'https://dashscope.aliyuncs.com' ||
    parsed.pathname !== '/apps/anthropic/v1/messages' || parsed.username || parsed.password ||
    parsed.search || parsed.hash
  ) {
    throw cloudError('The pinned upstream URL failed validation.', 'UPSTREAM_URL_NOT_PINNED');
  }
  return supplied;
}

async function realDirectory(input, label) {
  if (!path.isAbsolute(String(input || ''))) {
    throw cloudError(`${label} must be an absolute directory path.`, 'UNSAFE_CLOUD_PATH');
  }
  const target = path.resolve(String(input));
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw cloudError(`${label} must be a real directory.`, 'UNSAFE_CLOUD_PATH');
  }
  return fsp.realpath(target);
}

async function privateDirectory(input, label) {
  if (!path.isAbsolute(String(input || ''))) {
    throw cloudError(`${label} must be an absolute directory path.`, 'UNSAFE_CLOUD_PATH');
  }
  const target = path.resolve(String(input));
  await fsp.mkdir(target, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw cloudError(`${label} must be a real directory.`, 'UNSAFE_CLOUD_PATH');
  }
  await fsp.chmod(target, 0o700);
  return fsp.realpath(target);
}

function assertSeparated(left, right, code = 'UNSAFE_CLOUD_PATH') {
  if (isInside(left, right) || isInside(right, left)) {
    throw cloudError('Cloud benchmark state and source data must use separate trees.', code);
  }
}

/**
 * Read only the fixed settings.json field used by the approved provider. The
 * value is returned to the caller but is never attached to an error or result.
 */
export async function readBenchmarkCredential(credentialFileInput) {
  if (!path.isAbsolute(String(credentialFileInput || ''))) {
    throw cloudError('credentialFile must be an explicit absolute path.', 'CREDENTIAL_FILE_REQUIRED');
  }
  const credentialFile = path.resolve(String(credentialFileInput));
  let handle;
  try {
    handle = await fsp.open(
      credentialFile,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    throw cloudError('The credential file must be a regular file.', 'UNSAFE_CREDENTIAL_FILE', error);
  }
  let parsed;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw cloudError('The credential file must be an unlinked regular file.', 'UNSAFE_CREDENTIAL_FILE');
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw cloudError('The credential file must have mode 0600.', 'UNSAFE_CREDENTIAL_MODE');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw cloudError('The credential file must be owned by the current user.', 'UNSAFE_CREDENTIAL_OWNER');
    }
    if (stat.size <= 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw cloudError('The credential file size is outside the safety bound.', 'UNSAFE_CREDENTIAL_FILE');
    }
    parsed = JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error instanceof BenchmarkCloudExecutorError) throw error;
    throw cloudError('The credential file is not valid JSON.', 'INVALID_CREDENTIAL_FILE', error);
  } finally {
    await handle.close().catch(() => {});
  }
  const token = parsed?.env?.ANTHROPIC_AUTH_TOKEN;
  if (typeof token !== 'string' || token.trim().length < 8 || token.length > 16_384) {
    throw cloudError(
      'The fixed credential field env.ANTHROPIC_AUTH_TOKEN is unavailable.',
      'CREDENTIAL_FIELD_MISSING',
    );
  }
  return token.trim();
}

function assertNoSecrets(value, secrets, code = 'SECRET_PERSISTENCE_BLOCKED') {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8 && serialized.includes(secret)) {
      throw cloudError('A credential was detected in benchmark persistence data.', code);
    }
  }
  return serialized;
}

async function writePrivateJson(directory, basename, value, secrets = []) {
  const target = path.join(directory, basename);
  if (path.dirname(target) !== directory || !basename.endsWith('.json')) {
    throw cloudError('Private result filename is unsafe.', 'UNSAFE_RESULT_PATH');
  }
  const serialized = `${assertNoSecrets(value, secrets)}\n`;
  const temporary = path.join(directory, `.${basename}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // link() is an atomic no-replace publication: an existing result can never
    // be overwritten by a repeated or misdirected run.
    await fsp.link(temporary, target);
    await fsp.unlink(temporary);
    await fsp.chmod(target, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
  return target;
}

async function removePrivateRunnerState(privateRoot) {
  const target = path.join(privateRoot, 'runner-state');
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(target) !== privateRoot) {
    throw cloudError('The runner-state cleanup target is unsafe.', 'UNSAFE_RESULT_PATH');
  }
  await fsp.rm(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 25 });
  if (await fsp.lstat(target).catch(() => null)) {
    throw cloudError('The ephemeral runner state could not be removed.', 'STATE_CLEANUP_FAILED');
  }
}

export async function loadOriginalAgentSdkQuery(originalRootInput) {
  const originalRoot = await realDirectory(originalRootInput, 'originalRoot');
  const sdkFile = path.join(
    originalRoot,
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'sdk.mjs',
  );
  const stat = await fsp.lstat(sdkFile).catch(() => null);
  const realFile = stat?.isFile() && !stat.isSymbolicLink()
    ? await fsp.realpath(sdkFile)
    : '';
  if (!realFile || !isInside(originalRoot, realFile)) {
    throw cloudError('The original Claude Agent SDK entry is unavailable.', 'ORIGINAL_SDK_UNAVAILABLE');
  }
  const module = await import(pathToFileURL(realFile).href);
  if (typeof module.query !== 'function') {
    throw cloudError('The original Claude Agent SDK query export is unavailable.', 'ORIGINAL_SDK_UNAVAILABLE');
  }
  return module.query;
}

function modelClientConfig(proxy, timeoutMs, maxOutputTokens = BENCHMARK_MAX_OUTPUT_TOKENS) {
  return {
    provider: 'anthropic',
    apiBase: proxy.url,
    apiKey: proxy.clientToken,
    model: BENCHMARK_MODEL,
    temperature: 0,
    maxOutputTokens,
    timeoutMs,
    allowInsecureHttp: true,
  };
}

function telemetryCursorProvider(proxy, initialCursor = 0) {
  let cursor = initialCursor;
  return {
    get cursor() { return cursor; },
    async consume(context = {}) {
      const all = proxy.records();
      const cursorStart = cursor;
      const records = all.slice(cursorStart);
      if (!records.length) {
        throw cloudError('A runner completed without proxy telemetry.', 'PROXY_TELEMETRY_MISSING');
      }
      const expectedAnonymousId = String(context.anonymousId || '');
      if (!SAFE_FILE_PART.test(expectedAnonymousId) ||
          records.some((record) => record?.anonymousId !== expectedAnonymousId)) {
        throw cloudError(
          'Proxy telemetry did not belong exclusively to the active anonymous task.',
          'PROXY_TELEMETRY_ID_MISMATCH',
        );
      }
      cursor = all.length;
      return {
        cursorStart,
        cursorEnd: cursor,
        recordCount: records.length,
        expectedAnonymousId,
        system: String(context.system || ''),
        records,
      };
    },
  };
}

function aggregateTelemetryUsage(records) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  if (!Array.isArray(records) || !records.length) {
    throw cloudError('The probe produced no telemetry.', 'PUBLIC_PROBE_FAILED');
  }
  for (const record of records) {
    if (record?.errorCode || !record?.usage) {
      throw cloudError('The probe did not produce complete Usage telemetry.', 'PUBLIC_PROBE_FAILED');
    }
    for (const field of Object.keys(usage)) {
      const value = Number(record.usage[field]);
      if (!Number.isInteger(value) || value < 0) {
        throw cloudError('The probe Usage telemetry is invalid.', 'PUBLIC_PROBE_FAILED');
      }
      usage[field] += value;
    }
  }
  if (usage.inputTokens + usage.outputTokens <= 0) {
    throw cloudError('The probe Usage telemetry is empty.', 'PUBLIC_PROBE_FAILED');
  }
  return usage;
}

async function runPublicProbe({ proxy, ledger, timeoutMs, secrets, privateRoot }) {
  const cursorStart = proxy.records().length;
  const budgetBefore = await ledger.status();
  const fetch = createInstrumentedAnthropicFetch({
    proxyUrl: proxy.url,
    clientToken: proxy.clientToken,
    anonymousId: PUBLIC_PROBE_ID,
  });
  const client = new ChatModelClient(
    // Medium effort can spend dozens of output tokens on hidden reasoning
    // before emitting visible text. Keep the same approved per-request ceiling
    // as the benchmark so a tiny connectivity probe cannot be truncated before
    // its two-letter answer appears.
    modelClientConfig(proxy, timeoutMs, BENCHMARK_MAX_OUTPUT_TOKENS),
    { fetch },
  );
  const answer = await client.generate(
    [{ role: 'user', content: PUBLIC_PROBE_PROMPT }],
    {
      model: BENCHMARK_MODEL,
      effort: BENCHMARK_EFFORT,
      reasoningEffort: BENCHMARK_EFFORT,
      temperature: 0,
      maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
    },
  );
  if (!String(answer || '').trim()) {
    throw cloudError('The public synthetic probe returned no text.', 'PUBLIC_PROBE_FAILED');
  }
  const all = proxy.records();
  const records = all.slice(cursorStart);
  const usage = aggregateTelemetryUsage(records);
  const budgetAfter = await ledger.status();
  if (
    budgetAfter.openReservations !== 0 || budgetAfter.uncertainCny !== 0 ||
    budgetAfter.settledCny < budgetBefore.settledCny || !budgetAfter.canStart
  ) {
    throw cloudError('The shared budget gate failed after the public probe.', 'PROBE_BUDGET_GATE_FAILED');
  }
  const probe = {
    schemaVersion: 1,
    anonymousId: PUBLIC_PROBE_ID,
    publicSynthetic: true,
    answerPresent: true,
    usage,
    telemetry: {
      cursorStart,
      cursorEnd: all.length,
      recordCount: records.length,
      records,
    },
    budgetBefore,
    budgetAfter,
    estimatedCostCny: Number((budgetAfter.settledCny - budgetBefore.settledCny).toFixed(9)),
  };
  // The proxy is body-blind. This explicit assertion makes that contract a
  // prerequisite for any private question to start.
  assertNoSecrets(probe, [...secrets, PUBLIC_PROBE_PROMPT], 'PROBE_REDACTION_FAILED');
  const resultFile = await writePrivateJson(privateRoot, 'public-probe.json', probe, secrets);
  return { ...probe, resultFile };
}

function finiteTelemetryNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sanitizedBudgetStatus(value) {
  if (!value || typeof value !== 'object') return null;
  const output = {};
  for (const field of [
    'settledCny', 'activeReservedCny', 'uncertainCny', 'committedCny',
    'remainingToSoftCny', 'remainingToHardCny', 'softLimitCny', 'hardLimitCny',
    'openReservations',
  ]) {
    output[field] = finiteTelemetryNumber(value[field]);
  }
  for (const field of ['canStart', 'hardExceeded']) output[field] = value[field] === true;
  return output;
}

function sanitizedTelemetryState(proxy, cursor) {
  let records = [];
  try { records = proxy?.records?.() || []; } catch {}
  const consumedRecords = Math.min(
    records.length,
    Math.max(0, Number.isInteger(cursor?.cursor) ? cursor.cursor : 0),
  );
  return {
    recordCount: records.length,
    consumedRecords,
    unconsumedRecords: records.length - consumedRecords,
    records: records.map((record) => ({
      anonymousId: safePart(record?.anonymousId, 'anonymous'),
      attempt: Number.isInteger(record?.attempt) && record.attempt > 0 ? record.attempt : null,
      usage: record?.usage ? Object.fromEntries([
        'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens',
      ].map((field) => [field, finiteTelemetryNumber(record.usage[field])])) : null,
      timing: Object.fromEntries([
        'ttfbMs', 'firstSseMs', 'firstVisibleTextMs', 'completedMs',
      ].map((field) => [field, finiteTelemetryNumber(record?.timing?.[field])])),
      errorCode: record?.errorCode ? safeErrorCode({ code: record.errorCode }) : null,
    })),
  };
}

function anonymousBenchmarkSummary(result) {
  if (!result || typeof result !== 'object') return result;
  const schedule = Array.isArray(result.schedule)
    ? result.schedule.map(({ question: _privateQuestion, ...descriptor }) => descriptor)
    : result.schedule;
  return {
    ...result,
    ...(schedule === undefined ? {} : { schedule }),
  };
}

function makeFailure(error, checks = {}) {
  return {
    schemaVersion: 1,
    status: 'failed',
    errorCode: safeErrorCode(error),
    snapshotUnchanged: checks.snapshotUnchanged ?? null,
    productionUnchanged: checks.productionUnchanged ?? null,
    budget: sanitizedBudgetStatus(checks.budget),
    telemetry: checks.telemetry || {
      recordCount: 0,
      consumedRecords: 0,
      unconsumedRecords: 0,
      records: [],
    },
  };
}

async function emitProgress(callback, value) {
  if (!callback) return;
  const event = Object.freeze(structuredClone(value));
  try {
    await callback(event);
  } catch (error) {
    throw cloudError('The anonymous progress callback failed.', 'PROGRESS_CALLBACK_FAILED', error);
  }
}

/**
 * Execute the mandatory public probe and then an approved paired benchmark.
 * The default is calibration-only (four paired questions). No provider call is
 * possible until the production baseline, read-only snapshot manifest, fixed
 * upstream, and 0600 credential file have all passed validation.
 */
export async function executeCloudBenchmark(options = {}, dependencies = {}) {
  const upstreamUrl = exactUpstreamUrl(options.upstreamUrl);
  if (options.calibrationOnly !== undefined && typeof options.calibrationOnly !== 'boolean') {
    throw cloudError('calibrationOnly must be boolean.', 'INVALID_CLOUD_OPTION');
  }
  const calibrationOnly = options.calibrationOnly !== false;
  const timeoutMs = Number(options.modelTimeoutMs || 180_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw cloudError('modelTimeoutMs must be an integer from 1000 to 900000.', 'INVALID_CLOUD_OPTION');
  }
  if (!options.dataset) {
    throw cloudError('An approved dataset is required.', 'DATASET_REQUIRED');
  }
  // This must run before the public probe as well as before any private model
  // call; approval is the global egress gate for the benchmark invocation.
  assertDatasetApproved(options.dataset);
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw cloudError('onProgress must be a function.', 'INVALID_CLOUD_OPTION');
  }
  const onProgress = options.onProgress || null;

  const snapshotRoot = await realDirectory(options.snapshotRoot, 'snapshotRoot');
  const originalRoot = await realDirectory(options.originalRoot, 'originalRoot');
  const privateRoot = await privateDirectory(options.privateRunRoot, 'privateRunRoot');
  assertSeparated(snapshotRoot, privateRoot);
  if ((await fsp.readdir(privateRoot)).length !== 0) {
    throw cloudError('privateRunRoot must be empty for a new cloud execution.', 'PRIVATE_RUN_NOT_EMPTY');
  }
  const rawRoot = await privateDirectory(path.join(privateRoot, 'raw'), 'rawRoot');
  const originalRunRoot = path.join(privateRoot, 'runner-state', 'original');
  const migratedRunRoot = path.join(privateRoot, 'runner-state', 'migrated');
  const liveVaultRoot = Object.hasOwn(options, 'liveVaultRoot')
    ? options.liveVaultRoot
    : DEFAULT_LIVE_VAULT_ROOT;

  const snapshotBefore = await snapshotManifest(snapshotRoot);
  const originalQueryFn = dependencies.originalQueryFn ||
    await loadOriginalAgentSdkQuery(originalRoot);
  if (typeof originalQueryFn !== 'function') {
    throw cloudError('The original SDK query function is unavailable.', 'ORIGINAL_SDK_UNAVAILABLE');
  }

  const ledger = options.budgetLedger || new BudgetLedger({
    limits: { soft: BENCHMARK_BUDGET_CNY.soft, hard: BENCHMARK_BUDGET_CNY.hard },
  });
  for (const method of ['reserve', 'settle', 'markUncertain', 'status']) {
    if (typeof ledger?.[method] !== 'function') {
      throw cloudError('budgetLedger does not implement the required contract.', 'INVALID_BUDGET_LEDGER');
    }
  }
  const productionBefore = await captureProductionState(options.productionGuardOptions || {});

  let upstreamCredential = '';
  let proxy;
  let executionResult;
  let executionError;
  let snapshotAfter;
  let productionAfter;
  let snapshotUnchanged = null;
  let productionUnchanged = null;
  const rawFiles = [];
  let recordSequence = 0;
  let probe;
  let cursor = null;
  try {
    await emitProgress(onProgress, {
      event: 'preflight-complete',
      snapshotSha256: snapshotBefore.sha256,
      calibrationOnly,
    });
    upstreamCredential = await readBenchmarkCredential(options.credentialFile);
    proxy = await startAnthropicBenchmarkProxy({
      upstreamUrl,
      allowedUpstreamOrigins: ['https://dashscope.aliyuncs.com'],
      upstreamApiKey: upstreamCredential,
      ledger,
      fetch: dependencies.upstreamFetch || globalThis.fetch,
      maxUpstreamAttempts: 1,
    });
    const secrets = [upstreamCredential, proxy.clientToken];
    let activeMigratedAnonymousId = 'UNASSIGNED';
    const migratedFetch = createInstrumentedAnthropicFetch({
      proxyUrl: proxy.url,
      clientToken: proxy.clientToken,
      anonymousId: () => activeMigratedAnonymousId,
    });
    const migratedLlm = new ChatModelClient(
      modelClientConfig(proxy, timeoutMs),
      { fetch: migratedFetch },
    );
    const telemetryProvider = (context) => {
      if (!cursor) {
        throw cloudError('Private telemetry is unavailable before the public probe.',
          'PROXY_TELEMETRY_NOT_READY');
      }
      return cursor.consume(context);
    };
    const originalRunner = new OriginalAgentRunner({
      originalRoot,
      snapshotRoot,
      runRoot: originalRunRoot,
      liveVaultRoot,
      queryFn: originalQueryFn,
      sdkEnv: {
        ANTHROPIC_BASE_URL: proxy.url,
        ANTHROPIC_API_KEY: proxy.clientToken,
      },
      telemetryProvider,
      topK: options.topK,
    });
    const migratedRunner = new MigratedRagRunner({
      snapshotRoot,
      runRoot: migratedRunRoot,
      liveVaultRoot,
      llm: migratedLlm,
      telemetryProvider,
      topK: options.topK,
      deepTopK: options.deepTopK,
      maxContextChars: options.maxContextChars,
    });
    // Initialization performs path/import validation only. Doing it before the
    // probe prevents a paid request when the live-Vault boundary or either
    // business implementation is unavailable.
    await Promise.all([originalRunner.initialize(), migratedRunner.initialize()]);
    probe = await runPublicProbe({
      proxy,
      ledger,
      timeoutMs,
      secrets,
      privateRoot,
    });
    await emitProgress(onProgress, {
      event: 'public-probe-complete',
      usage: probe.usage,
      estimatedCostCny: probe.estimatedCostCny,
      committedCny: probe.budgetAfter.committedCny,
    });
    cursor = telemetryCursorProvider(proxy, probe.telemetry.cursorEnd);
    const runnerA = async (invocation) => originalRunner.runQuestion(invocation);
    const runnerB = async (invocation) => {
      activeMigratedAnonymousId = invocation.anonymousId;
      try {
        return await migratedRunner.runQuestion(invocation);
      } finally {
        activeMigratedAnonymousId = 'UNASSIGNED';
      }
    };
    executionResult = await runPairedBenchmark({
      dataset: options.dataset,
      runnerA,
      runnerB,
      budgetLedger: ledger,
      budgetOwnership: 'runner',
      stopAfterCalibration: calibrationOnly,
      concurrency: 1,
      seed: options.seed,
      softLimitCny: options.softLimitCny,
      deepCostMultiplier: options.deepCostMultiplier,
      reservationFor: options.reservationFor,
      onCalibrationComplete: async ({ forecast }) => {
        await emitProgress(onProgress, {
          event: 'calibration-decision',
          forecastStatus: forecast.status,
          selectedTier: forecast.selectedTier,
          currentCommittedCny: forecast.currentCommittedCny,
          projectedTotalCny: forecast.projectedTotalCny,
          projectedRemainingCny: forecast.projectedRemainingCny,
          minimumProjectedTotalCny: forecast.minimumProjectedTotalCny,
          softLimitCny: forecast.softLimitCny,
          hardLimitCny: forecast.hardLimitCny,
        });
      },
      onRecord: async (record, rawResult) => {
        recordSequence += 1;
        const name = [
          String(recordSequence).padStart(3, '0'),
          safePart(record.phase, 'phase'),
          safePart(record.questionId, 'question'),
          safePart(record.system, 'system'),
        ].join('-');
        const file = await writePrivateJson(rawRoot, `${name}.json`, {
          schemaVersion: 1,
          schedulerRecord: record,
          rawResult: rawResult ?? null,
        }, secrets);
        rawFiles.push(path.relative(privateRoot, file));
        await emitProgress(onProgress, {
          event: 'question-run-complete',
          sequence: recordSequence,
          anonymousId: String(rawResult?.anonymousId || record.sessionId || ''),
          system: record.system,
          phase: record.phase,
          mode: record.mode,
          round: record.round,
          status: record.status,
          costCny: record.costCny,
        });
      },
    });
    const finalCursor = proxy.records().length;
    if (cursor.cursor !== finalCursor) {
      throw cloudError('Unassigned proxy telemetry remained after scheduling.', 'PROXY_TELEMETRY_UNASSIGNED');
    }
  } catch (error) {
    executionError = error;
  } finally {
    if (proxy) {
      try {
        await proxy.close();
      } catch (error) {
        executionError ||= cloudError('The local benchmark proxy failed to close.', 'PROXY_CLOSE_FAILED', error);
      }
    }
    try {
      await removePrivateRunnerState(privateRoot);
    } catch (error) {
      executionError ||= error;
    }
    try {
      snapshotAfter = await snapshotManifest(snapshotRoot);
      snapshotUnchanged = sameManifest(snapshotBefore, snapshotAfter);
      if (!snapshotUnchanged) {
        executionError ||= cloudError('The benchmark snapshot changed.', 'SNAPSHOT_MUTATED');
      }
    } catch (error) {
      executionError ||= error;
    }
    try {
      productionAfter = await captureProductionState(options.productionGuardOptions || {});
      compareProductionState(productionBefore, productionAfter);
      productionUnchanged = true;
    } catch (error) {
      productionUnchanged = false;
      executionError ||= error;
    }
  }

  const persistenceSecrets = [upstreamCredential, proxy?.clientToken || ''];
  if (executionError) {
    const budget = await ledger.status().catch(() => null);
    const failure = makeFailure(executionError, {
      snapshotUnchanged,
      productionUnchanged,
      budget,
      telemetry: sanitizedTelemetryState(proxy, cursor),
    });
    await writePrivateJson(privateRoot, 'cloud-execution-failure.json', failure, persistenceSecrets)
      .catch(() => {});
    upstreamCredential = '';
    throw executionError;
  }

  const summary = {
    schemaVersion: 1,
    status: executionResult.status,
    calibrationOnly,
    configuration: {
      model: BENCHMARK_MODEL,
      effort: BENCHMARK_EFFORT,
      temperature: 0,
      maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
      webSearch: false,
      upstream: OFFICIAL_ANTHROPIC_MESSAGES_URL,
    },
    probe,
    benchmark: anonymousBenchmarkSummary(executionResult),
    budget: await ledger.status(),
    rawFiles,
    integrity: {
      snapshot: { before: snapshotBefore, after: snapshotAfter, unchanged: snapshotUnchanged },
      production: {
        before: productionBefore,
        after: productionAfter,
        unchanged: productionUnchanged,
      },
    },
  };
  // Do not include the absolute credential path, the credential selector's
  // value, or either proxy/upstream token in the private result bundle.
  const summaryFile = await writePrivateJson(
    privateRoot,
    'cloud-execution-summary.json',
    summary,
    persistenceSecrets,
  );
  await emitProgress(onProgress, {
    event: 'execution-complete',
    status: summary.status,
    calibrationOnly,
    resultCount: executionResult.records.length,
    committedCny: summary.budget.committedCny,
    snapshotUnchanged,
    productionUnchanged,
  });
  upstreamCredential = '';
  return {
    ...summary,
    privateRunRoot: privateRoot,
    summaryFile,
  };
}

export const benchmarkCloudExecutorInternals = Object.freeze({
  PUBLIC_PROBE_ID,
  PUBLIC_PROBE_PROMPT,
  aggregateTelemetryUsage,
  assertNoSecrets,
  exactUpstreamUrl,
  sameManifest,
  anonymousBenchmarkSummary,
  sanitizedBudgetStatus,
  sanitizedTelemetryState,
  telemetryCursorProvider,
  writePrivateJson,
});
