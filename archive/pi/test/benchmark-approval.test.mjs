import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  approvalSemanticDigest,
  approveDatasetFiles,
} from '../scripts/lib/benchmark-approval.mjs';
import {
  PLAN_CATEGORY_COUNTS,
  sha256,
} from '../scripts/lib/benchmark-core.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVIDENCE_SHA256 = 'e'.repeat(64);

function syntheticDraft() {
  const items = [];
  for (const [category, count] of Object.entries(PLAN_CATEGORY_COUNTS)) {
    for (let index = 0; index < count; index += 1) {
      const id = `${category}-${String(index + 1).padStart(2, '0')}`;
      const answerable = category !== 'unanswerable';
      const evidence = {
        path: 'synthetic/note.md',
        startLine: 1,
        endLine: 1,
        textSha256: EVIDENCE_SHA256,
      };
      const goldFacts = answerable ? [{
        id: `${id}-fact`,
        text: `Synthetic fact ${id}`,
        evidence: [evidence],
      }] : [];
      items.push({
        id,
        category,
        priorMessages: category === 'context_followup' ? [
          { role: 'user', content: `Synthetic prior question ${id}` },
          { role: 'assistant', content: `Synthetic prior response ${id}` },
        ] : [],
        query: `Synthetic query ${id}`,
        answerable,
        goldAnswer: answerable ? `Synthetic answer ${id}` : 'Cannot answer from the snapshot.',
        referenceAnswer: answerable ? `Synthetic answer ${id}` : 'Cannot answer from the snapshot.',
        goldFacts,
        atomicFacts: structuredClone(goldFacts),
        relevant: answerable ? [{
          path: 'synthetic/note.md',
          grade: 3,
          evidence: [{
            startLine: 1,
            endLine: 1,
            textSha256: EVIDENCE_SHA256,
          }],
        }] : [],
        review: { status: 'pending', reviewer: null, comment: null },
      });
    }
  }
  return {
    schemaVersion: 1,
    datasetId: 'synthetic-approval-draft',
    reviewStatus: 'draft',
    executionAllowed: false,
    snapshot: {
      manifestSha256: 'a'.repeat(64),
      fileCount: 1,
      logicalDocumentCount: 1,
    },
    documentAliases: {},
    items,
  };
}

function withoutApprovalFields(value) {
  const copy = structuredClone(value);
  delete copy.reviewStatus;
  delete copy.executionAllowed;
  for (const item of copy.items) delete item.review.status;
  return copy;
}

async function approvalFixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'benchmark-approval-'));
  await fsp.chmod(directory, 0o700);
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const draft = syntheticDraft();
  const draftBytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`);
  const reviewBytes = Buffer.from('# Synthetic reviewed benchmark\n');
  const draftFile = path.join(directory, 'draft.json');
  const reviewMarkdownFile = path.join(directory, 'review.md');
  await fsp.writeFile(draftFile, draftBytes, { mode: 0o600 });
  await fsp.writeFile(reviewMarkdownFile, reviewBytes, { mode: 0o600 });
  return {
    directory,
    draft,
    draftFile,
    reviewMarkdownFile,
    expectedDraftSha256: sha256(draftBytes),
    expectedReviewMarkdownSha256: sha256(reviewBytes),
  };
}

test('approval conversion changes only the explicit approval state and emits a private receipt', async (t) => {
  const fixture = await approvalFixture(t);
  const outputFile = path.join(fixture.directory, 'approved.json');
  const receiptFile = path.join(fixture.directory, 'approval-receipt.json');
  const result = await approveDatasetFiles({
    ...fixture,
    outputFile,
    receiptFile,
    createdAt: '2026-08-31T12:00:00.000Z',
  });
  const approvedBytes = await fsp.readFile(outputFile);
  const approved = JSON.parse(approvedBytes);
  const receipt = JSON.parse(await fsp.readFile(receiptFile, 'utf8'));
  assert.equal(approved.reviewStatus, 'approved');
  assert.equal(approved.executionAllowed, true);
  assert.equal(approved.items.length, 48);
  assert.ok(approved.items.every((item) => item.review.status === 'approved'));
  assert.deepEqual(withoutApprovalFields(approved), withoutApprovalFields(fixture.draft));
  assert.equal(approvalSemanticDigest(approved), approvalSemanticDigest(fixture.draft));
  assert.equal(receipt.approvalInvariantSha256, approvalSemanticDigest(fixture.draft));
  assert.equal(receipt.approvedDatasetSha256, sha256(approvedBytes));
  assert.equal(result.approvedDatasetSha256, receipt.approvedDatasetSha256);
  assert.deepEqual(receipt.changedFields, [
    'reviewStatus',
    'executionAllowed',
    'items[*].review.status',
  ]);
  assert.equal(receipt.networkUsed, false);
  assert.equal((await fsp.stat(outputFile)).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(receiptFile)).mode & 0o777, 0o600);
});

test('approval fails closed on either wrong pinned hash and creates no artifacts', async (t) => {
  const fixture = await approvalFixture(t);
  for (const mismatch of ['draft', 'review']) {
    const outputFile = path.join(fixture.directory, `${mismatch}-approved.json`);
    const receiptFile = path.join(fixture.directory, `${mismatch}-receipt.json`);
    await assert.rejects(
      approveDatasetFiles({
        ...fixture,
        outputFile,
        receiptFile,
        expectedDraftSha256: mismatch === 'draft' ? '0'.repeat(64) : fixture.expectedDraftSha256,
        expectedReviewMarkdownSha256: mismatch === 'review'
          ? '0'.repeat(64)
          : fixture.expectedReviewMarkdownSha256,
      }),
      (error) => error.code === 'APPROVAL_HASH_MISMATCH',
    );
    await assert.rejects(fsp.stat(outputFile), (error) => error.code === 'ENOENT');
    await assert.rejects(fsp.stat(receiptFile), (error) => error.code === 'ENOENT');
  }
});

test('approval never overwrites an existing artifact', async (t) => {
  const fixture = await approvalFixture(t);
  const outputFile = path.join(fixture.directory, 'existing-approved.json');
  const receiptFile = path.join(fixture.directory, 'existing-receipt.json');
  await fsp.writeFile(outputFile, 'preserve-me\n', { mode: 0o600 });
  await assert.rejects(
    approveDatasetFiles({ ...fixture, outputFile, receiptFile }),
    (error) => error.code === 'APPROVAL_OUTPUT_EXISTS',
  );
  assert.equal(await fsp.readFile(outputFile, 'utf8'), 'preserve-me\n');
  await assert.rejects(fsp.stat(receiptFile), (error) => error.code === 'ENOENT');
});

test('approval CLI is offline, hash-pinned, and does not print absolute paths', async (t) => {
  const fixture = await approvalFixture(t);
  const outputFile = path.join(fixture.directory, 'cli-approved.json');
  const receiptFile = path.join(fixture.directory, 'cli-receipt.json');
  const result = spawnSync(process.execPath, [
    'scripts/benchmark-approve.mjs',
    '--draft', fixture.draftFile,
    '--review-markdown', fixture.reviewMarkdownFile,
    '--output', outputFile,
    '--receipt', receiptFile,
    '--expected-draft-sha256', fixture.expectedDraftSha256,
    '--expected-review-sha256', fixture.expectedReviewMarkdownSha256,
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"networkUsed": false/);
  assert.equal(result.stdout.includes(fixture.directory), false);
  assert.equal((await fsp.stat(outputFile)).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(receiptFile)).mode & 0o777, 0o600);
});
