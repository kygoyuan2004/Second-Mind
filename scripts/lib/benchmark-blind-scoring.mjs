import {
  BenchmarkValidationError,
} from './benchmark-core.mjs';

export const BLIND_EVALUATION_FIELDS = Object.freeze([
  'questionCorrect',
  'predictedFactCount',
  'supportedFactCount',
  'goldFactCount',
  'matchedGoldFactCount',
  'citationCount',
  'validCitationCount',
  'goldEvidenceCount',
  'citedGoldEvidenceCount',
  'hallucinatedFactCount',
  'contradictionCount',
  'refused',
]);

const BOOLEAN_FIELDS = Object.freeze([
  'questionCorrect',
  'refused',
]);

const COUNT_FIELDS = Object.freeze(BLIND_EVALUATION_FIELDS.filter(
  (field) => !BOOLEAN_FIELDS.includes(field),
));

// A defensive ceiling prevents an accidental or hostile judge response from
// turning a count-only artifact into an unbounded numeric input. It is far
// above the number of facts or citations allowed by this benchmark.
const MAX_BLIND_COUNT = 10_000;

function scoringError(message, code, details = []) {
  return new BenchmarkValidationError(message, code, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 0 && value <= MAX_BLIND_COUNT;
}

function expectedCount(value, label) {
  if (!validCount(value)) {
    throw scoringError(
      'Blind-evaluation context contains an invalid fixed denominator.',
      'INVALID_BLIND_EVALUATION_CONTEXT',
      [`${label} must be a non-negative safe integer no greater than ${MAX_BLIND_COUNT}.`],
    );
  }
  return value;
}

function exactShapeErrors(value) {
  if (!isPlainObject(value)) return ['answerEvaluation must be a plain object.'];
  const keys = Object.keys(value).sort();
  const expected = [...BLIND_EVALUATION_FIELDS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return ['answerEvaluation must contain exactly the approved count and boolean fields.'];
  }
  return [];
}

function invariantErrors(value, context) {
  const errors = [];
  const {
    predictedFactCount: predicted,
    supportedFactCount: supported,
    goldFactCount: gold,
    matchedGoldFactCount: matched,
    citationCount: citations,
    validCitationCount: validCitations,
    goldEvidenceCount: goldEvidence,
    citedGoldEvidenceCount: citedEvidence,
    hallucinatedFactCount: hallucinated,
    contradictionCount: contradictions,
    refused,
    questionCorrect,
  } = value;

  if (gold !== context.goldFactCount) {
    errors.push('goldFactCount must equal the dataset-fixed denominator.');
  }
  if (goldEvidence !== context.goldEvidenceCount) {
    errors.push('goldEvidenceCount must equal the dataset-fixed denominator.');
  }
  if ((gold === 0) !== (goldEvidence === 0)) {
    errors.push('gold fact and evidence denominators must both be zero or both be positive.');
  }
  if (supported > predicted) {
    errors.push('supportedFactCount must not exceed predictedFactCount.');
  }
  if (matched > gold) {
    errors.push('matchedGoldFactCount must not exceed goldFactCount.');
  }
  if (matched > supported) {
    errors.push('matchedGoldFactCount must not exceed supportedFactCount.');
  }
  if (validCitations > citations) {
    errors.push('validCitationCount must not exceed citationCount.');
  }
  if (citedEvidence > goldEvidence) {
    errors.push('citedGoldEvidenceCount must not exceed goldEvidenceCount.');
  }
  if (supported + hallucinated !== predicted) {
    errors.push('supported and hallucinated facts must partition every predicted fact.');
  }
  if (contradictions > hallucinated) {
    errors.push('contradictionCount must be a subset of hallucinatedFactCount.');
  }
  if (gold === 0 && supported !== 0) {
    errors.push('an unanswerable item cannot contain a supported answer fact.');
  }
  if (refused && (predicted !== 0 || citations !== 0)) {
    errors.push('a refusal cannot also contain predicted facts or citations.');
  }

  // Atomic facts are the benchmark's correctness rubric. Citation quality is
  // deliberately scored separately and therefore does not change this flag.
  const deterministicallyCorrect = gold === 0
    ? refused
    : !refused && matched === gold && hallucinated === 0 && contradictions === 0;
  if (questionCorrect !== deterministicallyCorrect) {
    errors.push('questionCorrect disagrees with the atomic-fact and refusal rubric.');
  }
  return errors;
}

/**
 * Validate one identity-hidden judge output and normalize it to the exact
 * answerEvaluation shape consumed by benchmark-core.mjs.
 */
export function validateBlindEvaluation(value, options = {}) {
  const goldFactCount = expectedCount(options.goldFactCount, 'goldFactCount');
  const goldEvidenceCount = expectedCount(options.goldEvidenceCount, 'goldEvidenceCount');
  const errors = exactShapeErrors(value);
  if (!errors.length) {
    for (const field of BOOLEAN_FIELDS) {
      if (typeof value[field] !== 'boolean') errors.push(`${field} must be boolean.`);
    }
    for (const field of COUNT_FIELDS) {
      if (!validCount(value[field])) {
        errors.push(`${field} must be a non-negative safe integer no greater than ${MAX_BLIND_COUNT}.`);
      }
    }
  }
  if (!errors.length) {
    errors.push(...invariantErrors(value, { goldFactCount, goldEvidenceCount }));
  }
  if (errors.length) {
    throw scoringError(
      'Blind answer evaluation is invalid.',
      'INVALID_BLIND_EVALUATION',
      errors,
    );
  }
  return Object.freeze(Object.fromEntries(
    BLIND_EVALUATION_FIELDS.map((field) => [field, value[field]]),
  ));
}

/**
 * Compare two already validated evaluations without depending on property
 * insertion order. Invalid or extended shapes never compare equal.
 */
export function blindEvaluationsEqual(left, right) {
  if (exactShapeErrors(left).length || exactShapeErrors(right).length) return false;
  return BLIND_EVALUATION_FIELDS.every((field) => Object.is(left[field], right[field]));
}

function sharedDenominators(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) {
    throw scoringError(
      'Both blind evaluations must be objects.',
      'INVALID_BLIND_EVALUATION',
    );
  }
  const leftFacts = expectedCount(left.goldFactCount, 'left.goldFactCount');
  const rightFacts = expectedCount(right.goldFactCount, 'right.goldFactCount');
  const leftEvidence = expectedCount(left.goldEvidenceCount, 'left.goldEvidenceCount');
  const rightEvidence = expectedCount(right.goldEvidenceCount, 'right.goldEvidenceCount');
  if (leftFacts !== rightFacts || leftEvidence !== rightEvidence) {
    throw scoringError(
      'Blind evaluators used different fixed denominators.',
      'BLIND_EVALUATION_DENOMINATOR_MISMATCH',
    );
  }
  return { goldFactCount: leftFacts, goldEvidenceCount: leftEvidence };
}

/**
 * Resolve two independent blind scores.
 *
 * Agreement is final: an arbitrator may confirm it but cannot silently change
 * it. Disagreement fails closed until a third, independently valid evaluation
 * is supplied. The arbitrator may correct both judges, but cannot alter the
 * dataset-fixed denominators or introduce commentary/private fields.
 */
export function resolveBlindEvaluation(left, right, options = {}) {
  const context = sharedDenominators(left, right);
  const normalizedLeft = validateBlindEvaluation(left, context);
  const normalizedRight = validateBlindEvaluation(right, context);
  const hasArbitration = options.arbitration !== undefined && options.arbitration !== null;

  if (blindEvaluationsEqual(normalizedLeft, normalizedRight)) {
    if (hasArbitration) {
      const arbitration = validateBlindEvaluation(options.arbitration, context);
      if (!blindEvaluationsEqual(normalizedLeft, arbitration)) {
        throw scoringError(
          'Arbitration cannot override an agreed blind evaluation.',
          'BLIND_ARBITRATION_OVERRIDE_FORBIDDEN',
        );
      }
    }
    return normalizedLeft;
  }

  if (!hasArbitration) {
    throw scoringError(
      'Blind evaluators disagree and an arbitration evaluation is required.',
      'BLIND_EVALUATION_DISAGREEMENT',
    );
  }
  return validateBlindEvaluation(options.arbitration, context);
}
