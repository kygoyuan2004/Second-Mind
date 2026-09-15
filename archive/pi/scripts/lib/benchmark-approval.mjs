import crypto from 'node:crypto';
import fsConstants from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  BenchmarkValidationError,
  sha256,
  validateDataset,
} from './benchmark-core.mjs';

export const PINNED_APPROVAL_HASHES = Object.freeze({
  draftSha256: '097eb4b74cc916ca6175c6044614faa7b06e0949d8d5568e8cd8868f1b0621a4',
  reviewMarkdownSha256: '530d5b57f597a33edf454c91be94ca0811fb0a8c4226777fdab6001b3fc4e658',
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const APPROVAL_CHANGE_PATHS = Object.freeze([
  'reviewStatus',
  'executionAllowed',
  ...Array.from({ length: 48 }, (_, index) => `items[${index}].review.status`),
]);

function approvalError(message, code = 'DATASET_APPROVAL_FAILED') {
  return new BenchmarkValidationError(message, code);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function withoutApprovalState(value) {
  const copy = structuredClone(value);
  delete copy.reviewStatus;
  delete copy.executionAllowed;
  for (const item of copy.items || []) {
    if (item?.review && typeof item.review === 'object' && !Array.isArray(item.review)) {
      delete item.review.status;
    }
  }
  return copy;
}

export function approvalSemanticDigest(value) {
  return sha256(JSON.stringify(stableValue(withoutApprovalState(value))));
}

function changedPaths(before, after, prefix = '') {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) {
      return [prefix || '$'];
    }
    return before.flatMap((entry, index) => changedPaths(
      entry,
      after[index],
      `${prefix}[${index}]`,
    ));
  }
  if (
    before && after && typeof before === 'object' && typeof after === 'object'
  ) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => changedPaths(
      before[key],
      after[key],
      prefix ? `${prefix}.${key}` : key,
    ));
  }
  return [prefix || '$'];
}

function exactDraftApprovalState(value) {
  if (value.reviewStatus !== 'draft' || value.executionAllowed !== false) return false;
  return Array.isArray(value.items) && value.items.length === 48 && value.items.every((item) => (
    item?.review && typeof item.review === 'object' && !Array.isArray(item.review) &&
    item.review.status === 'pending'
  ));
}

export function buildApprovedDataset(draft) {
  validateDataset(draft, { enforcePlan: true, expectedItems: 48 });
  if (!exactDraftApprovalState(draft)) {
    throw approvalError(
      'Approval input must be the exact 48-item draft with execution disabled and every item pending.',
      'INVALID_APPROVAL_STATE',
    );
  }
  const approved = structuredClone(draft);
  approved.reviewStatus = 'approved';
  approved.executionAllowed = true;
  for (const item of approved.items) item.review.status = 'approved';
  validateDataset(approved, {
    enforcePlan: true,
    expectedItems: 48,
    requireApproved: true,
  });
  const actualChanges = changedPaths(draft, approved).sort();
  const expectedChanges = [...APPROVAL_CHANGE_PATHS].sort();
  if (
    actualChanges.length !== expectedChanges.length ||
    actualChanges.some((entry, index) => entry !== expectedChanges[index]) ||
    approvalSemanticDigest(draft) !== approvalSemanticDigest(approved)
  ) {
    throw approvalError(
      'Approval conversion changed content outside the approved state fields.',
      'APPROVAL_INVARIANT_FAILED',
    );
  }
  return approved;
}

async function readPinnedPrivateFile(filename, options = {}) {
  const target = path.resolve(filename);
  const flags = fsConstants.constants.O_RDONLY |
    (fsConstants.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fsp.open(target, flags);
    const before = await handle.stat();
    if (
      !before.isFile() || before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())
    ) {
      throw approvalError(
        'Approval inputs must be owner-only 0600 regular files with one hard link.',
        'UNSAFE_APPROVAL_INPUT',
      );
    }
    if (before.size > Number(options.maximumBytes || 5 * 1024 * 1024)) {
      throw approvalError('Approval input exceeds the size limit.', 'UNSAFE_APPROVAL_INPUT');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw approvalError('Approval input changed while it was read.', 'APPROVAL_INPUT_CHANGED');
    }
    return { bytes, stat: after, target };
  } catch (error) {
    if (error instanceof BenchmarkValidationError) throw error;
    throw approvalError('Unable to read a pinned approval input.', 'APPROVAL_INPUT_READ_FAILED');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseDraft(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch {
    throw approvalError('Draft dataset is not valid JSON.', 'INVALID_APPROVAL_DRAFT');
  }
}

async function assertPrivateOutputDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsp.stat(directory);
  if (
    !stat.isDirectory() || (stat.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw approvalError('Approval output directory must be owner-only 0700.', 'UNSAFE_APPROVAL_OUTPUT');
  }
}

async function assertAbsent(filename) {
  try {
    await fsp.lstat(filename);
    throw approvalError('Approval output already exists; refusing to overwrite it.', 'APPROVAL_OUTPUT_EXISTS');
  } catch (error) {
    if (error instanceof BenchmarkValidationError) throw error;
    if (error.code !== 'ENOENT') {
      throw approvalError('Unable to inspect an approval output.', 'UNSAFE_APPROVAL_OUTPUT');
    }
  }
}

async function writeSyncedTemporary(filename, bytes) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  return temporary;
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function approveDatasetFiles(options = {}) {
  const expectedDraftSha256 = String(options.expectedDraftSha256 || '').toLowerCase();
  const expectedReviewMarkdownSha256 = String(
    options.expectedReviewMarkdownSha256 || '',
  ).toLowerCase();
  if (!SHA256_PATTERN.test(expectedDraftSha256) || !SHA256_PATTERN.test(expectedReviewMarkdownSha256)) {
    throw approvalError('Both pinned approval SHA-256 values are required.', 'APPROVAL_HASH_REQUIRED');
  }
  const draftFile = await readPinnedPrivateFile(options.draftFile);
  const reviewFile = await readPinnedPrivateFile(options.reviewMarkdownFile, {
    maximumBytes: 2 * 1024 * 1024,
  });
  const actualDraftSha256 = sha256(draftFile.bytes);
  const actualReviewMarkdownSha256 = sha256(reviewFile.bytes);
  if (
    actualDraftSha256 !== expectedDraftSha256 ||
    actualReviewMarkdownSha256 !== expectedReviewMarkdownSha256
  ) {
    throw approvalError(
      'Draft or review Markdown does not match the user-approved pinned hash.',
      'APPROVAL_HASH_MISMATCH',
    );
  }
  const outputFile = path.resolve(options.outputFile);
  const receiptFile = path.resolve(options.receiptFile);
  const outputDirectory = path.dirname(outputFile);
  const safeOutputName = (filename) => (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(path.basename(filename))
  );
  if (
    outputFile === receiptFile || outputFile === draftFile.target || outputFile === reviewFile.target ||
    receiptFile === draftFile.target || receiptFile === reviewFile.target ||
    path.dirname(receiptFile) !== outputDirectory || path.dirname(draftFile.target) !== outputDirectory ||
    path.dirname(reviewFile.target) !== outputDirectory ||
    !safeOutputName(outputFile) || !safeOutputName(receiptFile)
  ) {
    throw approvalError(
      'Draft, review, approved dataset, and receipt must be distinct files in one private directory.',
      'UNSAFE_APPROVAL_OUTPUT',
    );
  }
  await assertPrivateOutputDirectory(outputDirectory);
  await assertAbsent(outputFile);
  await assertAbsent(receiptFile);

  const draft = parseDraft(draftFile.bytes);
  const approved = buildApprovedDataset(draft);
  const approvedBytes = Buffer.from(`${JSON.stringify(approved, null, 2)}\n`, 'utf8');
  const approvedSha256 = sha256(approvedBytes);
  const semanticSha256 = approvalSemanticDigest(draft);
  const createdAt = options.createdAt || new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(createdAt)) {
    throw approvalError('Approval timestamp must be an ISO-8601 UTC value.', 'INVALID_APPROVAL_TIME');
  }
  const receipt = {
    schemaVersion: 1,
    receiptType: 'benchmark-dataset-user-approval',
    status: 'approved',
    createdAt,
    authorization: 'user-approved-cloud-calibration',
    draftSha256: actualDraftSha256,
    reviewMarkdownSha256: actualReviewMarkdownSha256,
    approvedDatasetSha256: approvedSha256,
    approvalInvariantSha256: semanticSha256,
    snapshotManifestSha256: String(draft.snapshot?.manifestSha256 || ''),
    questionCount: approved.items.length,
    changedFields: [
      'reviewStatus',
      'executionAllowed',
      'items[*].review.status',
    ],
    approvedState: {
      reviewStatus: 'approved',
      executionAllowed: true,
      itemReviewStatus: 'approved',
    },
    outputFiles: {
      approvedDataset: path.basename(outputFile),
      receipt: path.basename(receiptFile),
    },
    networkUsed: false,
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  let approvedTemporary;
  let receiptTemporary;
  let approvedCommitted = false;
  let receiptCommitted = false;
  try {
    approvedTemporary = await writeSyncedTemporary(outputFile, approvedBytes);
    receiptTemporary = await writeSyncedTemporary(receiptFile, receiptBytes);
    await fsp.link(approvedTemporary, outputFile);
    approvedCommitted = true;
    await fsp.unlink(approvedTemporary);
    approvedTemporary = null;
    await fsp.chmod(outputFile, 0o600);
    await syncDirectory(outputDirectory);
    await fsp.link(receiptTemporary, receiptFile);
    receiptCommitted = true;
    await fsp.unlink(receiptTemporary);
    receiptTemporary = null;
    await fsp.chmod(receiptFile, 0o600);
    await syncDirectory(outputDirectory);
  } catch (error) {
    await fsp.rm(approvedTemporary, { force: true }).catch(() => {});
    await fsp.rm(receiptTemporary, { force: true }).catch(() => {});
    if (approvedCommitted) await fsp.rm(outputFile, { force: true }).catch(() => {});
    if (receiptCommitted) await fsp.rm(receiptFile, { force: true }).catch(() => {});
    throw approvalError('Approval artifacts could not be committed.', 'APPROVAL_COMMIT_FAILED');
  }
  return {
    approvedDatasetSha256: approvedSha256,
    receiptSha256: sha256(receiptBytes),
    approvalInvariantSha256: semanticSha256,
    questionCount: approved.items.length,
    outputFiles: receipt.outputFiles,
    networkUsed: false,
  };
}
