#!/usr/bin/env node

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BenchmarkValidationError,
  BudgetGate,
  DEFAULT_BUDGET,
  DEFAULT_K_VALUES,
  DEFAULT_PRICING,
  FAIR_MODEL_CONFIGURATION,
  assertAnonymousReport,
  scanDatasetSecrets,
  scanSnapshotSecrets,
  sha256,
  summarizeOfflineResults,
  validateDataset,
  verifyDatasetEvidence,
  verifySnapshot,
  verifySnapshotProvenance,
  verifySourceManifest,
  writePrivateJson,
} from './lib/benchmark-core.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function localDate() {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (name) => values.find((entry) => entry.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function defaultWorkspace() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'vaultmind-benchmark', localDate());
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (!current.startsWith('--')) {
      throw new BenchmarkValidationError(`Unexpected positional argument: ${current}`, 'INVALID_ARGUMENT');
    }
    const equals = current.indexOf('=');
    if (equals > 2) {
      options[current.slice(2, equals)] = current.slice(equals + 1);
      continue;
    }
    const key = current.slice(2);
    const next = rest[index + 1];
    options[key] = next && !next.startsWith('--') ? rest[++index] : true;
  }
  return { command, options };
}

function usage() {
  return `Usage:
  node scripts/benchmark-compare.mjs prepare [options]
  node scripts/benchmark-compare.mjs validate [options]
  node scripts/benchmark-compare.mjs run --offline-results FILE [options]
  node scripts/benchmark-compare.mjs report [options]

Common options:
  --workspace DIR           Private benchmark workspace (default: XDG data directory)
  --dataset FILE            Reviewed private dataset JSON
  --snapshot DIR            Read-only benchmark snapshot
  --snapshot-manifest FILE  sha256sum-format snapshot manifest
  --source-root DIR          Pinned backup root used to create the snapshot
  --source-manifest FILE     sha256sum-format full backup manifest
  --source-manifest-sha256 H Pre-approved digest of the full backup manifest
  --source-file-count N      Expected full backup file count
  --allow-nonstandard       Do not enforce the planned 48-question category distribution
  --skip-secret-scan        Skip high-confidence credential scan (not recommended)

Run is intentionally offline-only. It scores pre-recorded, adjudicated JSON and never
imports a model client. A dataset-level approval, per-item approvals, matching dataset
digest, and a byte-for-byte verified snapshot manifest are mandatory.
`;
}

function pathsFor(options) {
  const workspace = path.resolve(String(options.workspace || defaultWorkspace()));
  return {
    workspace,
    dataset: path.resolve(String(options.dataset || path.join(workspace, 'benchmark-48.private.json'))),
    snapshot: path.resolve(String(options.snapshot || path.join(workspace, 'snapshot'))),
    manifest: path.resolve(String(options['snapshot-manifest'] || path.join(workspace, 'snapshot.sha256'))),
    sourceRoot: options['source-root'] ? path.resolve(String(options['source-root'])) : null,
    sourceManifest: options['source-manifest']
      ? path.resolve(String(options['source-manifest']))
      : null,
  };
}

async function verifiedSource(options, locations, snapshot) {
  const required = options['allow-nonstandard'] !== true;
  if (!locations.sourceRoot || !locations.sourceManifest) {
    if (!required) return null;
    throw new BenchmarkValidationError(
      'The planned benchmark requires --source-root and --source-manifest.',
      'SOURCE_PROVENANCE_REQUIRED',
    );
  }
  const expectedManifestSha256 = String(options['source-manifest-sha256'] || '').toLowerCase();
  const expectedFileCount = Number(options['source-file-count']);
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256) || !Number.isInteger(expectedFileCount)) {
    throw new BenchmarkValidationError(
      '--source-manifest-sha256 and --source-file-count are required pinned values.',
      'SOURCE_PROVENANCE_REQUIRED',
    );
  }
  const source = await verifySourceManifest({
    sourceRoot: locations.sourceRoot,
    manifestFile: locations.sourceManifest,
    expectedManifestSha256,
    expectedFileCount,
    strictFileSet: true,
  });
  const provenance = await verifySnapshotProvenance(source, snapshot);
  return { source, provenance };
}

async function readJson(filename) {
  try {
    return { raw: await fsp.readFile(filename), filename };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new BenchmarkValidationError(`Required JSON file is missing: ${filename}`, 'FILE_NOT_FOUND');
    }
    throw error;
  }
}

function parseJson(file) {
  try {
    return JSON.parse(file.raw.toString('utf8'));
  } catch {
    throw new BenchmarkValidationError(`JSON is invalid: ${file.filename}`, 'INVALID_JSON');
  }
}

function validationOptions(options, extra = {}) {
  return {
    enforcePlan: options['allow-nonstandard'] !== true,
    expectedItems: options['expected-items'],
    ...extra,
  };
}

async function verifiedDataset(options, requirements = {}) {
  const locations = pathsFor(options);
  const datasetFile = await readJson(locations.dataset);
  const rawDataset = parseJson(datasetFile);
  const preliminarilyValidated = validateDataset(
    rawDataset,
    validationOptions(options, { requireApproved: Boolean(requirements.requireApproved) }),
  );
  const snapshot = await verifySnapshot({
    snapshotRoot: locations.snapshot,
    manifestFile: locations.manifest,
    expectedManifestSha256: preliminarilyValidated.snapshot.manifestSha256,
    requireReadOnly: true,
  });
  const sourceVerification = await verifiedSource(options, locations, snapshot);
  if (snapshot.fileCount !== preliminarilyValidated.snapshot.fileCount) {
    throw new BenchmarkValidationError(
      'Dataset snapshot.fileCount differs from the verified manifest.',
      'SNAPSHOT_FILE_COUNT_MISMATCH',
    );
  }
  const dataset = validateDataset(rawDataset, validationOptions(options, {
    requireApproved: Boolean(requirements.requireApproved),
    snapshotPaths: snapshot.paths,
  }));
  const evidenceVerification = await verifyDatasetEvidence(dataset, snapshot);
  if (options['skip-secret-scan'] !== true) {
    const findings = [
      ...await scanSnapshotSecrets(snapshot),
      ...scanDatasetSecrets(dataset),
    ];
    if (findings.length) {
      const counts = Object.groupBy
        ? Object.groupBy(findings, (finding) => finding.type)
        : findings.reduce((groups, finding) => {
          groups[finding.type] ||= [];
          groups[finding.type].push(finding);
          return groups;
        }, {});
      throw new BenchmarkValidationError(
        `Snapshot credential scan found ${findings.length} blocker(s).`,
        'SNAPSHOT_SECRET_SCAN_FAILED',
        Object.entries(counts).map(([type, entries]) => `${type}: ${entries.length}`),
      );
    }
  }
  return {
    locations,
    dataset,
    datasetSha256: sha256(datasetFile.raw),
    snapshot,
    evidenceVerification,
    sourceVerification,
  };
}

async function prepare(options) {
  const locations = pathsFor(options);
  await fsp.mkdir(locations.workspace, { recursive: true, mode: 0o700 });
  await fsp.chmod(locations.workspace, 0o700);
  const manifest = await fsp.readFile(locations.manifest);
  const manifestSha256 = sha256(manifest);
  const snapshot = await verifySnapshot({
    snapshotRoot: locations.snapshot,
    manifestFile: locations.manifest,
    expectedManifestSha256: manifestSha256,
    requireReadOnly: true,
  });
  const sourceVerification = await verifiedSource(options, locations, snapshot);
  const findings = options['skip-secret-scan'] === true ? [] : await scanSnapshotSecrets(snapshot);
  if (findings.length) {
    throw new BenchmarkValidationError(
      `Snapshot credential scan found ${findings.length} blocker(s); preparation stopped.`,
      'SNAPSHOT_SECRET_SCAN_FAILED',
      [...new Set(findings.map((finding) => finding.type))],
    );
  }
  const state = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    networkPolicy: 'disabled',
    snapshot: {
      manifestRoot: locations.snapshot,
      manifestSha256,
      fileCount: snapshot.fileCount,
      readOnlyVerified: true,
      secretsScan: options['skip-secret-scan'] === true ? 'skipped' : 'passed',
    },
    source: sourceVerification ? {
      manifestRoot: sourceVerification.source.realRoot,
      manifestFile: locations.sourceManifest,
      manifestSha256: sourceVerification.source.manifestSha256,
      fileCount: sourceVerification.source.fileCount,
      rootStat: sourceVerification.source.rootStat,
    } : null,
    filtering: sourceVerification?.provenance || null,
    budget: DEFAULT_BUDGET,
    pricingCnyPerMillionTokens: DEFAULT_PRICING,
    modelConfiguration: FAIR_MODEL_CONFIGURATION,
    nextStep: 'Create and human-review the private dataset; do not run before every item is approved.',
  };
  await writePrivateJson(path.join(locations.workspace, 'benchmark-state.json'), state);
  return {
    command: 'prepare',
    prepared: true,
    manifestSha256,
    fileCount: snapshot.fileCount,
    sourceFileCount: sourceVerification?.source.fileCount || null,
    filterPolicySha256: sourceVerification?.provenance.policySha256 || null,
    stateFile: path.join(locations.workspace, 'benchmark-state.json'),
    networkUsed: false,
  };
}

async function validate(options) {
  const result = await verifiedDataset(options, {
    requireApproved: options['require-approved'] === true,
  });
  const receipt = {
    schemaVersion: 1,
    validatedAt: new Date().toISOString(),
    datasetSha256: result.datasetSha256,
    snapshotManifestSha256: result.snapshot.manifestSha256,
    sourceManifestSha256: result.sourceVerification?.source.manifestSha256 || null,
    filterPolicySha256: result.sourceVerification?.provenance.policySha256 || null,
    evidenceVerification: result.evidenceVerification,
    questions: result.dataset.items.length,
    readyToRun: result.dataset.reviewStatus === 'approved' &&
      result.dataset.items.every((item) => item.review === 'approved'),
    networkUsed: false,
  };
  const receiptFile = path.resolve(String(
    options.output || path.join(result.locations.workspace, 'validation-receipt.json'),
  ));
  await writePrivateJson(receiptFile, receipt);
  return {
    command: 'validate',
    valid: true,
    readyToRun: receipt.readyToRun,
    datasetSha256: result.datasetSha256,
    snapshotManifestSha256: result.snapshot.manifestSha256,
    questions: result.dataset.items.length,
    fileCount: result.snapshot.fileCount,
    receiptFile,
    networkUsed: false,
  };
}

function numberOption(options, key, fallback) {
  if (options[key] === undefined) return fallback;
  const value = Number(options[key]);
  if (!Number.isFinite(value) || value < 0) {
    throw new BenchmarkValidationError(`--${key} must be a finite non-negative number.`, 'INVALID_ARGUMENT');
  }
  return value;
}

async function run(options) {
  if (!options['offline-results']) {
    throw new BenchmarkValidationError(
      'Cloud/model execution is disabled in this safety skeleton; --offline-results is required.',
      'NETWORK_EXECUTION_DISABLED',
    );
  }
  if (options.adapter && options.adapter !== 'offline') {
    throw new BenchmarkValidationError('Only the offline adapter is permitted.', 'NETWORK_EXECUTION_DISABLED');
  }
  const verified = await verifiedDataset(options, { requireApproved: true });
  const resultFile = await readJson(path.resolve(String(options['offline-results'])));
  const offline = parseJson(resultFile);
  if (String(offline.datasetSha256 || '') !== verified.datasetSha256) {
    throw new BenchmarkValidationError(
      'Offline results datasetSha256 does not match the approved dataset bytes.',
      'RESULT_DATASET_MISMATCH',
    );
  }
  const pricing = {
    inputPerMillion: numberOption(options, 'input-price', DEFAULT_PRICING.inputPerMillion),
    outputPerMillion: numberOption(options, 'output-price', DEFAULT_PRICING.outputPerMillion),
    cacheReadPerMillion: numberOption(
      options,
      'cache-read-price',
      DEFAULT_PRICING.cacheReadPerMillion,
    ),
    cacheCreationPerMillion: numberOption(
      options,
      'cache-creation-price',
      DEFAULT_PRICING.cacheCreationPerMillion,
    ),
  };
  const budget = {
    hardLimitCny: numberOption(options, 'budget', DEFAULT_BUDGET.hardLimitCny),
    startLimitCny: numberOption(options, 'start-limit', DEFAULT_BUDGET.startLimitCny),
  };
  const summary = summarizeOfflineResults(offline, verified.dataset, {
    pricing,
    budget,
    kValues: DEFAULT_K_VALUES,
  });
  const totalCost = summary.anonymous.systems.reduce(
    (total, system) => total + Number(system.estimatedCostCny || 0),
    0,
  );
  const gate = new BudgetGate(budget);
  gate.settle({ estimate: 0 }, totalCost);
  summary.anonymous.benchmark.budgetStatus = gate.status();
  summary.private.datasetSha256 = verified.datasetSha256;
  summary.private.snapshotManifestSha256 = verified.snapshot.manifestSha256;
  summary.private.sourceResultsSha256 = sha256(resultFile.raw);
  const target = path.resolve(String(
    options.output || path.join(verified.locations.workspace, 'run-private-summary.json'),
  ));
  await writePrivateJson(target, summary);
  return {
    command: 'run',
    scored: true,
    output: target,
    systems: summary.anonymous.systems.length,
    totalEstimatedCostCny: Number(totalCost.toFixed(6)),
    budgetStatus: gate.status(),
    networkUsed: false,
  };
}

async function report(options) {
  const locations = pathsFor(options);
  const input = path.resolve(String(
    options.input || path.join(locations.workspace, 'run-private-summary.json'),
  ));
  const sourceFile = await readJson(input);
  const source = parseJson(sourceFile);
  const anonymous = assertAnonymousReport(source.anonymous || source);
  const output = path.resolve(String(
    options.output || path.join(projectRoot, 'reports', 'benchmark-summary.anonymous.json'),
  ));
  await writePrivateJson(output, anonymous);
  return {
    command: 'report',
    generated: true,
    outputFile: path.basename(output),
    sha256: sha256(await fsp.readFile(output)),
    containsPrivateQuestionsOrPaths: false,
    networkUsed: false,
  };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!command || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  const handlers = { prepare, validate, run, report };
  if (!handlers[command]) throw new BenchmarkValidationError(`Unknown command: ${command}`, 'INVALID_COMMAND');
  const result = await handlers[command](options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const safe = {
    ok: false,
    code: String(error?.code || 'BENCHMARK_ERROR'),
    message: String(error?.message || 'Benchmark command failed.').slice(0, 500),
    details: Array.isArray(error?.details) ? error.details.slice(0, 30) : [],
    networkUsed: false,
  };
  process.stderr.write(`${JSON.stringify(safe, null, 2)}\n`);
  process.exitCode = 1;
});
