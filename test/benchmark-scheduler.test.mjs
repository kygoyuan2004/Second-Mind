import assert from 'node:assert/strict';
import test from 'node:test';
import { BudgetLedger } from '../scripts/lib/benchmark-runtime.mjs';
import {
  BUDGET_TIERS,
  aggregateRunnerUsage,
  buildPairedSchedule,
  chooseBudgetPlan,
  deterministicShuffle,
  normalizeRunnerTiming,
  runPairedBenchmark,
  selectCalibrationQuestions,
} from '../scripts/lib/benchmark-scheduler.mjs';

const CATEGORY_COUNTS = Object.freeze({
  exact_fact: 8,
  paraphrase: 12,
  context_followup: 8,
  cross_document: 8,
  deduplication: 4,
  temporal_conflict: 4,
  unanswerable: 4,
});

function approvedDataset() {
  let sequence = 0;
  const items = [];
  for (const [category, count] of Object.entries(CATEGORY_COUNTS)) {
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      items.push({
        id: `Q${String(sequence).padStart(3, '0')}`,
        category,
        query: `Synthetic question ${sequence}`,
        priorMessages: category === 'context_followup'
          ? [
              { role: 'user', content: `Synthetic prior question ${sequence}` },
              { role: 'assistant', content: `Synthetic prior answer ${sequence}` },
            ]
          : [],
        review: { status: 'approved' },
      });
    }
  }
  return { reviewStatus: 'approved', executionAllowed: true, items };
}

function cheapLedger(options = {}) {
  return new BudgetLedger({
    limits: { soft: 90, hard: 100, ...(options.limits || {}) },
    pricing: {
      input: 1,
      output: 1,
      cacheCreation: 1,
      cacheRead: 1,
      ...(options.pricing || {}),
    },
  });
}

const SMALL_BOUNDS = () => ({ inputTokenUpperBound: 1_000, maxOutputTokens: 3_000 });
const SMALL_USAGE = Object.freeze({
  inputTokens: 100,
  outputTokens: 10,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

test('seeded selection and schedules are stable, while another seed changes their order', () => {
  const items = approvedDataset().items;
  const first = deterministicShuffle(items, 'fixed-seed').map((item) => item.id);
  const second = deterministicShuffle(items, 'fixed-seed').map((item) => item.id);
  const other = deterministicShuffle(items, 'another-seed').map((item) => item.id);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, other);

  const calibration = selectCalibrationQuestions(items, 'fixed-seed');
  assert.equal(calibration.length, 4);
  assert.equal(new Set(calibration.map((item) => item.id)).size, 4);
  assert.deepEqual(
    calibration.map((item) => item.category),
    ['exact_fact', 'paraphrase', 'context_followup', 'cross_document'],
  );
  const plan = chooseBudgetPlan({
    spentCny: 4,
    normalPairCostCny: 1,
    deepPairCostCny: 2,
    completedCalibrationPairs: 4,
  });
  const scheduleA = buildPairedSchedule(items, calibration, plan, 'fixed-seed');
  const scheduleB = buildPairedSchedule(items, calibration, plan, 'fixed-seed');
  assert.deepEqual(scheduleA.map((pair) => pair.pairId), scheduleB.map((pair) => pair.pairId));
  assert.equal(scheduleA.length, 68 + 8);
});

test('budget planning follows every approved degradation boundary in order', () => {
  const selectedTier = (normalPairCostCny) => chooseBudgetPlan({
    spentCny: normalPairCostCny * 4,
    normalPairCostCny,
    deepPairCostCny: normalPairCostCny * 2,
    completedCalibrationPairs: 4,
    softLimitCny: 90,
  }).id;
  assert.deepEqual(BUDGET_TIERS.map((tier) => tier.id), [
    'full',
    'without_repeats',
    'deep_reduced_to_4',
    'normal_reduced_to_36',
    'normal_reduced_to_24',
  ]);
  assert.equal(selectedTier(1), 'full');
  assert.equal(selectedTier(1.2), 'without_repeats');
  assert.equal(selectedTier(1.5), 'deep_reduced_to_4');
  assert.equal(selectedTier(1.8), 'normal_reduced_to_36');
  assert.equal(selectedTier(2.4), 'normal_reduced_to_24');
  assert.equal(chooseBudgetPlan({
    spentCny: 12,
    normalPairCostCny: 3,
    deepPairCostCny: 6,
    completedCalibrationPairs: 4,
    softLimitCny: 90,
  }).status, 'budget_insufficient');
});

test('usage aggregation accepts runtime proxy and original Agent SDK result shapes', () => {
  assert.deepEqual(aggregateRunnerUsage({
    model: {
      usage: {
        planner: {
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
        },
        final: {
          input_tokens: 20,
          output_tokens: 5,
          cache_creation_input_tokens: 6,
          cache_read_input_tokens: 7,
        },
      },
    },
  }), {
    inputTokens: 30,
    outputTokens: 7,
    cacheCreationTokens: 9,
    cacheReadTokens: 11,
  });
  assert.deepEqual(aggregateRunnerUsage({
    model: {
      telemetry: {
        records: [
          { usage: { inputTokens: 8, outputTokens: 2 } },
          { usage: { inputTokens: 9, outputTokens: 3 } },
        ],
      },
    },
  }), {
    inputTokens: 17,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });

  assert.deepEqual(aggregateRunnerUsage({
    usage: { inputTokens: 777, outputTokens: 777 },
    model: {
      usage: { qwen: { inputTokens: 999, outputTokens: 999 } },
      telemetry: {
        records: [{ usage: { inputTokens: 4, outputTokens: 1 } }],
      },
    },
  }), {
    inputTokens: 4,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
  assert.throws(() => aggregateRunnerUsage({
    usage: { inputTokens: 123, outputTokens: 45 },
    model: { telemetry: { records: [{ usage: null }] } },
  }), { code: 'MISSING_RUNNER_USAGE' });
});

test('runner timing preserves index time and maps proxy first-visible text to both TTFT names', () => {
  const normalized = normalizeRunnerTiming({
    timing: {
      indexBuildMs: 12,
      retrievalMs: 7,
      generationMs: 999,
      streamCompletionMs: 14,
      totalMs: 80,
    },
    model: {
      telemetry: {
        records: [
          {
            usage: SMALL_USAGE,
            timing: { ttfbMs: 2, firstSseMs: 3, firstVisibleTextMs: 5, completedMs: 9 },
            errorCode: null,
          },
          {
            usage: SMALL_USAGE,
            timing: { ttfbMs: 4, firstSseMs: 6, firstVisibleTextMs: 11, completedMs: 31 },
            errorCode: null,
          },
        ],
      },
    },
  }, 85);
  assert.deepEqual(normalized, {
    wallMs: 85,
    indexBuildMs: 12,
    retrievalMs: 7,
    totalMs: 80,
    timeToFirstTokenMs: 11,
    ttftMs: 11,
    generationMs: 14,
    modelTtfbMs: 4,
    modelFirstSseMs: 6,
  });

  const explicit = normalizeRunnerTiming({
    timing: { timeToFirstTokenMs: 42, ttftMs: 99, generationMs: 10 },
  }, 55);
  assert.equal(explicit.timeToFirstTokenMs, 42);
  assert.equal(explicit.ttftMs, 42);
  assert.equal(explicit.generationMs, 10);

  const proxyFallback = normalizeRunnerTiming({
    timing: {},
    telemetry: [{
      usage: SMALL_USAGE,
      timing: { firstVisibleTextMs: 8, completedMs: 21 },
      errorCode: null,
    }],
  }, 30);
  assert.equal(proxyFallback.generationMs, 13);
});

test('a full run is paired, alternates system order, separates modes, and uses fresh sessions',
  async () => {
    const invocations = [];
    const runner = async (invocation) => {
      invocations.push(invocation);
      return { usage: SMALL_USAGE, timing: { retrievalMs: 1, totalMs: 2 } };
    };
    const result = await runPairedBenchmark({
      dataset: approvedDataset(),
      runnerA: runner,
      runnerB: runner,
      budgetLedger: cheapLedger(),
      reservationFor: SMALL_BOUNDS,
      seed: 'paired-full-run',
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.plan.id, 'full');
    assert.equal(result.records.length, 160);
    assert.equal(result.separatedResults.normal.length, 144);
    assert.equal(result.separatedResults.deep.length, 16);
    assert.equal(new Set(invocations.map((item) => item.sessionId)).size, invocations.length);
    assert.ok(invocations.every((item) => item.freshSession && item.webSearch === false));

    const contextCalls = invocations.filter((item) => item.question.category === 'context_followup');
    const ordinaryCalls = invocations.filter((item) => item.question.category !== 'context_followup');
    assert.ok(contextCalls.length > 0);
    assert.ok(contextCalls.every((item) => item.priorMessages.length === 2));
    assert.ok(ordinaryCalls.every((item) => item.priorMessages.length === 0));

    const firstRoundNormal = invocations.filter((item) =>
      item.mode === 'normal' && item.round === 1);
    assert.equal(firstRoundNormal.length, 96);
    const firstRoundCounts = Map.groupBy
      ? Map.groupBy(firstRoundNormal, (item) => item.questionId)
      : firstRoundNormal.reduce((groups, item) => {
          const current = groups.get(item.questionId) || [];
          current.push(item);
          groups.set(item.questionId, current);
          return groups;
        }, new Map());
    assert.equal(firstRoundCounts.size, 48);
    assert.ok([...firstRoundCounts.values()].every((calls) => calls.length === 2));
    const calibrationIds = new Set(invocations
      .filter((item) => item.phase === 'calibration')
      .map((item) => item.questionId));
    assert.equal(calibrationIds.size, 4);
    assert.ok(invocations
      .filter((item) => item.phase === 'normal_main')
      .every((item) => !calibrationIds.has(item.questionId)));

    const firstSystems = [];
    for (let index = 0; index < invocations.length; index += 2) {
      assert.equal(invocations[index].pairId, invocations[index + 1].pairId);
      assert.notEqual(invocations[index].system, invocations[index + 1].system);
      firstSystems.push(invocations[index].system);
    }
    for (let index = 1; index < firstSystems.length; index += 1) {
      assert.notEqual(firstSystems[index - 1], firstSystems[index]);
    }
  });

test('stopAfterCalibration runs exactly four pairs and returns usage, cost, and budget forecast',
  async () => {
    const agentUsage = {
      inputTokens: 100,
      outputTokens: 10,
      cacheCreationTokens: 20,
      cacheReadTokens: 30,
    };
    const ragUsage = {
      inputTokens: 200,
      outputTokens: 20,
      cacheCreationTokens: 40,
      cacheReadTokens: 60,
    };
    const starts = [];
    const persisted = [];
    let calibrationSummary;
    const result = await runPairedBenchmark({
      dataset: approvedDataset(),
      runnerA: async (invocation) => {
        starts.push({ pairId: invocation.pairId, system: invocation.system });
        return { usage: agentUsage };
      },
      runnerB: async (invocation) => {
        starts.push({ pairId: invocation.pairId, system: invocation.system });
        return { usage: ragUsage };
      },
      budgetLedger: cheapLedger(),
      reservationFor: SMALL_BOUNDS,
      stopAfterCalibration: true,
      onRecord: async (record) => persisted.push(record),
      onCalibrationComplete: async (summary) => {
        await Promise.resolve();
        calibrationSummary = summary;
      },
      seed: 'calibration-only',
    });

    assert.equal(result.status, 'calibration_completed');
    assert.equal(result.phase, 'calibration');
    assert.equal(result.calibrationOnly, true);
    assert.deepEqual(result.schedule, []);
    assert.equal(starts.length, 8);
    assert.equal(persisted.length, 8);
    assert.equal(result.records.length, 8);
    assert.ok(result.records.every((record) => record.phase === 'calibration'));
    assert.equal(new Set(result.records.map((record) => record.questionId)).size, 4);
    assert.equal(starts[0].pairId, starts[1].pairId);
    assert.equal(starts[2].pairId, starts[3].pairId);
    assert.notEqual(starts[0].system, starts[2].system);

    assert.deepEqual(result.estimate.perSystemMeanUsage.agent, agentUsage);
    assert.deepEqual(result.estimate.perSystemMeanUsage.rag, ragUsage);
    assert.deepEqual(result.estimate.perSystemMeanCostCny,
      result.estimate.perSystemNormalCny);
    assert.deepEqual(result.estimate.perSystemTotalUsage.agent, {
      inputTokens: 400,
      outputTokens: 40,
      cacheCreationTokens: 80,
      cacheReadTokens: 120,
    });
    assert.deepEqual(result.estimate.calibrationTotalUsage, {
      inputTokens: 1_200,
      outputTokens: 120,
      cacheCreationTokens: 240,
      cacheReadTokens: 360,
    });
    assert.equal(result.estimate.calibrationTotalCny, result.budget.settledCny);
    assert.equal(result.forecast.status, 'ready');
    assert.equal(result.forecast.selectedTier, 'full');
    assert.equal(result.forecast.candidates.length, 5);
    assert.equal(result.forecast.projectedRemainingCny, Number((
      result.forecast.projectedTotalCny - result.budget.committedCny
    ).toFixed(9)));
    assert.equal(calibrationSummary.estimate, result.estimate);
    assert.equal(calibrationSummary.plan, result.plan);
    assert.equal(calibrationSummary.forecast, result.forecast);
    assert.equal(calibrationSummary.budget.committedCny, result.budget.committedCny);
  });

test('stopAfterCalibration option is typed and cannot be enabled by a truthy string', async () => {
  await assert.rejects(() => runPairedBenchmark({
    dataset: approvedDataset(),
    runnerA: async () => ({ usage: SMALL_USAGE }),
    runnerB: async () => ({ usage: SMALL_USAGE }),
    stopAfterCalibration: 'true',
  }), { code: 'INVALID_SCHEDULER_OPTION' });
  await assert.rejects(() => runPairedBenchmark({
    dataset: approvedDataset(),
    runnerA: async () => ({ usage: SMALL_USAGE }),
    runnerB: async () => ({ usage: SMALL_USAGE }),
    onCalibrationComplete: true,
  }), { code: 'INVALID_SCHEDULER_OPTION' });
});

test('an awaited calibration callback failure stops before the post-calibration schedule',
  async () => {
    let runnerCalls = 0;
    let callbackCalls = 0;
    await assert.rejects(() => runPairedBenchmark({
      dataset: approvedDataset(),
      runnerA: async () => {
        runnerCalls += 1;
        return { usage: SMALL_USAGE };
      },
      runnerB: async () => {
        runnerCalls += 1;
        return { usage: SMALL_USAGE };
      },
      budgetLedger: cheapLedger(),
      reservationFor: SMALL_BOUNDS,
      stopAfterCalibration: false,
      onCalibrationComplete: async () => {
        callbackCalls += 1;
        await Promise.resolve();
        const error = new Error('private callback detail must not propagate');
        error.code = 'FIXTURE_CALLBACK_ERROR';
        throw error;
      },
      seed: 'calibration-callback-stop',
    }), (error) => {
      assert.equal(error.code, 'CALIBRATION_CALLBACK_FAILED');
      assert.deepEqual(error.details, { causeCode: 'FIXTURE_CALLBACK_ERROR' });
      assert.equal(error.message.includes('private callback detail'), false);
      return true;
    });
    assert.equal(callbackCalls, 1);
    assert.equal(runnerCalls, 8);
  });

test('runner-owned ledger is verified and model usage is not settled twice', async () => {
  const ledger = cheapLedger();
  let calls = 0;
  const runner = async () => {
    calls += 1;
    const reservation = await ledger.reserve({
      inputTokenUpperBound: 200,
      maxOutputTokens: 20,
    });
    await ledger.settle(reservation, SMALL_USAGE);
    return {
      status: 'completed',
      model: {
        telemetry: {
          records: [{
            usage: SMALL_USAGE,
            timing: { firstVisibleTextMs: 2, completedMs: 4 },
            errorCode: null,
          }],
        },
      },
    };
  };
  const result = await runPairedBenchmark({
    dataset: approvedDataset(),
    runnerA: runner,
    runnerB: runner,
    budgetLedger: ledger,
    budgetOwnership: 'runner',
    reservationFor: SMALL_BOUNDS,
  });
  assert.equal(result.status, 'completed');
  assert.equal(calls, 160);
  const recorded = Number(result.records
    .reduce((total, record) => total + record.costCny, 0)
    .toFixed(9));
  assert.equal(result.budget.settledCny, recorded);
  assert.equal(result.budget.openReservations, 0);
});

test('scheduler-owned ledger detects runner settlement and refuses to settle usage twice',
  async () => {
    const ledger = cheapLedger();
    let calls = 0;
    const runner = async () => {
      calls += 1;
      const reservation = await ledger.reserve({
        inputTokenUpperBound: 200,
        maxOutputTokens: 20,
      });
      await ledger.settle(reservation, SMALL_USAGE);
      return { usage: SMALL_USAGE };
    };
    const result = await runPairedBenchmark({
      dataset: approvedDataset(),
      runnerA: runner,
      runnerB: runner,
      budgetLedger: ledger,
      reservationFor: SMALL_BOUNDS,
    });
    assert.equal(result.status, 'calibration_failed');
    assert.equal(result.code, 'BUDGET_DOUBLE_SETTLEMENT_RISK');
    assert.equal(calls, 2);
    assert.equal(result.budget.settledCny, 0.00022);
    assert.equal(result.budget.openReservations, 1);
    assert.ok(result.budget.uncertainCny > 0);
  });

test('runner-owned mode fails closed when returned usage was not settled in its ledger',
  async () => {
    let calls = 0;
    const result = await runPairedBenchmark({
      dataset: approvedDataset(),
      runnerA: async () => {
        calls += 1;
        return { usage: SMALL_USAGE };
      },
      runnerB: async () => {
        calls += 1;
        return { usage: SMALL_USAGE };
      },
      budgetLedger: cheapLedger(),
      budgetOwnership: 'runner',
      reservationFor: SMALL_BOUNDS,
    });
    assert.equal(result.status, 'calibration_failed');
    assert.equal(result.code, 'RUNNER_LEDGER_SETTLEMENT_MISMATCH');
    assert.equal(calls, 2);
    assert.equal(result.budget.settledCny, 0);
  });

test('runner-owned mode rejects hidden settled calls absent from telemetry', async () => {
  const ledger = cheapLedger();
  let calls = 0;
  const runner = async () => {
    calls += 1;
    const visible = await ledger.reserve({ inputTokenUpperBound: 200, maxOutputTokens: 20 });
    await ledger.settle(visible, SMALL_USAGE);
    if (calls === 1) {
      const hidden = await ledger.reserve({ inputTokenUpperBound: 1, maxOutputTokens: 1 });
      await ledger.settle(hidden, {
        inputTokens: 1,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
    }
    return {
      status: 'completed',
      model: {
        telemetry: {
          records: [{
            usage: SMALL_USAGE,
            timing: { firstVisibleTextMs: 1, completedMs: 2 },
            errorCode: null,
          }],
        },
      },
    };
  };
  const result = await runPairedBenchmark({
    dataset: approvedDataset(),
    runnerA: runner,
    runnerB: runner,
    budgetLedger: ledger,
    budgetOwnership: 'runner',
    reservationFor: SMALL_BOUNDS,
  });
  assert.equal(result.status, 'calibration_failed');
  assert.equal(result.code, 'RUNNER_LEDGER_SETTLEMENT_MISMATCH');
  assert.equal(calls, 2);
  const visibleCost = Number(result.records
    .reduce((total, record) => total + Number(record.costCny || 0), 0)
    .toFixed(9));
  assert.ok(result.budget.settledCny > visibleCost);
});

test('pending user review stops before runners, ledger, or record callback', async () => {
  const dataset = approvedDataset();
  dataset.reviewStatus = 'pending';
  let touches = 0;
  const touch = async () => { touches += 1; };
  await assert.rejects(() => runPairedBenchmark({
    dataset,
    runnerA: touch,
    runnerB: touch,
    onRecord: touch,
    budgetLedger: { reserve: touch, settle: touch, markUncertain: touch, status: touch },
  }), { code: 'DATASET_NOT_APPROVED' });
  assert.equal(touches, 0);
});

test('approved content still cannot run without explicit dataset execution permission', async () => {
  const dataset = approvedDataset();
  dataset.executionAllowed = false;
  let touches = 0;
  const touch = async () => { touches += 1; };
  await assert.rejects(() => runPairedBenchmark({
    dataset,
    runnerA: touch,
    runnerB: touch,
    onRecord: touch,
    budgetLedger: { reserve: touch, settle: touch, markUncertain: touch, status: touch },
  }), { code: 'DATASET_EXECUTION_NOT_ALLOWED' });
  assert.equal(touches, 0);
});

test('one combined pair reservation enforces the soft limit before either system starts',
  async () => {
    const ledger = new BudgetLedger({
      limits: { soft: 90, hard: 100 },
      pricing: { input: 1_000_000, output: 0, cacheCreation: 1_000_000, cacheRead: 0 },
    });
    const prior = await ledger.reserve({ inputTokenUpperBound: 89, maxOutputTokens: 1 });
    await ledger.settle(prior, { inputTokens: 89 });
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { usage: { inputTokens: 1 } };
    };
    const result = await runPairedBenchmark({
      dataset: approvedDataset(),
      runnerA: runner,
      runnerB: runner,
      budgetLedger: ledger,
      reservationFor: () => ({ inputTokenUpperBound: 1, maxOutputTokens: 1 }),
    });
    assert.equal(result.status, 'budget_insufficient');
    assert.equal(result.code, 'BUDGET_SOFT_LIMIT');
    assert.equal(calls, 0);
    assert.equal((await ledger.status()).committedCny, 89);
  });

test('one combined pair reservation also enforces the hard limit before either system starts',
  async () => {
    const ledger = new BudgetLedger({
      limits: { soft: 100, hard: 100 },
      pricing: { input: 1_000_000, output: 0, cacheCreation: 1_000_000, cacheRead: 0 },
    });
    const prior = await ledger.reserve({ inputTokenUpperBound: 99, maxOutputTokens: 1 });
    await ledger.settle(prior, { inputTokens: 99 });
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { usage: { inputTokens: 1 } };
    };
    const result = await runPairedBenchmark({
      dataset: approvedDataset(),
      runnerA: runner,
      runnerB: runner,
      budgetLedger: ledger,
      reservationFor: () => ({ inputTokenUpperBound: 1, maxOutputTokens: 1 }),
      softLimitCny: 90,
    });
    assert.equal(result.status, 'budget_insufficient');
    assert.equal(result.code, 'BUDGET_HARD_LIMIT');
    assert.equal(calls, 0);
    assert.equal((await ledger.status()).committedCny, 99);
  });

test('after calibration, a projection below 24 Normal pairs returns budget_insufficient',
  async () => {
    const ledger = new BudgetLedger({
      limits: { soft: 90, hard: 100 },
      pricing: { input: 1_000_000, output: 0, cacheCreation: 1_000_000, cacheRead: 0 },
    });
    let calls = 0;
    const runnerA = async () => {
      calls += 1;
      return { usage: { inputTokens: 1 } };
    };
    const runnerB = async () => {
      calls += 1;
      return { usage: { inputTokens: 2 } };
    };
    const result = await runPairedBenchmark({
      dataset: approvedDataset(),
      runnerA,
      runnerB,
      budgetLedger: ledger,
      reservationFor: () => ({ inputTokenUpperBound: 2, maxOutputTokens: 1 }),
      deepCostMultiplier: 2,
    });
    assert.equal(result.status, 'budget_insufficient');
    assert.equal(result.phase, 'planning');
    assert.equal(result.plan.minimumNormalPairs, 24);
    assert.equal(calls, 8);
    assert.equal(result.records.length, 8);
    assert.equal(result.budget.settledCny, 12);
  });

test('once a pair is reserved, the second runner still starts when the first runner fails',
  async () => {
    let agentCalls = 0;
    let ragCalls = 0;
    const result = await runPairedBenchmark({
      dataset: approvedDataset(),
      runnerA: async () => {
        agentCalls += 1;
        const error = new Error('synthetic private failure');
        error.code = 'SYNTHETIC_FAILURE';
        throw error;
      },
      runnerB: async () => {
        ragCalls += 1;
        return { usage: SMALL_USAGE };
      },
      budgetLedger: cheapLedger(),
      reservationFor: SMALL_BOUNDS,
    });
    assert.equal(result.status, 'calibration_failed');
    assert.equal(agentCalls, 1);
    assert.equal(ragCalls, 1);
    assert.equal(result.records.length, 2);
    assert.deepEqual(new Set(result.records.map((record) => record.status)),
      new Set(['success', 'failed']));
    assert.ok(result.budget.uncertainCny > 0);
  });
