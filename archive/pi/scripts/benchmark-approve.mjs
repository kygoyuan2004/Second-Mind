#!/usr/bin/env node

import {
  PINNED_APPROVAL_HASHES,
  approveDatasetFiles,
} from './lib/benchmark-approval.mjs';
import { BenchmarkValidationError } from './lib/benchmark-core.mjs';

function usage() {
  return `Usage:
  node scripts/benchmark-approve.mjs \\
    --draft FILE --review-markdown FILE \\
    --output FILE --receipt FILE \\
    [--expected-draft-sha256 SHA256] \\
    [--expected-review-sha256 SHA256]

The command performs an offline, hash-pinned approval conversion. It never overwrites
an existing artifact and never reads the benchmark snapshot or calls a model.
`;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (['--help', '-h'].includes(current)) return { help: true };
    if (!current.startsWith('--')) {
      throw new BenchmarkValidationError('Unexpected positional argument.', 'INVALID_ARGUMENT');
    }
    const equals = current.indexOf('=');
    if (equals > 2) {
      options[current.slice(2, equals)] = current.slice(equals + 1);
      continue;
    }
    const key = current.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new BenchmarkValidationError('Every approval option requires a value.', 'INVALID_ARGUMENT');
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  for (const key of ['draft', 'review-markdown', 'output', 'receipt']) {
    if (!options[key]) {
      throw new BenchmarkValidationError(
        'Draft, review Markdown, output, and receipt paths are required.',
        'INVALID_ARGUMENT',
      );
    }
  }
  const result = await approveDatasetFiles({
    draftFile: options.draft,
    reviewMarkdownFile: options['review-markdown'],
    outputFile: options.output,
    receiptFile: options.receipt,
    expectedDraftSha256: options['expected-draft-sha256'] || PINNED_APPROVAL_HASHES.draftSha256,
    expectedReviewMarkdownSha256: options['expected-review-sha256'] ||
      PINNED_APPROVAL_HASHES.reviewMarkdownSha256,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ...result,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: String(error?.code || 'DATASET_APPROVAL_FAILED'),
    message: String(error?.message || 'Dataset approval failed.').slice(0, 300),
    networkUsed: false,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
