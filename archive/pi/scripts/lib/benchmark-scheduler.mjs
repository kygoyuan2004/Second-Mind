import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  BENCHMARK_BUDGET_CNY,
  BENCHMARK_MAX_OUTPUT_TOKENS,
  BudgetLedger,
  estimateUsageCostCny,
} from './benchmark-runtime.mjs';

export const DEFAULT_SCHEDULER_SEED = 'vaultmind-benchmark-2026-08-31';
export const DEFAULT_CONCURRENCY = 1;
export const DEFAULT_BUDGET_OWNERSHIP = 'scheduler';
export const CALIBRATION_QUESTION_COUNT = 4;
export const TARGET_PLAN = Object.freeze({
  normalQuestions: 48,
  deepQuestions: 8,
  repeatedNormalQuestions: 12,
  additionalNormalRounds: 2,
});

const SYSTEMS = Object.freeze(['agent', 'rag']);
const COMPLEX_CATEGORIES = new Set(['cross_document', 'temporal_conflict']);
const ZERO_USAGE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

export class BenchmarkSchedulerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BenchmarkSchedulerError';
    this.code = code;
    this.details = { ...details };
  }
}

function fail(message, code, details) {
  throw new BenchmarkSchedulerError(message, code, details);
}

function finiteNonnegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    fail(`${label} must be a finite non-negative number.`, 'INVALID_SCHEDULER_OPTION');
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    fail(`${label} must be a positive integer.`, 'INVALID_SCHEDULER_OPTION');
  }
  return number;
}

function seedWords(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  return [0, 4, 8, 12].map((offset) => digest.readUInt32LE(offset));
}

function seededGenerator(seed) {
  let [a, b, c, d] = seedWords(seed);
  return () => {
    const temporary = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + temporary) >>> 0;
    return temporary / 0x1_0000_0000;
  };
}

/** A stable Fisher-Yates shuffle; it never mutates the caller's array. */
export function deterministicShuffle(values, seed = DEFAULT_SCHEDULER_SEED) {
  const shuffled = [...values];
  const random = seededGenerator(seed);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function itemReviewStatus(item) {
  return String(item?.review?.status || item?.reviewStatus || item?.review || '').trim();
}

/** Fail closed before a runner, ledger, or persistence callback can be touched. */
export function assertDatasetApproved(dataset) {
  const status = String(dataset?.reviewStatus || dataset?.review?.status || '').trim();
  const items = Array.isArray(dataset?.items) ? dataset.items : [];
  if (status !== 'approved' || !items.length) {
    fail('The private benchmark dataset has not been approved.', 'DATASET_NOT_APPROVED');
  }
  if (dataset.executionAllowed !== true) {
    fail(
      'The approved private benchmark dataset is not authorized for execution.',
      'DATASET_EXECUTION_NOT_ALLOWED',
    );
  }
  const unapproved = items.filter((item) => itemReviewStatus(item) !== 'approved');
  if (unapproved.length) {
    fail('At least one benchmark question has not been approved.', 'DATASET_NOT_APPROVED', {
      count: unapproved.length,
    });
  }
  const identifiers = new Set();
  for (const item of items) {
    const id = String(item?.id || '');
    if (!id || identifiers.has(id)) {
      fail('Benchmark question identifiers must be present and unique.', 'INVALID_DATASET');
    }
    identifiers.add(id);
  }
  if (items.length < TARGET_PLAN.normalQuestions) {
    fail('The approved plan requires at least 48 questions.', 'INSUFFICIENT_QUESTIONS', {
      available: items.length,
    });
  }
  return items;
}

function selectFirstUnused(ordered, used, predicate) {
  const selected = ordered.find((item) => !used.has(item.id) && predicate(item));
  if (selected) used.add(selected.id);
  return selected || null;
}

/**
 * Pick one exact, semantic, conversational, and complex question. A deterministic
 * fallback fills a stratum only when a custom approved dataset lacks that category.
 */
export function selectCalibrationQuestions(items, seed = DEFAULT_SCHEDULER_SEED) {
  const ordered = deterministicShuffle(items, `${seed}:calibration`);
  const used = new Set();
  const predicates = [
    (item) => item.category === 'exact_fact',
    (item) => item.category === 'paraphrase',
    (item) => item.category === 'context_followup',
    (item) => COMPLEX_CATEGORIES.has(item.category),
  ];
  const selected = predicates.map((predicate) => selectFirstUnused(ordered, used, predicate))
    .filter(Boolean);
  while (selected.length < CALIBRATION_QUESTION_COUNT) {
    const fallback = selectFirstUnused(ordered, used, () => true);
    if (!fallback) break;
    selected.push(fallback);
  }
  if (selected.length !== CALIBRATION_QUESTION_COUNT) {
    fail('Four distinct calibration questions are required.', 'INSUFFICIENT_CALIBRATION_ITEMS');
  }
  return selected;
}

function selectNormalQuestions(items, calibration, count, seed) {
  const selected = [...calibration];
  const used = new Set(selected.map((item) => item.id));
  for (const item of deterministicShuffle(items, `${seed}:normal:${count}`)) {
    if (selected.length >= count) break;
    if (!used.has(item.id)) {
      selected.push(item);
      used.add(item.id);
    }
  }
  if (selected.length !== count) {
    fail('The selected budget tier needs more Normal questions.', 'INSUFFICIENT_QUESTIONS');
  }
  return selected;
}

function selectComplexQuestions(items, count, seed) {
  const explicitlyComplex = items.filter((item) => item.complexity === 'complex');
  const categoryComplex = items.filter((item) => COMPLEX_CATEGORIES.has(item.category));
  const pool = explicitlyComplex.length >= count ? explicitlyComplex : categoryComplex;
  const selected = deterministicShuffle(pool, `${seed}:deep:${count}`).slice(0, count);
  if (selected.length !== count) {
    fail('The selected budget tier needs more complex Deep questions.', 'INSUFFICIENT_COMPLEX_ITEMS');
  }
  return selected;
}

function selectStratified(items, count, seed) {
  if (!count) return [];
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  const categories = deterministicShuffle([...groups.keys()], `${seed}:repeat-categories`);
  for (const category of categories) {
    groups.set(category, deterministicShuffle(groups.get(category), `${seed}:repeat:${category}`));
  }
  const selected = [];
  const used = new Set();
  let offset = 0;
  while (selected.length < count) {
    let progressed = false;
    for (const category of categories) {
      const candidate = groups.get(category)[offset];
      if (candidate && !used.has(candidate.id)) {
        selected.push(candidate);
        used.add(candidate.id);
        progressed = true;
        if (selected.length === count) break;
      }
    }
    if (!progressed) break;
    offset += 1;
  }
  if (selected.length !== count) {
    fail('The selected budget tier needs more repeat questions.', 'INSUFFICIENT_REPEAT_ITEMS');
  }
  return selected;
}

export const BUDGET_TIERS = Object.freeze([
  Object.freeze({
    id: 'full', normalQuestions: 48, deepQuestions: 8,
    repeatedNormalQuestions: 12, additionalNormalRounds: 2,
  }),
  Object.freeze({
    id: 'without_repeats', normalQuestions: 48, deepQuestions: 8,
    repeatedNormalQuestions: 0, additionalNormalRounds: 0,
  }),
  Object.freeze({
    id: 'deep_reduced_to_4', normalQuestions: 48, deepQuestions: 4,
    repeatedNormalQuestions: 0, additionalNormalRounds: 0,
  }),
  Object.freeze({
    id: 'normal_reduced_to_36', normalQuestions: 36, deepQuestions: 4,
    repeatedNormalQuestions: 0, additionalNormalRounds: 0,
  }),
  Object.freeze({
    id: 'normal_reduced_to_24', normalQuestions: 24, deepQuestions: 4,
    repeatedNormalQuestions: 0, additionalNormalRounds: 0,
  }),
]);

function projectedCost(tier, options) {
  const completedCalibrationPairs = Math.min(
    positiveInteger(options.completedCalibrationPairs, 'completedCalibrationPairs'),
    tier.normalQuestions,
  );
  const remainingNormalPairs = tier.normalQuestions - completedCalibrationPairs;
  const repeatedPairs = tier.repeatedNormalQuestions * tier.additionalNormalRounds;
  return options.spentCny +
    (remainingNormalPairs + repeatedPairs) * options.normalPairCostCny +
    tier.deepQuestions * options.deepPairCostCny;
}

/** Select the first permissible degradation tier; never invent a set below 24 pairs. */
export function chooseBudgetPlan(options = {}) {
  const spentCny = finiteNonnegative(options.spentCny ?? 0, 'spentCny');
  const normalPairCostCny = finiteNonnegative(
    options.normalPairCostCny,
    'normalPairCostCny',
  );
  const deepPairCostCny = finiteNonnegative(
    options.deepPairCostCny ?? normalPairCostCny * 2,
    'deepPairCostCny',
  );
  const softLimitCny = finiteNonnegative(
    options.softLimitCny ?? BENCHMARK_BUDGET_CNY.soft,
    'softLimitCny',
  );
  const completedCalibrationPairs = options.completedCalibrationPairs ??
    CALIBRATION_QUESTION_COUNT;
  positiveInteger(completedCalibrationPairs, 'completedCalibrationPairs');

  const projections = BUDGET_TIERS.map((tier) => ({
    ...tier,
    projectedTotalCny: Number(projectedCost(tier, {
      spentCny,
      normalPairCostCny,
      deepPairCostCny,
      completedCalibrationPairs,
    }).toFixed(9)),
  }));
  const selected = projections.find((tier) => tier.projectedTotalCny <= softLimitCny);
  if (!selected) {
    return Object.freeze({
      status: 'budget_insufficient',
      softLimitCny,
      spentCny,
      normalPairCostCny,
      deepPairCostCny,
      minimumNormalPairs: 24,
      projections: Object.freeze(projections),
    });
  }
  return Object.freeze({
    status: 'ready',
    ...selected,
    softLimitCny,
    spentCny,
    normalPairCostCny,
    deepPairCostCny,
    completedCalibrationPairs,
    projections: Object.freeze(projections),
  });
}

function systemOrder(pairIndex, seed) {
  const initial = seedWords(`${seed}:system-order`)[0] % 2;
  return (pairIndex + initial) % 2 === 0 ? [...SYSTEMS] : [...SYSTEMS].reverse();
}

function taskDescriptor(question, options) {
  return Object.freeze({
    pairId: `${options.phase}:${options.mode}:r${options.round}:${question.id}`,
    question,
    questionId: question.id,
    mode: options.mode,
    round: options.round,
    phase: options.phase,
  });
}

/** Build the post-calibration pairs. Calibration questions are not run twice in round 1. */
export function buildPairedSchedule(items, calibration, plan, seed = DEFAULT_SCHEDULER_SEED) {
  if (plan?.status !== 'ready') return [];
  const normal = selectNormalQuestions(items, calibration, plan.normalQuestions, seed);
  const calibrationIds = new Set(calibration.map((item) => item.id));
  const remainingNormal = deterministicShuffle(
    normal.filter((item) => !calibrationIds.has(item.id)),
    `${seed}:normal-main-order`,
  );
  const deep = selectComplexQuestions(items, plan.deepQuestions, seed);
  const repeated = selectStratified(normal, plan.repeatedNormalQuestions, seed);
  const pairs = [
    ...remainingNormal.map((question) => taskDescriptor(question, {
      phase: 'normal_main', mode: 'normal', round: 1,
    })),
    ...deep.map((question) => taskDescriptor(question, {
      phase: 'deep', mode: 'deep', round: 1,
    })),
  ];
  for (let additional = 1; additional <= plan.additionalNormalRounds; additional += 1) {
    const round = additional + 1;
    const ordered = deterministicShuffle(repeated, `${seed}:repeat-round:${round}`);
    pairs.push(...ordered.map((question) => taskDescriptor(question, {
      phase: 'normal_repeat', mode: 'normal', round,
    })));
  }
  return pairs.map((pair, pairIndex) => Object.freeze({
    ...pair,
    systemOrder: Object.freeze(systemOrder(pairIndex + CALIBRATION_QUESTION_COUNT, seed)),
  }));
}

function numericUsageValue(input, names) {
  for (const name of names) {
    if (input?.[name] !== undefined) {
      const value = Number(input[name]);
      if (!Number.isInteger(value) || value < 0) {
        fail('Runner usage must contain non-negative integer token counts.', 'INVALID_RUNNER_USAGE');
      }
      return value;
    }
  }
  return 0;
}

function normalizeSingleUsage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Every runner result must include complete model usage.', 'MISSING_RUNNER_USAGE');
  }
  const knownFields = [
    'inputTokens', 'input_tokens', 'outputTokens', 'output_tokens',
    'cacheCreationTokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens',
    'cacheReadTokens', 'cacheReadInputTokens', 'cache_read_input_tokens',
  ];
  if (!knownFields.some((field) => input[field] !== undefined)) {
    fail('Runner usage has no recognized token fields.', 'MISSING_RUNNER_USAGE');
  }
  return {
    inputTokens: numericUsageValue(input, ['inputTokens', 'input_tokens']),
    outputTokens: numericUsageValue(input, ['outputTokens', 'output_tokens']),
    cacheCreationTokens: numericUsageValue(input, [
      'cacheCreationTokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens',
    ]),
    cacheReadTokens: numericUsageValue(input, [
      'cacheReadTokens', 'cacheReadInputTokens', 'cache_read_input_tokens',
    ]),
  };
}

function addUsage(left, right) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  };
}

function normalizeUsageContainer(input) {
  if (!input || typeof input !== 'object') {
    fail('Every runner result must include complete model usage.', 'MISSING_RUNNER_USAGE');
  }
  if (Array.isArray(input)) {
    if (!input.length) fail('Runner usage list must not be empty.', 'MISSING_RUNNER_USAGE');
    return input.reduce(
      (total, usage) => addUsage(total, normalizeUsageContainer(usage?.usage || usage)),
      { ...ZERO_USAGE },
    );
  }
  const directFields = [
    'inputTokens', 'input_tokens', 'outputTokens', 'output_tokens',
    'cacheCreationTokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens',
    'cacheReadTokens', 'cacheReadInputTokens', 'cache_read_input_tokens',
  ];
  if (directFields.some((field) => input[field] !== undefined)) return normalizeSingleUsage(input);
  const nested = Object.values(input);
  if (!nested.length) fail('Runner usage object must not be empty.', 'MISSING_RUNNER_USAGE');
  return nested.reduce(
    (total, usage) => addUsage(total, normalizeUsageContainer(usage?.usage || usage)),
    { ...ZERO_USAGE },
  );
}

/** Aggregate one-call, multi-call, and Claude Agent SDK modelUsage shapes. */
export function aggregateRunnerUsage(result) {
  if (!result || typeof result !== 'object') {
    fail('Every successful runner must return a result object.', 'MISSING_RUNNER_USAGE');
  }
  const directTelemetry = result.model?.telemetry || result.telemetry;
  const telemetryRecords = Array.isArray(directTelemetry)
    ? directTelemetry
    : directTelemetry?.records;
  if (Array.isArray(telemetryRecords)) {
    const complete = telemetryRecords.filter((record) => record?.usage);
    if (complete.length !== telemetryRecords.length || !complete.length) {
      fail('Runner telemetry contains incomplete usage.', 'MISSING_RUNNER_USAGE');
    }
    return normalizeUsageContainer(complete.map((record) => record.usage));
  }
  if (directTelemetry?.usage) return normalizeUsageContainer(directTelemetry.usage);
  if (result.usage) return normalizeUsageContainer(result.usage);
  const calls = result.modelCalls || result.calls;
  if (Array.isArray(calls)) {
    if (!calls.length) fail('Runner modelCalls must not be empty.', 'MISSING_RUNNER_USAGE');
    return calls.reduce(
      (total, call) => addUsage(total, normalizeUsageContainer(call?.usage || call)),
      { ...ZERO_USAGE },
    );
  }
  if (result.modelUsage && typeof result.modelUsage === 'object') {
    return normalizeUsageContainer(result.modelUsage);
  }
  if (result.model?.usage) return normalizeUsageContainer(result.model.usage);
  fail('Every runner result must include complete model usage.', 'MISSING_RUNNER_USAGE');
}

function defaultReservationBounds({ mode }) {
  if (mode === 'deep') {
    return { inputTokenUpperBound: 500_000, maxOutputTokens: 15_000 };
  }
  return { inputTokenUpperBound: 100_000, maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS };
}

function normalizeReservationBounds(value) {
  return {
    inputTokenUpperBound: Math.ceil(finiteNonnegative(
      value?.inputTokenUpperBound,
      'reservation.inputTokenUpperBound',
    )),
    maxOutputTokens: positiveInteger(value?.maxOutputTokens, 'reservation.maxOutputTokens'),
  };
}

function addBounds(left, right) {
  return {
    inputTokenUpperBound: left.inputTokenUpperBound + right.inputTokenUpperBound,
    maxOutputTokens: left.maxOutputTokens + right.maxOutputTokens,
  };
}

function clonePriorMessages(question) {
  if (question.category !== 'context_followup') return [];
  return (Array.isArray(question.priorMessages) ? question.priorMessages : [])
    .map((message) => ({ role: message.role, content: message.content }));
}

function invocationFor(pair, system, seed) {
  const sessionDigest = crypto.createHash('sha256')
    .update(`${seed}:${pair.pairId}:${system}`)
    .digest('hex')
    .slice(0, 16);
  return Object.freeze({
    anonymousId: `B${sessionDigest}`,
    system,
    question: pair.question,
    questionId: pair.questionId,
    query: pair.question.query,
    mode: pair.mode,
    round: pair.round,
    phase: pair.phase,
    pairId: pair.pairId,
    sessionId: `bench-${sessionDigest}`,
    freshSession: true,
    priorMessages: Object.freeze(clonePriorMessages(pair.question)),
    webSearch: false,
  });
}

function publicErrorCode(error) {
  const candidate = String(error?.code || error?.name || 'RUNNER_FAILED').toUpperCase();
  return /^[A-Z0-9_]{2,80}$/.test(candidate) ? candidate : 'RUNNER_FAILED';
}

function finiteTiming(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function resultTelemetryRecords(result) {
  const telemetry = result?.model?.telemetry || result?.telemetry;
  if (Array.isArray(telemetry)) return telemetry;
  return Array.isArray(telemetry?.records) ? telemetry.records : [];
}

function lastVisibleTelemetryTiming(result) {
  const candidates = resultTelemetryRecords(result)
    .filter((record) => !record?.errorCode && finiteTiming(record?.timing?.firstVisibleTextMs) !== null);
  return candidates.at(-1)?.timing || null;
}

/** Normalize runner-level and proxy-level timing without inventing an index duration. */
export function normalizeRunnerTiming(result, elapsedMs) {
  const timing = result?.timing && typeof result.timing === 'object' ? result.timing : {};
  const output = { wallMs: Number(elapsedMs.toFixed(3)) };
  for (const field of ['indexBuildMs', 'retrievalMs', 'totalMs']) {
    const value = finiteTiming(timing[field]);
    if (value !== null) output[field] = value;
  }
  const proxyTiming = lastVisibleTelemetryTiming(result);
  const timeToFirstTokenMs = [
    timing.timeToFirstTokenMs,
    timing.ttftMs,
    timing.firstVisibleTextMs,
    proxyTiming?.firstVisibleTextMs,
  ].map(finiteTiming).find((value) => value !== null);
  if (timeToFirstTokenMs !== undefined) {
    output.timeToFirstTokenMs = timeToFirstTokenMs;
    output.ttftMs = timeToFirstTokenMs;
  }
  const streamCompletionMs = finiteTiming(timing.streamCompletionMs);
  const legacyGenerationMs = finiteTiming(timing.generationMs);
  if (streamCompletionMs !== null) {
    output.generationMs = streamCompletionMs;
  } else if (legacyGenerationMs !== null) {
    output.generationMs = legacyGenerationMs;
  } else if (proxyTiming) {
    const completedMs = finiteTiming(proxyTiming.completedMs);
    const firstVisibleTextMs = finiteTiming(proxyTiming.firstVisibleTextMs);
    if (completedMs !== null && firstVisibleTextMs !== null && completedMs >= firstVisibleTextMs) {
      output.generationMs = Number((completedMs - firstVisibleTextMs).toFixed(3));
    }
  }
  if (proxyTiming) {
    const ttfbMs = finiteTiming(proxyTiming.ttfbMs);
    const firstSseMs = finiteTiming(proxyTiming.firstSseMs);
    if (ttfbMs !== null) output.modelTtfbMs = ttfbMs;
    if (firstSseMs !== null) output.modelFirstSseMs = firstSseMs;
  }
  return output;
}

function pairBounds(pair, reservationFor) {
  return SYSTEMS.map((system) => normalizeReservationBounds(reservationFor({
    system,
    mode: pair.mode,
    phase: pair.phase,
    questionId: pair.questionId,
    question: pair.question,
  }))).reduce(addBounds, { inputTokenUpperBound: 0, maxOutputTokens: 0 });
}

function reservationAmountCny(bounds, pricing) {
  const inputRate = Math.max(
    finiteNonnegative(pricing?.input, 'budgetLedger.pricing.input'),
    finiteNonnegative(pricing?.cacheCreation, 'budgetLedger.pricing.cacheCreation'),
  );
  const amount = (
    bounds.inputTokenUpperBound * inputRate +
    bounds.maxOutputTokens * finiteNonnegative(
      pricing?.output,
      'budgetLedger.pricing.output',
    )
  ) / 1_000_000;
  return Number(amount.toFixed(9));
}

function runnerOwnedBudgetBlock(status, amountCny) {
  if (status.committedCny >= status.hardLimitCny ||
      status.committedCny + amountCny > status.hardLimitCny) {
    return 'BUDGET_HARD_LIMIT';
  }
  if (status.committedCny >= status.softLimitCny ||
      status.committedCny + amountCny > status.softLimitCny) {
    return 'BUDGET_SOFT_LIMIT';
  }
  return null;
}

async function preparePairBudget(pair, context) {
  const bounds = pairBounds(pair, context.reservationFor);
  const before = await context.budgetLedger.status();
  if (context.budgetOwnership === 'runner') {
    const amountCny = reservationAmountCny(bounds, context.budgetLedger.pricing);
    const code = runnerOwnedBudgetBlock(before, amountCny);
    if (code) return { blocked: true, code };
    return { blocked: false, bounds, before, amountCny, reservation: null };
  }
  try {
    const reservation = await context.budgetLedger.reserve(bounds);
    return {
      blocked: false,
      bounds,
      before,
      amountCny: reservation.amountCny,
      reservation,
      runnerBaseline: await context.budgetLedger.status(),
    };
  } catch (error) {
    if (['BUDGET_SOFT_LIMIT', 'BUDGET_HARD_LIMIT'].includes(error?.code)) {
      return { blocked: true, code: error.code };
    }
    throw error;
  }
}

async function executePair(pair, context) {
  const pairBudget = await preparePairBudget(pair, context);
  if (pairBudget.blocked) {
    return { status: 'budget_stopped', code: pairBudget.code, records: [] };
  }

  const records = [];
  const usages = [];
  let callbackError = null;
  let usageError = null;
  for (const system of pair.systemOrder) {
    const invocation = invocationFor(pair, system, context.seed);
    const runner = system === 'agent' ? context.runnerA : context.runnerB;
    const started = performance.now();
    let rawResult;
    let record;
    try {
      rawResult = await runner(invocation);
      const usage = aggregateRunnerUsage(rawResult);
      usages.push(usage);
      const reportedStatus = String(rawResult?.status || 'completed').toLowerCase();
      const succeeded = ['completed', 'success', 'succeeded'].includes(reportedStatus);
      record = Object.freeze({
        pairId: pair.pairId,
        questionId: pair.questionId,
        system,
        mode: pair.mode,
        round: pair.round,
        phase: pair.phase,
        sessionId: invocation.sessionId,
        status: succeeded ? 'success' : 'failed',
        ...(succeeded ? {} : {
          errorCode: publicErrorCode(rawResult?.error || { code: 'RUNNER_REPORTED_FAILURE' }),
        }),
        usage: Object.freeze(usage),
        costCny: estimateUsageCostCny(usage, context.budgetLedger.pricing),
        timing: Object.freeze(normalizeRunnerTiming(rawResult, performance.now() - started)),
      });
    } catch (error) {
      if (error instanceof BenchmarkSchedulerError &&
          ['MISSING_RUNNER_USAGE', 'INVALID_RUNNER_USAGE'].includes(error.code)) {
        usageError = error;
      }
      record = Object.freeze({
        pairId: pair.pairId,
        questionId: pair.questionId,
        system,
        mode: pair.mode,
        round: pair.round,
        phase: pair.phase,
        sessionId: invocation.sessionId,
        status: 'failed',
        errorCode: publicErrorCode(error),
        usage: null,
        costCny: null,
        timing: Object.freeze({ wallMs: Number((performance.now() - started).toFixed(3)) }),
      });
    }
    records.push(record);
    try {
      await context.onRecord(record, rawResult);
    } catch (error) {
      callbackError ||= error;
    }
  }

  let settlement = null;
  const combined = usages.length === SYSTEMS.length
    ? usages.reduce(addUsage, { ...ZERO_USAGE })
    : null;
  if (context.budgetOwnership === 'scheduler') {
    const afterRunners = await context.budgetLedger.status();
    const runnerSettledCny = afterRunners.settledCny - pairBudget.runnerBaseline.settledCny;
    if (runnerSettledCny > 1e-9) {
      await context.budgetLedger.markUncertain(pairBudget.reservation);
      usageError ||= new BenchmarkSchedulerError(
        'The runner settled the scheduler-owned ledger; refusing a second settlement.',
        'BUDGET_DOUBLE_SETTLEMENT_RISK',
      );
    } else if (combined) {
      settlement = await context.budgetLedger.settle(pairBudget.reservation, combined);
      if (settlement.actualCny > pairBudget.reservation.amountCny) {
        usageError ||= new BenchmarkSchedulerError(
          'Actual usage exceeded the declared pair reservation bound.',
          'USAGE_EXCEEDED_RESERVATION',
        );
      }
    } else {
      await context.budgetLedger.markUncertain(pairBudget.reservation);
    }
  } else {
    const afterRunners = await context.budgetLedger.status();
    const runnerSettledCny = Number((
      afterRunners.settledCny - pairBudget.before.settledCny
    ).toFixed(9));
    if (combined) {
      const recordedCostCny = estimateUsageCostCny(combined, context.budgetLedger.pricing);
      if (Math.abs(runnerSettledCny - recordedCostCny) > 1e-9) {
        usageError ||= new BenchmarkSchedulerError(
          'Runner-owned ledger settlement differs from recorded model telemetry.',
          'RUNNER_LEDGER_SETTLEMENT_MISMATCH',
        );
      }
      settlement = {
        owner: 'runner',
        actualCny: runnerSettledCny,
        usage: combined,
        status: afterRunners,
      };
    }
  }
  if (callbackError) {
    fail('The private result callback failed.', 'RECORD_CALLBACK_FAILED', {
      causeCode: publicErrorCode(callbackError),
    });
  }
  return {
    status: usageError || records.some((record) => record.status !== 'success')
      ? 'pair_failed'
      : 'completed',
    code: usageError?.code || null,
    records,
    settlement,
  };
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function meanUsage(records) {
  const total = records.reduce(
    (sum, record) => addUsage(sum, record.usage),
    { ...ZERO_USAGE },
  );
  return {
    total,
    mean: Object.fromEntries(Object.entries(total).map(([field, value]) => [
      field,
      Number((value / records.length).toFixed(6)),
    ])),
  };
}

export function calibrationEstimate(records, options = {}) {
  const systemRecords = new Map(SYSTEMS.map((system) => [system, []]));
  for (const record of records) {
    if (record.phase === 'calibration' && record.status === 'success' &&
        systemRecords.has(record.system)) {
      finiteNonnegative(record.costCny, 'record.costCny');
      systemRecords.get(record.system).push(record);
    }
  }
  for (const system of SYSTEMS) {
    if (systemRecords.get(system).length !== CALIBRATION_QUESTION_COUNT) {
      fail('Calibration needs four successful results from each system.', 'CALIBRATION_INCOMPLETE');
    }
  }
  const perSystemNormalCny = Object.freeze(Object.fromEntries(
    SYSTEMS.map((system) => [system, Number(mean(
      systemRecords.get(system).map((record) => record.costCny),
    ).toFixed(9))]),
  ));
  const perSystemTotalCny = Object.freeze(Object.fromEntries(
    SYSTEMS.map((system) => [system, Number(systemRecords.get(system)
      .reduce((total, record) => total + record.costCny, 0).toFixed(9))]),
  ));
  const usageBySystem = Object.fromEntries(SYSTEMS.map((system) => [
    system,
    meanUsage(systemRecords.get(system)),
  ]));
  const perSystemMeanUsage = Object.freeze(Object.fromEntries(
    SYSTEMS.map((system) => [system, Object.freeze(usageBySystem[system].mean)]),
  ));
  const perSystemTotalUsage = Object.freeze(Object.fromEntries(
    SYSTEMS.map((system) => [system, Object.freeze(usageBySystem[system].total)]),
  ));
  const normalPairCostCny = Number(
    SYSTEMS.reduce((total, system) => total + perSystemNormalCny[system], 0).toFixed(9),
  );
  const deepCostMultiplier = finiteNonnegative(
    options.deepCostMultiplier ?? 2,
    'deepCostMultiplier',
  );
  return Object.freeze({
    samplesPerSystem: CALIBRATION_QUESTION_COUNT,
    perSystemNormalCny,
    perSystemMeanCostCny: perSystemNormalCny,
    perSystemTotalCny,
    perSystemMeanUsage,
    perSystemTotalUsage,
    calibrationTotalCny: Number(
      SYSTEMS.reduce((total, system) => total + perSystemTotalCny[system], 0).toFixed(9),
    ),
    calibrationTotalUsage: Object.freeze(SYSTEMS.reduce(
      (total, system) => addUsage(total, perSystemTotalUsage[system]),
      { ...ZERO_USAGE },
    )),
    normalPairCostCny,
    deepCostMultiplier,
    deepPairCostCny: Number((normalPairCostCny * deepCostMultiplier).toFixed(9)),
  });
}

function budgetForecast(plan, budget) {
  const remaining = (total) => Number(Math.max(0, total - budget.committedCny).toFixed(9));
  const candidates = plan.projections.map((projection) => Object.freeze({
    tier: projection.id,
    projectedTotalCny: projection.projectedTotalCny,
    projectedRemainingCny: remaining(projection.projectedTotalCny),
    fitsSoftLimit: projection.projectedTotalCny <= plan.softLimitCny,
  }));
  const selected = plan.status === 'ready'
    ? candidates.find((candidate) => candidate.tier === plan.id)
    : null;
  const minimum = candidates.at(-1);
  return Object.freeze({
    status: plan.status,
    selectedTier: selected?.tier || null,
    currentCommittedCny: budget.committedCny,
    softLimitCny: plan.softLimitCny,
    hardLimitCny: budget.hardLimitCny,
    projectedTotalCny: selected?.projectedTotalCny ?? null,
    projectedRemainingCny: selected?.projectedRemainingCny ?? null,
    minimumProjectedTotalCny: minimum.projectedTotalCny,
    minimumProjectedRemainingCny: minimum.projectedRemainingCny,
    candidates: Object.freeze(candidates),
  });
}

/**
 * Execute the approved two-system comparison. `budgetOwnership="scheduler"`
 * settles the injected ledger here. Use `budgetOwnership="runner"` when both
 * runners' instrumented proxies already reserve and settle that same ledger;
 * the scheduler then performs a read-only pair preflight and verifies settlement.
 */
export async function runPairedBenchmark(options = {}) {
  const items = assertDatasetApproved(options.dataset);
  if (options.stopAfterCalibration !== undefined &&
      typeof options.stopAfterCalibration !== 'boolean') {
    fail('stopAfterCalibration must be boolean.', 'INVALID_SCHEDULER_OPTION');
  }
  const stopAfterCalibration = options.stopAfterCalibration === true;
  const resolveRunner = (runner) => {
    if (typeof runner === 'function') return runner;
    if (runner && typeof runner.runQuestion === 'function') {
      return (invocation) => runner.runQuestion(invocation);
    }
    return null;
  };
  const runnerA = resolveRunner(options.runnerA);
  const runnerB = resolveRunner(options.runnerB);
  if (!runnerA || !runnerB) {
    fail('runnerA and runnerB are required.', 'RUNNER_REQUIRED');
  }
  if (options.onRecord !== undefined && typeof options.onRecord !== 'function') {
    fail('onRecord must be a function.', 'INVALID_SCHEDULER_OPTION');
  }
  if (options.onCalibrationComplete !== undefined &&
      typeof options.onCalibrationComplete !== 'function') {
    fail('onCalibrationComplete must be a function.', 'INVALID_SCHEDULER_OPTION');
  }
  const concurrency = positiveInteger(options.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency');
  if (concurrency !== 1) {
    fail('Only concurrency=1 is currently permitted for reproducible budget ordering.',
      'UNSUPPORTED_CONCURRENCY');
  }
  const seed = String(options.seed ?? DEFAULT_SCHEDULER_SEED);
  const budgetLedger = options.budgetLedger || new BudgetLedger();
  const budgetOwnership = String(
    options.budgetOwnership || options.budgetSettlementOwner || DEFAULT_BUDGET_OWNERSHIP,
  );
  if (!['scheduler', 'runner'].includes(budgetOwnership)) {
    fail('budgetOwnership must be scheduler or runner.', 'INVALID_SCHEDULER_OPTION');
  }
  for (const method of ['reserve', 'settle', 'markUncertain', 'status']) {
    if (typeof budgetLedger?.[method] !== 'function') {
      fail('budgetLedger does not implement the BudgetLedger contract.', 'INVALID_BUDGET_LEDGER');
    }
  }
  const context = {
    seed,
    runnerA,
    runnerB,
    onRecord: options.onRecord || (async () => {}),
    budgetLedger,
    budgetOwnership,
    reservationFor: options.reservationFor || defaultReservationBounds,
  };
  if (typeof context.reservationFor !== 'function') {
    fail('reservationFor must be a function.', 'INVALID_SCHEDULER_OPTION');
  }

  const calibration = selectCalibrationQuestions(items, seed);
  const calibrationPairs = calibration.map((question, pairIndex) => Object.freeze({
    ...taskDescriptor(question, { phase: 'calibration', mode: 'normal', round: 1 }),
    systemOrder: Object.freeze(systemOrder(pairIndex, seed)),
  }));
  const records = [];
  for (const pair of calibrationPairs) {
    const outcome = await executePair(pair, context);
    records.push(...outcome.records);
    if (outcome.status !== 'completed') {
      return {
        status: outcome.status === 'budget_stopped' ? 'budget_insufficient' : 'calibration_failed',
        code: outcome.code,
        phase: 'calibration',
        calibrationOnly: stopAfterCalibration,
        records,
        plan: null,
        budget: await budgetLedger.status(),
      };
    }
  }

  const estimate = calibrationEstimate(records, {
    deepCostMultiplier: options.deepCostMultiplier,
  });
  const budget = await budgetLedger.status();
  const softLimitCny = Math.min(
    finiteNonnegative(options.softLimitCny ?? BENCHMARK_BUDGET_CNY.soft, 'softLimitCny'),
    finiteNonnegative(budget.softLimitCny, 'budget.softLimitCny'),
  );
  const plan = chooseBudgetPlan({
    spentCny: budget.committedCny,
    normalPairCostCny: estimate.normalPairCostCny,
    deepPairCostCny: options.deepPairCostCny ?? estimate.deepPairCostCny,
    completedCalibrationPairs: CALIBRATION_QUESTION_COUNT,
    softLimitCny,
  });
  const forecast = budgetForecast(plan, budget);
  if (options.onCalibrationComplete) {
    try {
      await options.onCalibrationComplete(Object.freeze({
        estimate,
        plan,
        forecast,
        budget,
      }));
    } catch (error) {
      fail('The calibration completion callback failed.', 'CALIBRATION_CALLBACK_FAILED', {
        causeCode: publicErrorCode(error),
      });
    }
  }
  if (stopAfterCalibration) {
    return {
      status: plan.status === 'ready' ? 'calibration_completed' : 'budget_insufficient',
      phase: 'calibration',
      calibrationOnly: true,
      records,
      estimate,
      plan,
      forecast,
      schedule: [],
      budget: await budgetLedger.status(),
    };
  }
  if (plan.status === 'budget_insufficient') {
    return {
      status: 'budget_insufficient',
      phase: 'planning',
      records,
      estimate,
      plan,
      forecast,
      budget: await budgetLedger.status(),
    };
  }

  const schedule = buildPairedSchedule(items, calibration, plan, seed);
  for (const pair of schedule) {
    const outcome = await executePair(pair, context);
    records.push(...outcome.records);
    if (outcome.status !== 'completed') {
      return {
        status: outcome.status === 'budget_stopped' ? 'budget_stopped' : 'pair_failed',
        code: outcome.code,
        phase: pair.phase,
        records,
        estimate,
        plan,
        forecast,
        schedule,
        budget: await budgetLedger.status(),
      };
    }
  }
  return {
    status: 'completed',
    records,
    estimate,
    plan,
    forecast,
    schedule,
    budget: await budgetLedger.status(),
    separatedResults: Object.freeze({
      normal: Object.freeze(records.filter((record) => record.mode === 'normal')),
      deep: Object.freeze(records.filter((record) => record.mode === 'deep')),
    }),
  };
}
