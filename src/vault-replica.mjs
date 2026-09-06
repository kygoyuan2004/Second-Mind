import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const FORMAT = 1;
const MANIFEST = 'vault-replica.json';
const HASH = /^[a-f0-9]{64}$/u;

function fail(code, message, conflicts = []) {
  const error = new Error(message);
  error.code = code;
  // Relative paths are available to the local operator, never public status.
  if (conflicts.length) error.conflicts = conflicts;
  throw error;
}

function inside(left, right) {
  const relative = path.relative(left, right);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function safePath(input, { missing = false } = {}) {
  if (typeof input !== 'string' || !input.trim()) fail('REPLICA_PATH_REQUIRED', 'A replica path is required.');
  const absolute = path.resolve(input);
  let cursor = path.parse(absolute).root;
  for (const component of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = await fsp.lstat(cursor).catch((error) => {
      if (missing && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) fail('REPLICA_SYMLINK', 'Replica paths must not contain symbolic links.');
  }
  return absolute;
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readFileRecord(filename, destination, signal) {
  signal?.throwIfAborted?.();
  const before = await fsp.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) fail('REPLICA_SPECIAL_FILE', 'Only ordinary files can be copied.');
  const input = await fsp.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let output;
  try {
    if (!sameStat(before, await input.stat())) fail('REPLICA_SOURCE_CHANGED', 'A file changed while being opened.');
    if (destination) output = await fsp.open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      signal?.throwIfAborted?.();
      const read = await input.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      bytes += chunk.length;
      if (output) {
        let offset = 0;
        while (offset < chunk.length) {
          const written = await output.write(chunk, offset, chunk.length - offset);
          if (!written.bytesWritten) fail('REPLICA_WRITE_FAILED', 'A staged file could not be written.');
          offset += written.bytesWritten;
        }
      }
    }
    if (!sameStat(before, await input.stat()) || !sameStat(before, await fsp.lstat(filename)) || bytes !== before.size) {
      fail('REPLICA_SOURCE_CHANGED', 'A file changed during the copy; no replica was published.');
    }
    if (output) {
      await output.sync();
      await output.utimes(before.atimeMs / 1_000, before.mtimeMs / 1_000);
    }
    return { hash: hash.digest('hex'), bytes, mtimeMs: before.mtimeMs };
  } finally {
    await input.close();
    await output?.close();
  }
}

async function inventory(root, { destination, signal } = {}) {
  const files = Object.create(null);
  const directories = [];
  async function walk(relative = '') {
    signal?.throwIfAborted?.();
    const source = path.join(root, relative);
    const before = await fsp.lstat(source);
    if (!before.isDirectory() || before.isSymbolicLink()) fail('REPLICA_SYMLINK', 'Replica directories must be ordinary directories.');
    if (relative) directories.push(relative.split(path.sep).join('/'));
    const entries = await fsp.readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) fail('REPLICA_SYMLINK', 'A symbolic link was found; no replica was published.');
      if (entry.isDirectory()) {
        if (destination) await fsp.mkdir(path.join(destination, child), { mode: 0o700 });
        await walk(child);
      } else if (entry.isFile()) {
        files[child.split(path.sep).join('/')] = await readFileRecord(
          path.join(root, child), destination ? path.join(destination, child) : null, signal,
        );
      } else fail('REPLICA_SPECIAL_FILE', 'A special file was found; no replica was published.');
    }
    if (!sameStat(before, await fsp.lstat(source))) fail('REPLICA_SOURCE_CHANGED', 'A directory changed during the scan.');
  }
  await walk();
  return { files, directories: directories.sort() };
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify({
    directories: [...value.directories].sort(),
    files: Object.entries(value.files).sort(([left], [right]) => left.localeCompare(right)),
  })).digest('hex');
}

function contentDifferences(previous, current) {
  const paths = new Set([...Object.keys(previous.files), ...Object.keys(current.files)]);
  return [...paths].filter((relative) => previous.files[relative]?.hash !== current.files[relative]?.hash).sort();
}

async function readManifest(stateDir) {
  const filename = path.join(stateDir, MANIFEST);
  await safePath(filename, { missing: true });
  const raw = await fsp.readFile(filename, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); } catch { fail('REPLICA_MANIFEST_INVALID', 'The replica manifest is invalid.'); }
  if (value?.format !== FORMAT || !HASH.test(value.version || '') || !value.files ||
      typeof value.files !== 'object' || Array.isArray(value.files) || !Array.isArray(value.directories) ||
      typeof value.sourceRoot !== 'string' || typeof value.targetRoot !== 'string' ||
      Object.values(value.files).some((item) => !HASH.test(item?.hash || ''))) {
    fail('REPLICA_MANIFEST_INVALID', 'The replica manifest is invalid.');
  }
  return value;
}

function publicStatus(value) {
  return {
    configured: Boolean(value),
    mode: 'manual-replica',
    status: value ? 'ready' : 'unconfigured',
    version: value?.version || '',
    lastSuccessfulSyncAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value?.lastSuccessfulSyncAt || '')
      ? value.lastSuccessfulSyncAt : null,
    files: value ? Object.keys(value.files).length : 0,
    indexPending: value?.indexPending === true,
    indexGeneration: /^[A-Za-z0-9_-]{1,160}$/u.test(value?.indexGeneration || '') ? value.indexGeneration : '',
  };
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    await fsp.rename(temporary, filename);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function lockState(stateDir, operation) {
  const directory = await safePath(stateDir, { missing: true });
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = await fsp.lstat(path.join(directory, 'vault-replica-pending.json')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (pending) fail('REPLICA_RECOVERY_REQUIRED', 'An interrupted publication must be recovered before another operation.');
  const lock = path.join(directory, 'vault-replica.lock');
  let handle;
  try { handle = await fsp.open(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') fail('REPLICA_LOCKED', 'Another replica operation is active, or a previous operation needs recovery.');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await operation(directory);
  } finally {
    await handle.close();
    await fsp.rm(lock, { force: true });
  }
}

/** Read-only public status; never returns source paths, note paths, or content. */
export async function inspectVaultReplica({ stateDir, targetRoot } = {}) {
  const directory = await safePath(stateDir, { missing: true });
  const manifest = await readManifest(directory);
  // A globally configured replica-state directory must never make another
  // knowledge base inherit this copy's timestamp or indexing status.
  if (targetRoot !== undefined && manifest) {
    const target = await safePath(targetRoot, { missing: true });
    if (path.resolve(manifest.targetRoot) !== target) return publicStatus(null);
  }
  const status = publicStatus(manifest);
  const pending = await fsp.lstat(path.join(directory, 'vault-replica-pending.json')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (pending) return { ...status, status: 'recovery-required', indexPending: true };
  return status;
}

/**
 * Offline, manually invoked source-to-copy publication. Stop every target
 * writer first. Neither the source nor an unrelated benchmark is modified.
 * Divergence aborts the whole update instead of discarding local work.
 */
export async function syncVaultReplica({ sourceRoot, targetRoot, stateDir, signal } = {}) {
  const source = await safePath(sourceRoot);
  const target = await safePath(targetRoot, { missing: true });
  const state = await safePath(stateDir, { missing: true });
  for (const [left, right] of [[source, target], [source, state], [target, state]]) {
    if (inside(left, right) || inside(right, left)) fail('REPLICA_PATH_OVERLAP', 'Source, target and replica state must be separate trees.');
  }
  const parent = path.dirname(target);
  await safePath(parent);
  return lockState(state, async (directory) => {
    const previous = await readManifest(directory);
    if (previous && (previous.sourceRoot !== source || previous.targetRoot !== target)) {
      fail('REPLICA_BINDING_MISMATCH', 'The replica manifest belongs to different roots.');
    }
    const existing = await fsp.lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && !previous) fail('REPLICA_TARGET_EXISTS', 'Initial publication requires a new target directory.');
    if (previous && !existing) fail('REPLICA_TARGET_MISSING', 'The existing replica is missing; recover it before updating.');
    if (existing && !existing.isDirectory()) fail('REPLICA_TARGET_INVALID', 'The replica target must be a directory.');
    let targetInventory = previous ? await inventory(target, { signal }) : null;
    const conflicts = previous ? contentDifferences(previous, targetInventory) : [];
    if (previous && JSON.stringify(previous.directories) !== JSON.stringify(targetInventory.directories)) conflicts.push('[directories]');
    if (conflicts.length) fail('REPLICA_LOCAL_CONFLICT', 'The copy contains local changes. Preserve or resolve them before updating.', conflicts);

    const stage = await fsp.mkdtemp(path.join(parent, `.${path.basename(target)}.replica-stage-`));
    const recovery = path.join(parent, `.${path.basename(target)}.replica-recovery-${randomUUID()}`);
    const journal = path.join(directory, 'vault-replica-pending.json');
    let movedOld = false;
    let published = false;
    let committed = false;
    try {
      const copied = await inventory(source, { destination: stage, signal });
      const verified = await inventory(source, { signal });
      const staged = await inventory(stage, { signal });
      if (fingerprint(copied) !== fingerprint(verified) || contentDifferences(copied, staged).length ||
          JSON.stringify(copied.directories) !== JSON.stringify(staged.directories)) {
        fail('REPLICA_SOURCE_CHANGED', 'The source did not remain stable, or staged verification failed.');
      }
      if (previous) {
        const checkedTarget = await inventory(target, { signal });
        if (fingerprint(targetInventory) !== fingerprint(checkedTarget)) {
          fail('REPLICA_LOCAL_CONFLICT', 'The copy changed during staging; no update was published.');
        }
      }
      signal?.throwIfAborted?.();
      const version = fingerprint(copied);
      const changedPaths = previous ? contentDifferences(previous, copied) : Object.keys(copied.files);
      const value = {
        format: FORMAT, sourceRoot: source, targetRoot: target, ...copied, version,
        lastSuccessfulSyncAt: new Date().toISOString(),
        indexPending: previous?.version === version ? previous.indexPending : true,
        indexGeneration: previous?.version === version ? previous.indexGeneration || '' : '',
      };
      // The private journal and recovery directory survive an abrupt process
      // stop. A subsequent invocation refuses to run until recovery is checked.
      await atomicJson(journal, { format: FORMAT, sourceRoot: source, targetRoot: target, stage, recovery, previous, next: value });
      if (existing) { await fsp.rename(target, recovery); movedOld = true; }
      await fsp.rename(stage, target);
      published = true;
      await atomicJson(path.join(directory, MANIFEST), value);
      committed = true;
      await fsp.rm(journal, { force: true });
      return { status: publicStatus(value), changedPaths, conflicts: [], recoveryAvailable: movedOld };
    } catch (error) {
      if (!committed) {
        if (published) await fsp.rename(target, stage);
        if (movedOld) await fsp.rename(recovery, target);
        await fsp.rm(journal, { force: true });
      }
      throw error;
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/** Acknowledge an index built against this exact published replica version. */
export async function markVaultReplicaIndexed({ stateDir, expectedVersion, generation } = {}) {
  if (!HASH.test(expectedVersion || '') || !/^[A-Za-z0-9_-]{1,160}$/u.test(generation || '')) {
    fail('REPLICA_INDEX_ACK_INVALID', 'A replica version and index generation are required.');
  }
  return lockState(stateDir, async (directory) => {
    const value = await readManifest(directory);
    if (!value || value.version !== expectedVersion) fail('REPLICA_VERSION_CONFLICT', 'The replica changed before its index was acknowledged.');
    value.indexPending = false;
    value.indexGeneration = generation;
    await atomicJson(path.join(directory, MANIFEST), value);
    return publicStatus(value);
  });
}
