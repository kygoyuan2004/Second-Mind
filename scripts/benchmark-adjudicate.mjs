#!/usr/bin/env node

import path from 'node:path';
import {
  createBlindArbitrationPacket,
  generateBlindReviewBundle,
  mergeBlindReviewResults,
  benchmarkAdjudicationInternals,
} from './lib/benchmark-adjudication.mjs';

function usage() {
  return `Usage:
  node scripts/benchmark-adjudicate.mjs prepare \\
    --cloud-run DIR --dataset FILE --output-root DIR [--allow-nonstandard]

  node scripts/benchmark-adjudicate.mjs arbitrate \\
    --manifest FILE --grade FILE --grade FILE --output FILE

  node scripts/benchmark-adjudicate.mjs merge \\
    --manifest FILE --grade FILE --grade FILE --output FILE \\
    [--arbitration-packet FILE --arbitration-result FILE]

All inputs and outputs are private local JSON. prepare refuses to open raw files until
cloud-execution-summary.json proves a completed full run. No command uses the network.
`;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (!current.startsWith('--')) throw new Error('Unexpected positional argument.');
    const key = current.slice(2);
    const next = rest[index + 1];
    const value = next && !next.startsWith('--') ? rest[++index] : true;
    if (key === 'grade') {
      options.grade ||= [];
      options.grade.push(value);
    } else if (Object.hasOwn(options, key)) {
      throw new Error('A command option was repeated unexpectedly.');
    } else {
      options[key] = value;
    }
  }
  return { command, options };
}

function required(options, key) {
  if (typeof options[key] !== 'string' || !options[key]) {
    const error = new Error(`--${key} is required.`);
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  return path.resolve(options[key]);
}

function twoGrades(options) {
  if (!Array.isArray(options.grade) || options.grade.length !== 2 ||
      options.grade.some((value) => typeof value !== 'string')) {
    const error = new Error('Exactly two --grade FILE options are required.');
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  return options.grade.map((value) => path.resolve(value));
}

async function prepare(options) {
  const datasetFile = await benchmarkAdjudicationInternals.readPrivateJsonFile(
    required(options, 'dataset'),
    'approved benchmark dataset',
  );
  const result = await generateBlindReviewBundle({
    dataset: datasetFile.value,
    datasetSha256: datasetFile.sha256,
    cloudRunRoot: required(options, 'cloud-run'),
    outputRoot: required(options, 'output-root'),
    enforcePlan: options['allow-nonstandard'] !== true,
  });
  return {
    command: 'prepare',
    generated: true,
    outputDirectory: path.basename(result.outputRoot),
    manifestFile: path.basename(result.manifestFile),
    manifestSha256: result.manifestSha256,
    packets: result.packetFiles.map((packet) => ({
      graderId: packet.graderId,
      file: path.basename(packet.file),
      sha256: packet.sha256,
      cases: packet.caseCount,
    })),
    rawRecords: result.rawRecordCount,
    casesPerGrader: result.gradeRequiredCount,
    networkUsed: false,
  };
}

async function arbitrate(options) {
  const result = await createBlindArbitrationPacket({
    manifestFile: required(options, 'manifest'),
    graderResultFiles: twoGrades(options),
    outputFile: required(options, 'output'),
  });
  return {
    command: 'arbitrate',
    arbitrationRequired: result.required,
    conflicts: result.conflictCount,
    packetFile: result.packetFile ? path.basename(result.packetFile) : null,
    packetSha256: result.packetSha256,
    networkUsed: false,
  };
}

async function merge(options) {
  const hasPacket = typeof options['arbitration-packet'] === 'string';
  const hasResult = typeof options['arbitration-result'] === 'string';
  if (hasPacket !== hasResult) {
    const error = new Error('Arbitration packet and result must be supplied together.');
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  const result = await mergeBlindReviewResults({
    manifestFile: required(options, 'manifest'),
    graderResultFiles: twoGrades(options),
    outputFile: required(options, 'output'),
    ...(hasPacket ? {
      arbitrationPacketFile: path.resolve(options['arbitration-packet']),
      arbitrationResultFile: path.resolve(options['arbitration-result']),
    } : {}),
  });
  return {
    command: 'merge',
    merged: true,
    outputFile: path.basename(result.outputFile),
    sha256: result.outputSha256,
    systems: result.systems,
    records: result.records,
    arbitratedCases: result.conflictCount,
    networkUsed: false,
  };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!command || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  const handlers = { prepare, arbitrate, merge };
  if (!handlers[command]) {
    const error = new Error('Unknown command.');
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  const result = await handlers[command](options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: String(error?.code || 'BENCHMARK_ADJUDICATION_ERROR').slice(0, 100),
    message: String(error?.message || 'Benchmark adjudication failed.').slice(0, 500),
    conflictCount: Number.isInteger(error?.conflictCount) ? error.conflictCount : undefined,
    networkUsed: false,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
