#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeIndex } from '../src/knowledge-index.mjs';
import {
  CompletenessEvalError,
  DEFAULT_COMPLETENESS_K_VALUES,
  assertOwnerPrivateFile,
  blockedCompletenessReport,
  createOfflineEmbeddingClient,
  evaluateCompleteness,
  loadPrivateQueryVectors,
  measuredCompletenessReport,
  parseCompletenessDataset,
  readPersistedIndexSignature,
  validateGoldFiles,
  writePrivateReport,
} from './lib/completeness-eval.mjs';

function parseArguments(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new CompletenessEvalError('INVALID_ARGUMENTS');
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new CompletenessEvalError('INVALID_ARGUMENTS');
    if (Object.hasOwn(output, key)) throw new CompletenessEvalError('INVALID_ARGUMENTS');
    output[key] = next;
    index += 1;
  }
  return output;
}

function requiredPath(options, key) {
  const value = String(options[key] || '').trim();
  if (!value) throw new CompletenessEvalError('INVALID_ARGUMENTS');
  return path.resolve(value);
}

function parseKValues(value) {
  if (!value) return [...DEFAULT_COMPLETENESS_K_VALUES];
  const values = [...new Set(String(value).split(',').map(Number))]
    .filter((item) => Number.isSafeInteger(item) && item > 0 && item <= 30)
    .sort((left, right) => left - right);
  if (!values.length) throw new CompletenessEvalError('INVALID_K_VALUES');
  return values;
}

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let index;
let report;
let outputFile;
let dataset;
let requestedRoute = 'hybrid';

try {
  const options = parseArguments(process.argv.slice(2));
  const allowed = new Set(['questions', 'gold', 'vault', 'index', 'mode', 'query-vectors', 'k', 'output']);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw new CompletenessEvalError('INVALID_ARGUMENTS');
  }
  const questionsFile = requiredPath(options, 'questions');
  const goldFile = requiredPath(options, 'gold');
  const vaultRoot = requiredPath(options, 'vault');
  const indexRoot = requiredPath(options, 'index');
  requestedRoute = String(options.mode || 'hybrid').trim().toLowerCase();
  if (!['keyword', 'hybrid'].includes(requestedRoute)) throw new CompletenessEvalError('INVALID_MODE');
  const kValues = parseKValues(options.k);
  outputFile = path.resolve(String(
    options.output || path.join(projectRoot, '.local', 'evaluation', `completeness-30-${requestedRoute}.json`),
  ));

  await Promise.all([
    assertOwnerPrivateFile(questionsFile),
    assertOwnerPrivateFile(goldFile),
  ]);
  const [cleanText, goldText] = await Promise.all([
    fsp.readFile(questionsFile, 'utf8'),
    fsp.readFile(goldFile, 'utf8'),
  ]);
  dataset = parseCompletenessDataset(cleanText, goldText, { expectedCount: 30 });
  await validateGoldFiles(dataset, vaultRoot);

  const persisted = await readPersistedIndexSignature(indexRoot);
  let queryVectors = new Map();
  if (requestedRoute === 'hybrid') {
    if (!persisted.signature.enabled || !options['query-vectors']) {
      throw new CompletenessEvalError('QUERY_VECTORS_REQUIRED_OFFLINE');
    }
    queryVectors = await loadPrivateQueryVectors(
      path.resolve(options['query-vectors']),
      dataset,
      persisted.signature,
    );
  }

  const client = createOfflineEmbeddingClient(persisted.signature, queryVectors);
  index = new KnowledgeIndex({
    vaultPath: vaultRoot,
    indexDir: persisted.root,
    excludedPaths: [],
    embedding: { ...persisted.signature },
    retrieval: { watch: false, topK: Math.max(...kValues), reconcileIntervalMs: 0 },
  }, {
    client,
    watch: false,
    autoBuild: false,
    reconcileIntervalMs: 0,
  });
  await index.ready;
  if (!index.status().available) throw new CompletenessEvalError('INDEX_UNAVAILABLE');
  const evaluation = await evaluateCompleteness(dataset, {
    route: requestedRoute,
    kValues,
    search: (question, searchOptions) => index.search(question, searchOptions),
  });
  report = measuredCompletenessReport(evaluation, { route: requestedRoute });
} catch (error) {
  const reasonCode = error instanceof CompletenessEvalError
    ? error.code
    : String(error?.code || 'OFFLINE_EVALUATION_FAILED');
  let questionCount = 30;
  if (reasonCode === 'QUESTION_COUNT_MISMATCH') questionCount = 0;
  report = blockedCompletenessReport({
    route: requestedRoute,
    questionCount,
    dataset,
    reasonCode,
  });
  process.exitCode = 2;
} finally {
  await index?.close().catch(() => {});
}

try {
  outputFile ||= path.join(projectRoot, '.local', 'evaluation', 'completeness-30-blocked.json');
  await writePrivateReport(outputFile, report, projectRoot);
  process.stdout.write(`${JSON.stringify({
    status: report.migration.status,
    route: report.route,
    questions: report.records.length,
    comparable: report.comparability.comparable,
    reasonCode: report.migration.reasonCode || null,
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'blocked',
    reasonCode: error instanceof CompletenessEvalError
      ? error.code
      : String(error?.code || 'PRIVATE_REPORT_WRITE_FAILED'),
  })}\n`);
  process.exitCode = 2;
}
