import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectVaultReplica, markVaultReplicaIndexed, syncVaultReplica } from '../src/vault-replica.mjs';

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'replica-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'copy');
  const stateDir = path.join(root, 'private');
  await fsp.mkdir(sourceRoot);
  return { root, sourceRoot, targetRoot, stateDir };
}

test('publishes verified ordinary files, hidden notes and binary attachments with original mtime', async (t) => {
  const value = await fixture(t);
  await fsp.mkdir(path.join(value.sourceRoot, '.obsidian'));
  await fsp.mkdir(path.join(value.sourceRoot, '日记'));
  await fsp.writeFile(path.join(value.sourceRoot, '日记', '2026-09-05.md'), '本月学习记录');
  await fsp.writeFile(path.join(value.sourceRoot, '.hidden.md'), 'hidden ordinary file');
  const binary = Buffer.from([0, 255, 42, 17]);
  await fsp.writeFile(path.join(value.sourceRoot, 'attachment.bin'), binary);
  const stamp = new Date('2026-07-15T15:46:31.121Z');
  await fsp.utimes(path.join(value.sourceRoot, '.hidden.md'), stamp, stamp);
  const before = await fsp.stat(path.join(value.sourceRoot, '.hidden.md'));
  const result = await syncVaultReplica(value);
  assert.equal(result.status.files, 3);
  assert.equal(result.status.indexPending, true);
  assert.deepEqual(await fsp.readFile(path.join(value.targetRoot, 'attachment.bin')), binary);
  assert.equal(await fsp.readFile(path.join(value.targetRoot, '.hidden.md'), 'utf8'), 'hidden ordinary file');
  assert.ok(Math.abs((await fsp.stat(path.join(value.targetRoot, '.hidden.md'))).mtimeMs - before.mtimeMs) < 1);
  assert.equal((await fsp.stat(path.join(value.sourceRoot, '.hidden.md'))).mtimeMs, before.mtimeMs);
  assert.equal((await fsp.stat(path.join(value.targetRoot, '.obsidian'))).isDirectory(), true);
  const status = await inspectVaultReplica(value);
  assert.equal(JSON.stringify(status).includes(value.root), false);
  assert.equal(JSON.stringify(status).includes('.hidden'), false);
  assert.equal((await fsp.stat(path.join(value.stateDir, 'vault-replica.json'))).mode & 0o777, 0o600);
});

test('manual update propagates source edits and deletions with a recoverable previous copy', async (t) => {
  const value = await fixture(t);
  await fsp.writeFile(path.join(value.sourceRoot, 'old.md'), 'old version');
  await fsp.writeFile(path.join(value.sourceRoot, 'delete.md'), 'deleted upstream');
  const first = await syncVaultReplica(value);
  await markVaultReplicaIndexed({ ...value, expectedVersion: first.status.version, generation: 'generation-1' });
  assert.equal((await inspectVaultReplica(value)).indexPending, false);
  await fsp.writeFile(path.join(value.sourceRoot, 'old.md'), 'new version');
  await fsp.rm(path.join(value.sourceRoot, 'delete.md'));
  await fsp.writeFile(path.join(value.sourceRoot, 'new.md'), 'new note');
  const result = await syncVaultReplica(value);
  assert.deepEqual(result.changedPaths, ['delete.md', 'new.md', 'old.md']);
  assert.equal(result.recoveryAvailable, true);
  assert.equal(result.status.indexPending, true);
  assert.equal(await fsp.readFile(path.join(value.targetRoot, 'old.md'), 'utf8'), 'new version');
  await assert.rejects(fsp.stat(path.join(value.targetRoot, 'delete.md')), { code: 'ENOENT' });
  const recovery = (await fsp.readdir(value.root)).find((name) => name.startsWith('.copy.replica-recovery-'));
  assert.equal(await fsp.readFile(path.join(value.root, recovery, 'delete.md'), 'utf8'), 'deleted upstream');
  await assert.rejects(markVaultReplicaIndexed({ ...value, expectedVersion: first.status.version, generation: 'generation-1' }), { code: 'REPLICA_VERSION_CONFLICT' });
});

for (const kind of ['modified', 'created', 'deleted']) {
  test(`refuses the entire update when the copy contains a locally ${kind} file`, async (t) => {
    const value = await fixture(t);
    await fsp.writeFile(path.join(value.sourceRoot, 'note.md'), 'original');
    await fsp.writeFile(path.join(value.sourceRoot, 'untouched.md'), 'first');
    const first = await syncVaultReplica(value);
    if (kind === 'modified') await fsp.writeFile(path.join(value.targetRoot, 'note.md'), 'local work');
    if (kind === 'created') await fsp.writeFile(path.join(value.targetRoot, 'local.md'), 'local work');
    if (kind === 'deleted') await fsp.rm(path.join(value.targetRoot, 'note.md'));
    await fsp.writeFile(path.join(value.sourceRoot, 'untouched.md'), 'upstream update');
    await assert.rejects(syncVaultReplica(value), { code: 'REPLICA_LOCAL_CONFLICT' });
    assert.equal(await fsp.readFile(path.join(value.targetRoot, 'untouched.md'), 'utf8'), 'first');
    assert.equal((await inspectVaultReplica(value)).version, first.status.version);
  });
}

test('rejects symlinks without publishing or modifying an unrelated fixed benchmark', async (t) => {
  const value = await fixture(t);
  const benchmark = path.join(value.root, 'benchmark');
  await fsp.mkdir(benchmark);
  await fsp.writeFile(path.join(benchmark, 'fixed.md'), 'fixed benchmark');
  await fsp.writeFile(path.join(value.sourceRoot, 'note.md'), 'source');
  await fsp.symlink(path.join(benchmark, 'fixed.md'), path.join(value.sourceRoot, 'link.md'));
  await assert.rejects(syncVaultReplica(value), { code: 'REPLICA_SYMLINK' });
  await assert.rejects(fsp.stat(value.targetRoot), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(path.join(benchmark, 'fixed.md'), 'utf8'), 'fixed benchmark');
  assert.equal((await inspectVaultReplica(value)).configured, false);
  await fsp.rm(path.join(value.sourceRoot, 'link.md'));
  await fsp.symlink(benchmark, path.join(value.root, 'alias'));
  await assert.rejects(syncVaultReplica({ ...value, targetRoot: path.join(value.root, 'alias', 'copy') }), { code: 'REPLICA_SYMLINK' });
});

test('refuses an existing unowned target, nested roots and reuse for a different source', async (t) => {
  const value = await fixture(t);
  await fsp.mkdir(value.targetRoot);
  await assert.rejects(syncVaultReplica(value), { code: 'REPLICA_TARGET_EXISTS' });
  await fsp.rmdir(value.targetRoot);
  await assert.rejects(syncVaultReplica({ ...value, targetRoot: path.join(value.sourceRoot, 'copy') }), { code: 'REPLICA_PATH_OVERLAP' });
  await syncVaultReplica(value);
  const other = path.join(value.root, 'other');
  await fsp.mkdir(other);
  await assert.rejects(syncVaultReplica({ ...value, sourceRoot: other }), { code: 'REPLICA_BINDING_MISMATCH' });
});

test('aborted copy and a disappeared source keep the last published version intact', async (t) => {
  const value = await fixture(t);
  await fsp.writeFile(path.join(value.sourceRoot, 'note.md'), 'version 1');
  const first = await syncVaultReplica(value);
  await fsp.writeFile(path.join(value.sourceRoot, 'note.md'), 'version 2');
  await assert.rejects(syncVaultReplica({ ...value, signal: AbortSignal.abort() }), { name: 'AbortError' });
  await fsp.rename(value.sourceRoot, `${value.sourceRoot}-offline`);
  await assert.rejects(syncVaultReplica(value), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(path.join(value.targetRoot, 'note.md'), 'utf8'), 'version 1');
  assert.equal((await inspectVaultReplica(value)).version, first.status.version);
});

for (const failure of ['change', 'read']) {
  test(`a source ${failure} failure while staging cannot publish a partial copy`, async (t) => {
    const value = await fixture(t);
    const note = path.join(value.sourceRoot, 'note.md');
    await fsp.writeFile(note, 'version 1');
    const first = await syncVaultReplica(value);
    await fsp.writeFile(note, 'version 2');
    const open = fsp.open;
    let triggered = false;
    fsp.open = async (filename, ...args) => {
      if (!triggered && (failure === 'read' ? filename === note : String(filename).includes('.replica-stage-') && String(filename).endsWith('note.md'))) {
        triggered = true;
        if (failure === 'read') throw Object.assign(new Error('Synthetic read failure'), { code: 'EACCES' });
        await fsp.appendFile(note, ' changed during copy');
      }
      return open.call(fsp, filename, ...args);
    };
    try {
      await assert.rejects(syncVaultReplica(value), { code: failure === 'read' ? 'EACCES' : 'REPLICA_SOURCE_CHANGED' });
    } finally { fsp.open = open; }
    assert.equal(triggered, true);
    assert.equal(await fsp.readFile(path.join(value.targetRoot, 'note.md'), 'utf8'), 'version 1');
    assert.equal((await inspectVaultReplica(value)).version, first.status.version);
  });
}

test('unchanged updates retain an acknowledged generation and interrupted publication fails closed', async (t) => {
  const value = await fixture(t);
  await fsp.writeFile(path.join(value.sourceRoot, 'note.md'), 'stable');
  const first = await syncVaultReplica(value);
  await markVaultReplicaIndexed({ ...value, expectedVersion: first.status.version, generation: 'index-123' });
  const next = await syncVaultReplica(value);
  assert.deepEqual(next.changedPaths, []);
  assert.equal(next.status.indexPending, false);
  assert.equal(next.status.indexGeneration, 'index-123');
  await fsp.writeFile(path.join(value.stateDir, 'vault-replica-pending.json'), '{}');
  assert.equal((await inspectVaultReplica(value)).status, 'recovery-required');
  await assert.rejects(syncVaultReplica(value), { code: 'REPLICA_RECOVERY_REQUIRED' });
});

test('a manifest publication failure restores the old target and manifest together', async (t) => {
  const value = await fixture(t);
  await fsp.writeFile(path.join(value.sourceRoot, 'note.md'), 'old published note');
  const first = await syncVaultReplica(value);
  await fsp.writeFile(path.join(value.sourceRoot, 'note.md'), 'new staged note');
  const rename = fsp.rename;
  fsp.rename = async (source, destination) => {
    if (destination === path.join(value.stateDir, 'vault-replica.json')) {
      throw Object.assign(new Error('Synthetic publication failure'), { code: 'EIO' });
    }
    return rename.call(fsp, source, destination);
  };
  try { await assert.rejects(syncVaultReplica(value), { code: 'EIO' }); } finally { fsp.rename = rename; }
  assert.equal(await fsp.readFile(path.join(value.targetRoot, 'note.md'), 'utf8'), 'old published note');
  assert.equal((await inspectVaultReplica(value)).version, first.status.version);
  assert.equal((await inspectVaultReplica(value)).status, 'ready');
});

test('CLI status emits only public replica metadata', async (t) => {
  const value = await fixture(t);
  await fsp.writeFile(path.join(value.sourceRoot, 'private-note.md'), 'private body');
  await syncVaultReplica(value);
  const script = fileURLToPath(new URL('../scripts/sync-vault-copy.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--state-dir', value.stateDir, '--status'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).files, 1);
  assert.equal(result.stdout.includes(value.root), false);
  assert.equal(result.stdout.includes('private-note'), false);
});

test('a different knowledge base cannot inherit a globally configured replica status', async (t) => {
  const value = await fixture(t);
  await fsp.writeFile(path.join(value.sourceRoot, 'note.md'), 'source note');
  const published = await syncVaultReplica(value);
  assert.equal((await inspectVaultReplica({ stateDir: value.stateDir, targetRoot: value.targetRoot })).version, published.status.version);
  const otherRoot = path.join(value.root, 'other-knowledge-base');
  await fsp.mkdir(otherRoot);
  const status = await inspectVaultReplica({ stateDir: value.stateDir, targetRoot: otherRoot });
  assert.equal(status.configured, false);
  assert.equal(status.status, 'unconfigured');
  assert.equal(status.version, '');
  assert.equal(status.lastSuccessfulSyncAt, null);
  assert.equal(status.files, 0);
  assert.equal(status.indexPending, false);
  assert.equal(status.indexGeneration, '');
  await fsp.writeFile(path.join(value.stateDir, 'vault-replica-pending.json'), '{}');
  assert.equal((await inspectVaultReplica({ stateDir: value.stateDir, targetRoot: otherRoot })).status, 'unconfigured');
});
