import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BLIND_EVALUATION_FIELDS,
  blindEvaluationsEqual,
  resolveBlindEvaluation,
  validateBlindEvaluation,
} from '../scripts/lib/benchmark-blind-scoring.mjs';
import {
  aggregateAnswers,
  validateDataset,
} from '../scripts/lib/benchmark-core.mjs';

const EVIDENCE_SHA256 = 'e'.repeat(64);

function answerableEvaluation(overrides = {}) {
  return {
    questionCorrect: false,
    predictedFactCount: 3,
    supportedFactCount: 2,
    goldFactCount: 2,
    matchedGoldFactCount: 1,
    citationCount: 2,
    validCitationCount: 1,
    goldEvidenceCount: 2,
    citedGoldEvidenceCount: 1,
    hallucinatedFactCount: 1,
    contradictionCount: 1,
    refused: false,
    ...overrides,
  };
}

function completeEvaluation(overrides = {}) {
  return answerableEvaluation({
    questionCorrect: true,
    predictedFactCount: 2,
    supportedFactCount: 2,
    matchedGoldFactCount: 2,
    citationCount: 2,
    validCitationCount: 2,
    citedGoldEvidenceCount: 2,
    hallucinatedFactCount: 0,
    contradictionCount: 0,
    ...overrides,
  });
}

function refusalEvaluation(overrides = {}) {
  return {
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
    ...overrides,
  };
}

const ANSWERABLE_CONTEXT = Object.freeze({ goldFactCount: 2, goldEvidenceCount: 2 });
const UNANSWERABLE_CONTEXT = Object.freeze({ goldFactCount: 0, goldEvidenceCount: 0 });

function expectInvalid(value, context = ANSWERABLE_CONTEXT) {
  assert.throws(
    () => validateBlindEvaluation(value, context),
    (error) => error.code === 'INVALID_BLIND_EVALUATION' &&
      !JSON.stringify(error).includes('Synthetic private marker'),
  );
}

test('strict blind validation returns a frozen compare-compatible evaluation', () => {
  const input = completeEvaluation();
  const result = validateBlindEvaluation(input, ANSWERABLE_CONTEXT);
  assert.deepEqual(Object.keys(result), BLIND_EVALUATION_FIELDS);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => { result.questionCorrect = false; }, TypeError);
});

test('strict validation rejects missing, extra, coerced, fractional, and oversized fields', () => {
  const missing = completeEvaluation();
  delete missing.refused;
  expectInvalid(missing);
  expectInvalid({ ...completeEvaluation(), rationale: 'Synthetic private marker' });
  expectInvalid({ ...completeEvaluation(), citationCount: '2' });
  expectInvalid({ ...completeEvaluation(), citationCount: 1.5 });
  expectInvalid({ ...completeEvaluation(), citationCount: 10_001 });
  expectInvalid({ ...completeEvaluation(), questionCorrect: 1 });
  expectInvalid([]);
  assert.throws(
    () => validateBlindEvaluation(completeEvaluation(), {
      goldFactCount: '2',
      goldEvidenceCount: 2,
    }),
    (error) => error.code === 'INVALID_BLIND_EVALUATION_CONTEXT',
  );
});

test('fixed denominators and every numerator relationship fail closed', () => {
  const invalidMutations = [
    { goldFactCount: 1 },
    { goldEvidenceCount: 1 },
    { supportedFactCount: 3, predictedFactCount: 2 },
    { matchedGoldFactCount: 3 },
    { matchedGoldFactCount: 2, supportedFactCount: 1, predictedFactCount: 2,
      hallucinatedFactCount: 1 },
    { validCitationCount: 3 },
    { citedGoldEvidenceCount: 3 },
    { supportedFactCount: 1 },
    { contradictionCount: 2 },
  ];
  for (const mutation of invalidMutations) expectInvalid(answerableEvaluation(mutation));

  expectInvalid(refusalEvaluation({
    predictedFactCount: 1,
    hallucinatedFactCount: 1,
  }), UNANSWERABLE_CONTEXT);
  expectInvalid(refusalEvaluation({
    supportedFactCount: 1,
    predictedFactCount: 1,
  }), UNANSWERABLE_CONTEXT);
  expectInvalid(refusalEvaluation({ citationCount: 1 }), UNANSWERABLE_CONTEXT);
});

test('question correctness is derived consistently from facts and refusal', () => {
  expectInvalid(completeEvaluation({ questionCorrect: false }));
  expectInvalid(answerableEvaluation({ questionCorrect: true }));
  expectInvalid(refusalEvaluation({ questionCorrect: false }), UNANSWERABLE_CONTEXT);
  assert.doesNotThrow(() => validateBlindEvaluation(
    refusalEvaluation({ questionCorrect: false, refused: false }),
    UNANSWERABLE_CONTEXT,
  ));
  assert.doesNotThrow(() => validateBlindEvaluation({
    ...completeEvaluation(),
    questionCorrect: false,
    predictedFactCount: 0,
    supportedFactCount: 0,
    matchedGoldFactCount: 0,
    citationCount: 0,
    validCitationCount: 0,
    citedGoldEvidenceCount: 0,
    refused: true,
  }, ANSWERABLE_CONTEXT));
});

test('blind equality is order-independent but rejects extended or malformed shapes', () => {
  const left = validateBlindEvaluation(completeEvaluation(), ANSWERABLE_CONTEXT);
  const right = Object.fromEntries([...Object.entries(left)].reverse());
  assert.equal(blindEvaluationsEqual(left, right), true);
  assert.equal(blindEvaluationsEqual(left, answerableEvaluation()), false);
  assert.equal(blindEvaluationsEqual(left, { ...right, comment: 'not allowed' }), false);
  assert.equal(blindEvaluationsEqual(left, null), false);
});

test('resolution accepts agreement, requires arbitration for disputes, and pins denominators', () => {
  const agreement = completeEvaluation();
  assert.deepEqual(resolveBlindEvaluation(agreement, structuredClone(agreement)), agreement);
  assert.throws(
    () => resolveBlindEvaluation(agreement, answerableEvaluation()),
    (error) => error.code === 'BLIND_EVALUATION_DISAGREEMENT',
  );

  const arbitrated = resolveBlindEvaluation(agreement, answerableEvaluation(), {
    arbitration: completeEvaluation({
      predictedFactCount: 3,
      supportedFactCount: 3,
    }),
  });
  assert.equal(arbitrated.questionCorrect, true);
  assert.equal(arbitrated.predictedFactCount, 3);
  assert.equal(Object.isFrozen(arbitrated), true);

  assert.throws(
    () => resolveBlindEvaluation(agreement, structuredClone(agreement), {
      arbitration: answerableEvaluation(),
    }),
    (error) => error.code === 'BLIND_ARBITRATION_OVERRIDE_FORBIDDEN',
  );
  assert.throws(
    () => resolveBlindEvaluation(agreement, { ...agreement, goldFactCount: 1 }),
    (error) => error.code === 'BLIND_EVALUATION_DENOMINATOR_MISMATCH',
  );
  assert.throws(
    () => resolveBlindEvaluation(agreement, answerableEvaluation(), {
      arbitration: { ...agreement, goldEvidenceCount: 1 },
    }),
    (error) => error.code === 'INVALID_BLIND_EVALUATION',
  );
});

function datasetItem({ id, answerable }) {
  const evidence = {
    path: 'synthetic/note.md',
    startLine: 1,
    endLine: 1,
    textSha256: EVIDENCE_SHA256,
  };
  const goldFacts = answerable ? [1, 2].map((number) => ({
    id: `${id}-F${number}`,
    text: `Synthetic fact ${number}`,
    evidence: [evidence],
  })) : [];
  return {
    id,
    category: answerable ? 'exact_fact' : 'unanswerable',
    priorMessages: [],
    query: `Synthetic query ${id}`,
    answerable,
    goldAnswer: answerable ? 'Synthetic answer' : 'Cannot answer from the snapshot.',
    referenceAnswer: answerable ? 'Synthetic answer' : 'Cannot answer from the snapshot.',
    goldFacts,
    atomicFacts: structuredClone(goldFacts),
    relevant: answerable ? [{
      path: 'synthetic/note.md',
      grade: 3,
      evidence: [{ startLine: 1, endLine: 1, textSha256: EVIDENCE_SHA256 }],
    }] : [],
    review: { status: 'approved', reviewer: null, comment: null },
  };
}

test('validated outputs drive all existing offline answer metrics without schema conversion', () => {
  const dataset = validateDataset({
    schemaVersion: 1,
    datasetId: 'synthetic-blind-scoring',
    reviewStatus: 'approved',
    executionAllowed: true,
    snapshot: {
      manifestSha256: 'a'.repeat(64),
      fileCount: 1,
      logicalDocumentCount: 1,
    },
    documentAliases: {},
    items: [
      datasetItem({ id: 'Q001', answerable: true }),
      datasetItem({ id: 'Q002', answerable: true }),
      datasetItem({ id: 'Q003', answerable: false }),
    ],
  }, { enforcePlan: false, requireApproved: true });

  const evaluations = [
    validateBlindEvaluation(answerableEvaluation(), ANSWERABLE_CONTEXT),
    validateBlindEvaluation(completeEvaluation(), ANSWERABLE_CONTEXT),
    validateBlindEvaluation(refusalEvaluation(), UNANSWERABLE_CONTEXT),
  ];
  const summary = aggregateAnswers(dataset.items.map((item, index) => ({
    questionId: item.id,
    answerEvaluation: evaluations[index],
  })), dataset);

  assert.deepEqual(summary, {
    evaluatedQuestions: 3,
    questionAccuracy: 0.666667,
    factPrecision: 0.8,
    factRecall: 0.75,
    factF1: 0.774194,
    answerCompleteness: 0.75,
    citationPrecision: 0.75,
    citationRecall: 0.75,
    invalidCitationRate: 0.25,
    hallucinationRate: 0.2,
    contradictionRate: 0.2,
    unanswerableCorrectRefusalRate: 1,
  });
});
