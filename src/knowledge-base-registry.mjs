import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { markPublicMessage } from './public-errors.mjs';

const REGISTRY_VERSION = 1;
const BINDING_VERSION = 1;
const KNOWLEDGE_BASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MOUNT_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const ROOT_BINDING = /^[a-f0-9]{64}$/u;

export class KnowledgeBaseRegistryError extends Error {
  constructor(message, code = 'KNOWLEDGE_BASE_REGISTRY_ERROR', status = 500, cause) {
    super(message, { cause });
    this.name = 'KnowledgeBaseRegistryError';
    this.code = code;
    this.status = status;
    markPublicMessage(this);
  }
}

function fail(message, code, status = 400, cause) {
  throw new KnowledgeBaseRegistryError(message, code, status, cause);
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedText(value, label, maximum, { required = true } = {}) {
  const output = String(value ?? '').trim();
  if (required && !output) fail(`${label} is required.`, 'INVALID_KNOWLEDGE_BASE_CONFIG');
  if (output.length > maximum) fail(`${label} is too long.`, 'INVALID_KNOWLEDGE_BASE_CONFIG');
  if(/[\u0000-\u001f\u007f]/u.test(output)) {
    fail(`${label} contains control characters.`, 'INVALID_KNOWLEDGE_BASE_CONFIG');
  }
  return output;
}

function stableId(value, label = 'knowledgeBaseId') {
  const output = boundedText(value, label, 64).toLowerCase();
  if (!KNOWLEDGE_BASE_ID.test(output)) {
    fail(`${label} is invalid.`, 'INVALID_KNOWLEDGE_BASE_ID');
  }
  return output;
}

function mountId(value) {
  const output = boundedText(value, 'mountId', 32).toLowerCase();
  if (!MOUNT_ID.test(output)) fail('mountId is invalid.', 'INVALID_KNOWLEDGE_BASE_MOUNT');
  return output;
}

function insideOrEqual(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function overlaps(left, right) {
  return insideOrEqual(left, right) || insideOrEqual(right, left);
}

function relativeVaultPath(value) {
  const raw = boundedText(value ?? '.', 'relativePath', 1_024).replaceAll('\\', '/');
  if (raw === '.' || raw === './') return '.';
  if (raw.startsWith('/') || /^[A-Za-z]:\//u.test(raw)) {
    fail('relativePath must be relative to an allowed mount.', 'KNOWLEDGE_BASE_PATH_OUTSIDE_MOUNT');
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail('relativePath is invalid.', 'KNOWLEDGE_BASE_PATH_OUTSIDE_MOUNT');
  }
  return normalized;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function canonicalExistingDirectory(input, label) {
  const resolved = path.resolve(String(input || ''));
  let stat;
  let real;
  try {
    stat = await fsp.lstat(resolved);
    real = await fsp.realpath(resolved);
  } catch (error) {
    fail(`${label} is unavailable.`, 'KNOWLEDGE_BASE_PATH_UNAVAILABLE', 400, error);
  }
  if (stat.isSymbolicLink() || real !== resolved) {
    fail(`${label} cannot contain a symbolic-link traversal.`, 'KNOWLEDGE_BASE_PATH_SYMLINK');
  }
  if (!stat.isDirectory()) fail(`${label} must be a directory.`, 'KNOWLEDGE_BASE_PATH_NOT_DIRECTORY');
  await fsp.access(real, fs.constants.R_OK);
  return real;
}

async function isActualDirectory(filename) {
  const stat = await fsp.lstat(filename).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

async function hasImmediateVault(rootPath) {
  if (await isActualDirectory(path.join(rootPath, '.obsidian'))) return true;
  const children = await fsp.readdir(rootPath, { withFileTypes: true });
  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink?.()) continue;
    if (await isActualDirectory(path.join(rootPath, child.name, '.obsidian'))) return true;
  }
  return false;
}

async function canonicalPotential(input) {
  let current = path.resolve(String(input || ''));
  const suffix = [];
  while (true) {
    try {
      const real = await fsp.realpath(current);
      return path.resolve(real, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(String(input || ''));
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function statePaths(stateRoot) {
  return Object.freeze({
    dataDir: stateRoot,
    indexDir: path.join(stateRoot, 'index'),
    draftDir: path.join(stateRoot, 'drafts'),
    recoveryDir: path.join(stateRoot, 'recovery'),
    conversationFile: path.join(stateRoot, 'conversations.json'),
    auditFile: path.join(stateRoot, 'audit.jsonl'),
    embeddingProfileFile: path.join(stateRoot, 'embedding-active.json'),
    embeddingSlotsRoot: path.join(stateRoot, 'embedding-slots'),
  });
}

function managedStateRoot(stateDir, knowledgeBaseId, rootPath) {
  const binding = digest({ knowledgeBaseId, rootPath }).slice(0, 16);
  return path.join(stateDir, 'knowledge-bases', `${knowledgeBaseId}-${binding}`);
}

function rootBinding(rootPath) {
  return digest({ rootPath: path.resolve(rootPath) });
}

function bindingDocument(bindings) {
  return {
    version: BINDING_VERSION,
    bindings: [...bindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([knowledgeBaseId, rootDigest]) => ({ knowledgeBaseId, rootDigest })),
  };
}

function legacyStatePaths(legacy, fallbackRoot) {
  return Object.freeze({
    dataDir: path.resolve(legacy.dataDir || fallbackRoot),
    indexDir: path.resolve(legacy.indexDir || path.join(fallbackRoot, 'index')),
    draftDir: path.resolve(legacy.draftDir || path.join(fallbackRoot, 'drafts')),
    recoveryDir: path.resolve(legacy.recoveryDir || path.join(fallbackRoot, 'recovery')),
    conversationFile: path.resolve(legacy.conversationFile || path.join(fallbackRoot, 'conversations.json')),
    auditFile: path.resolve(legacy.auditFile || path.join(fallbackRoot, 'audit.jsonl')),
    embeddingProfileFile: path.resolve(
      legacy.embeddingProfileFile || path.join(fallbackRoot, 'embedding-active.json'),
    ),
    embeddingSlotsRoot: path.resolve(
      legacy.embeddingSlotsRoot || path.join(fallbackRoot, 'embedding-slots'),
    ),
  });
}

async function ensurePrivateParent(filename) {
  const parent = path.dirname(filename);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('Knowledge-base registry parent is unsafe.', 'UNSAFE_KNOWLEDGE_BASE_REGISTRY_PATH', 500);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    await fsp.chmod(parent, 0o700);
  }
}

async function readPrivateJson(filename, { optional = false } = {}) {
  let stat;
  try {
    stat = await fsp.lstat(filename);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('Knowledge-base registry file is unsafe.', 'UNSAFE_KNOWLEDGE_BASE_REGISTRY_PATH', 500);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail('Knowledge-base registry file permissions are too broad.', 'UNSAFE_KNOWLEDGE_BASE_REGISTRY_MODE', 500);
  }
  const raw = await fsp.readFile(filename, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail('Knowledge-base registry is malformed.', 'INVALID_KNOWLEDGE_BASE_REGISTRY', 500, error);
  }
  return { value, digest: digest(value) };
}

async function atomicPrivateJson(filename, value, { backup = true } = {}) {
  await ensurePrivateParent(filename);
  const previous = `${filename}.previous`;
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  if (backup) {
    const current = await readPrivateJson(filename, { optional: true });
    if (current) {
      const backupTemporary = `${previous}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(backupTemporary, `${JSON.stringify(current.value, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      await fsp.rename(backupTemporary, previous);
    }
  }
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fsp.rename(temporary, filename);
  const handle = await fsp.open(path.dirname(filename), 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function publicEntry(entry) {
  return Object.freeze({
    knowledgeBaseId: entry.knowledgeBaseId,
    name: entry.name,
    enabled: entry.enabled,
    default: entry.default,
    revision: entry.revision,
  });
}

function publicSnapshot(snapshot) {
  return Object.freeze({
    version: snapshot.version,
    revision: snapshot.revision,
    stale: snapshot.stale === true,
    source: snapshot.source,
    defaultKnowledgeBaseId: snapshot.defaultKnowledgeBaseId,
    knowledgeBases: Object.freeze(snapshot.knowledgeBases.map(publicEntry)),
    allowedMounts: Object.freeze(snapshot.allowedMounts.map(({ id, label }) => Object.freeze({ id, label }))),
  });
}

function administrativeSnapshot(snapshot) {
  return Object.freeze({
    ...publicSnapshot(snapshot),
    knowledgeBases: Object.freeze(snapshot.knowledgeBases.map((entry) => Object.freeze({
      ...publicEntry(entry),
      mountId: entry.mountId,
      relativePath: entry.relativePath,
      pathAvailable: !entry.unavailableCode,
      ...(entry.unavailableCode ? { errorCode: entry.unavailableCode } : {}),
    }))),
  });
}

function registryDocument(entries, revision = crypto.randomUUID()) {
  return {
    version: REGISTRY_VERSION,
    revision,
    updatedAt: new Date().toISOString(),
    knowledgeBases: entries.map((entry) => ({
      knowledgeBaseId: entry.knowledgeBaseId,
      name: entry.name,
      mountId: entry.mountId,
      relativePath: entry.relativePath,
      enabled: entry.enabled,
      default: entry.default,
      legacyState: entry.legacyState === true,
    })),
  };
}

export class KnowledgeBaseRegistry {
  constructor(options = {}) {
    if (!plainObject(options)) fail('Registry options are invalid.', 'INVALID_KNOWLEDGE_BASE_CONFIG');
    if (!path.isAbsolute(String(options.managedFile || ''))) {
      fail('Knowledge-base registry requires an absolute managedFile.',
        'UNSAFE_KNOWLEDGE_BASE_REGISTRY_PATH', 500);
    }
    if (!path.isAbsolute(String(options.stateDir || ''))) {
      fail('Knowledge-base registry requires an absolute stateDir.',
        'UNSAFE_KNOWLEDGE_BASE_REGISTRY_PATH', 500);
    }
    this.managedFile = path.resolve(options.managedFile);
    this.previousFile = `${this.managedFile}.previous`;
    this.bindingFile = `${this.managedFile}.bindings`;
    this.stateDir = path.resolve(options.stateDir);
    this.legacy = plainObject(options.legacy) ? { ...options.legacy } : null;
    this.mountInputs = Array.isArray(options.allowedRoots) ? options.allowedRoots.slice() : [];
    this.privateStateInputs = Array.isArray(options.privateStatePaths)
      ? options.privateStatePaths.slice()
      : [this.stateDir, this.managedFile, this.previousFile, this.bindingFile];
    this.mounts = [];
    this.privateStatePaths = [];
    this.current = null;
    this.lastDigest = '';
    this.bindings = new Map();
    this.operationChain = Promise.resolve();
    this.ready = this.#enqueue(() => this.#loadInitial());
  }

  #enqueue(callback) {
    const operation = this.operationChain.then(callback, callback);
    this.operationChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #prepareBoundaries() {
    const inputs = this.mountInputs.length ? this.mountInputs : (
      this.legacy?.vaultPath
        ? [{ id: 'legacy', label: this.legacy.name || 'Default knowledge base', path: this.legacy.vaultPath }]
        : []
    );
    if (!inputs.length) fail('At least one allowed Vault mount is required.',
      'KNOWLEDGE_BASE_MOUNT_REQUIRED', 500);
    const mounts = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const raw = plainObject(inputs[index]) ? inputs[index] : { path: inputs[index] };
      const id = mountId(raw.id || `mount-${index + 1}`);
      if (mounts.some((entry) => entry.id === id)) {
        fail('Allowed mount IDs must be unique.', 'DUPLICATE_KNOWLEDGE_BASE_MOUNT', 500);
      }
      const rootPath = await canonicalExistingDirectory(raw.path, `Allowed mount ${id}`);
      if (mounts.some((entry) => overlaps(entry.rootPath, rootPath))) {
        fail('Allowed mounts cannot overlap.', 'NESTED_KNOWLEDGE_BASE_MOUNT', 500);
      }
      mounts.push(Object.freeze({
        id,
        label: boundedText(raw.label || `Vault mount ${index + 1}`, 'mount label', 120),
        rootPath,
      }));
    }
    const privateStatePaths = [];
    for (const input of this.privateStateInputs) {
      if (!input) continue;
      privateStatePaths.push(await canonicalPotential(input));
    }
    for (const mount of mounts) {
      if (privateStatePaths.some((entry) => overlaps(mount.rootPath, entry))) {
        fail('An allowed Vault mount overlaps private application state.',
          'KNOWLEDGE_BASE_STATE_OVERLAP', 500);
      }
    }
    this.mounts = mounts;
    this.privateStatePaths = privateStatePaths;
  }

  async #loadBindings() {
    const stored = await readPrivateJson(this.bindingFile, { optional: true });
    if (!stored) return;
    if (
      !plainObject(stored.value) ||
      stored.value.version !== BINDING_VERSION ||
      !Array.isArray(stored.value.bindings)
    ) {
      fail('Knowledge-base binding ledger is malformed.',
        'INVALID_KNOWLEDGE_BASE_BINDING_LEDGER', 500);
    }
    const bindings = new Map();
    for (const raw of stored.value.bindings) {
      if (!plainObject(raw)) {
        fail('Knowledge-base binding ledger is malformed.',
          'INVALID_KNOWLEDGE_BASE_BINDING_LEDGER', 500);
      }
      const id = stableId(raw.knowledgeBaseId);
      const rootDigest = String(raw.rootDigest || '').trim().toLowerCase();
      if (!ROOT_BINDING.test(rootDigest) || bindings.has(id)) {
        fail('Knowledge-base binding ledger is malformed.',
          'INVALID_KNOWLEDGE_BASE_BINDING_LEDGER', 500);
      }
      bindings.set(id, rootDigest);
    }
    this.bindings = bindings;
  }

  async #bindSnapshot(snapshot) {
    const next = new Map(this.bindings);
    let changed = false;
    for (const entry of snapshot.knowledgeBases) {
      const value = rootBinding(entry.rootPath);
      const existing = next.get(entry.knowledgeBaseId);
      if (existing && existing !== value) {
        fail(
          'A knowledgeBaseId is permanently bound to its first Vault. Add a new ID instead.',
          'KNOWLEDGE_BASE_ID_REBIND_FORBIDDEN',
          409,
        );
      }
      if (!existing) {
        next.set(entry.knowledgeBaseId, value);
        changed = true;
      }
    }
    if (changed) {
      // The ledger is committed first. A later registry-write failure can only
      // reserve an ID; it can never permit that ID to cross Vault boundaries.
      await atomicPrivateJson(this.bindingFile, bindingDocument(next), { backup: false });
      this.bindings = next;
    }
  }

  #legacyDocument() {
    if (!this.legacy?.vaultPath) return null;
    const root = path.resolve(this.legacy.vaultPath);
    const mount = this.mounts.find((entry) => insideOrEqual(entry.rootPath, root));
    if (!mount) fail('Legacy Vault is outside every allowed mount.',
      'KNOWLEDGE_BASE_PATH_OUTSIDE_MOUNT', 500);
    const relative = path.relative(mount.rootPath, root).split(path.sep).join('/') || '.';
    const entry = {
      knowledgeBaseId: stableId(this.legacy.knowledgeBaseId || 'default'),
      name: boundedText(this.legacy.name || this.legacy.vaultLabel || 'Default knowledge base',
        'legacy knowledge-base name', 120),
      mountId: mount.id,
      relativePath: relative,
      enabled: this.legacy.enabled !== false,
      default: true,
      legacyState: true,
    };
    return registryDocument([entry], `legacy-${digest(entry).slice(0, 24)}`);
  }

  async #normalizeDocument(input, source = 'managed', { allowUnavailable = false } = {}) {
    if (!plainObject(input) || input.version !== REGISTRY_VERSION || !Array.isArray(input.knowledgeBases)) {
      fail('Knowledge-base registry schema is invalid.', 'INVALID_KNOWLEDGE_BASE_REGISTRY', 500);
    }
    if (!input.knowledgeBases.length || input.knowledgeBases.length > 32) {
      fail('Knowledge-base registry must contain between 1 and 32 entries.',
        'INVALID_KNOWLEDGE_BASE_REGISTRY', 500);
    }
    const revision = boundedText(input.revision, 'registry revision', 120);
    const ids = new Set();
    const entries = [];
    for (const raw of input.knowledgeBases) {
      if (!plainObject(raw)) fail('Knowledge-base entry is invalid.', 'INVALID_KNOWLEDGE_BASE_CONFIG');
      const id = stableId(raw.knowledgeBaseId);
      if (ids.has(id)) fail('knowledgeBaseId values must be unique.', 'DUPLICATE_KNOWLEDGE_BASE_ID');
      ids.add(id);
      const selectedMount = this.mounts.find((entry) => entry.id === mountId(raw.mountId));
      if (!selectedMount) fail('Knowledge-base mount is not allowed.', 'KNOWLEDGE_BASE_MOUNT_NOT_ALLOWED');
      const relativePath = relativeVaultPath(raw.relativePath);
      const candidate = relativePath === '.'
        ? selectedMount.rootPath
        : path.resolve(selectedMount.rootPath, ...relativePath.split('/'));
      if (!insideOrEqual(selectedMount.rootPath, candidate)) {
        fail('Knowledge-base path escapes its allowed mount.', 'KNOWLEDGE_BASE_PATH_OUTSIDE_MOUNT');
      }
      let rootPath;
      let unavailableCode = '';
      try {
        rootPath = await canonicalExistingDirectory(candidate, `Knowledge base ${id}`);
      } catch (error) {
        if (!allowUnavailable || ![
          'KNOWLEDGE_BASE_PATH_UNAVAILABLE',
          'KNOWLEDGE_BASE_PATH_NOT_DIRECTORY',
          'KNOWLEDGE_BASE_PATH_SYMLINK',
        ].includes(error?.code)) throw error;
        rootPath = path.resolve(candidate);
        unavailableCode = error.code;
      }
      if (!insideOrEqual(selectedMount.rootPath, rootPath)) {
        fail('Knowledge-base path escapes its allowed mount.', 'KNOWLEDGE_BASE_PATH_OUTSIDE_MOUNT');
      }
      if (this.privateStatePaths.some((entry) => overlaps(rootPath, entry))) {
        fail('Knowledge-base path overlaps private application state.', 'KNOWLEDGE_BASE_STATE_OVERLAP');
      }
      if (entries.some((entry) => overlaps(entry.rootPath, rootPath))) {
        fail('Knowledge-base paths cannot be duplicated or nested.', 'NESTED_KNOWLEDGE_BASE_PATH');
      }
      if (!unavailableCode) {
        const directVault = await isActualDirectory(path.join(rootPath, '.obsidian'));
        const validLayout = directVault || (source === 'legacy' && await hasImmediateVault(rootPath));
        if (!validLayout) {
          if (allowUnavailable) unavailableCode = 'KNOWLEDGE_BASE_LAYOUT_INVALID';
          else {
            fail(
              source === 'legacy'
                ? 'The configured path must be an Obsidian Vault or an immediate Vault parent.'
                : 'A managed knowledge-base path must be an Obsidian Vault root.',
              'KNOWLEDGE_BASE_LAYOUT_INVALID',
            );
          }
        }
      }
      const legacyState = Boolean(this.legacy?.vaultPath) &&
        id === stableId(this.legacy?.knowledgeBaseId || 'default') &&
        rootPath === path.resolve(this.legacy.vaultPath);
      const paths = legacyState
        ? legacyStatePaths(this.legacy || {}, this.stateDir)
        : statePaths(managedStateRoot(this.stateDir, id, rootPath));
      entries.push(Object.freeze({
        knowledgeBaseId: id,
        name: boundedText(raw.name, 'knowledge-base name', 120),
        mountId: selectedMount.id,
        relativePath,
        rootPath,
        enabled: raw.enabled !== false,
        default: raw.default === true,
        legacyState,
        revision: digest({ id, rootPath, name: raw.name, enabled: raw.enabled !== false }).slice(0, 24),
        unavailableCode,
        state: paths,
      }));
    }
    const enabled = entries.filter((entry) => entry.enabled);
    if (!enabled.length) fail('At least one knowledge base must remain enabled.',
      'KNOWLEDGE_BASE_ENABLED_REQUIRED');
    const defaults = enabled.filter((entry) => entry.default);
    if (defaults.length !== 1 || entries.some((entry) => entry.default && !entry.enabled)) {
      fail('Exactly one enabled knowledge base must be the default.',
        'KNOWLEDGE_BASE_DEFAULT_REQUIRED');
    }
    return Object.freeze({
      version: REGISTRY_VERSION,
      revision,
      stale: false,
      source,
      defaultKnowledgeBaseId: defaults[0].knowledgeBaseId,
      knowledgeBases: Object.freeze(entries),
      allowedMounts: Object.freeze(this.mounts),
    });
  }

  async #candidate(filename, source) {
    const read = await readPrivateJson(filename, { optional: true });
    if (!read) return null;
    return {
      snapshot: await this.#normalizeDocument(read.value, source, { allowUnavailable: true }),
      digest: read.digest,
      value: read.value,
    };
  }

  async #loadInitial() {
    await this.#prepareBoundaries();
    await this.#loadBindings();
    try {
      const managed = await this.#candidate(this.managedFile, 'managed');
      if (managed) {
        await this.#bindSnapshot(managed.snapshot);
        this.current = managed.snapshot;
        this.lastDigest = managed.digest;
        return publicSnapshot(this.current);
      }
    } catch (currentError) {
      try {
        const previous = await this.#candidate(this.previousFile, 'previous');
        if (previous) {
          await this.#bindSnapshot(previous.snapshot);
          this.current = Object.freeze({ ...previous.snapshot, stale: true, source: 'previous' });
          this.lastDigest = previous.digest;
          return publicSnapshot(this.current);
        }
      } catch (previousError) {
        fail('Current and previous knowledge-base registries are invalid.',
          'KNOWLEDGE_BASE_REGISTRY_UNAVAILABLE', 500, previousError);
      }
      throw currentError;
    }
    const legacy = this.#legacyDocument();
    if (!legacy) fail('No knowledge base is configured.', 'KNOWLEDGE_BASE_REQUIRED', 500);
    this.current = await this.#normalizeDocument(legacy, 'legacy');
    await this.#bindSnapshot(this.current);
    this.lastDigest = '';
    return publicSnapshot(this.current);
  }

  async refresh() {
    return this.#enqueue(async () => {
      try {
        const candidate = await this.#candidate(this.managedFile, 'managed');
        if (!candidate) return publicSnapshot(this.current);
        if (candidate.digest !== this.lastDigest || this.current.source !== 'managed') {
          await this.#bindSnapshot(candidate.snapshot);
          this.current = candidate.snapshot;
          this.lastDigest = candidate.digest;
        }
      } catch (error) {
        if (!this.current) throw error;
        this.current = Object.freeze({ ...this.current, stale: true });
      }
      return publicSnapshot(this.current);
    });
  }

  runtimeSnapshot() {
    if (!this.current) fail('Knowledge-base registry is not ready.',
      'KNOWLEDGE_BASE_REGISTRY_NOT_READY', 503);
    return this.current;
  }

  publicSnapshot() {
    return publicSnapshot(this.runtimeSnapshot());
  }

  administrativeSnapshot() {
    return administrativeSnapshot(this.runtimeSnapshot());
  }

  resolve(id, { allowDisabled = false } = {}) {
    const requested = String(id || this.runtimeSnapshot().defaultKnowledgeBaseId).trim().toLowerCase();
    const entry = this.runtimeSnapshot().knowledgeBases.find((item) => item.knowledgeBaseId === requested);
    if (!entry) fail('Knowledge base was not found.', 'KNOWLEDGE_BASE_NOT_FOUND', 404);
    if (!allowDisabled && !entry.enabled) {
      fail('Knowledge base is disabled.', 'KNOWLEDGE_BASE_DISABLED', 409);
    }
    return entry;
  }

  async update(input, { expectedRevision } = {}) {
    return this.#enqueue(async () => {
      if (!plainObject(input)) fail('Knowledge-base update is invalid.', 'INVALID_KNOWLEDGE_BASE_CONFIG');
      if (this.runtimeSnapshot().stale === true) {
        fail('Knowledge-base registry is using a previous valid copy; restore the primary file before saving.',
          'KNOWLEDGE_BASE_REGISTRY_STALE', 409);
      }
      const suppliedRevision = boundedText(
        expectedRevision ?? input.expectedRevision,
        'expectedRevision',
        120,
      );
      if (suppliedRevision !== this.runtimeSnapshot().revision) {
        fail('Knowledge-base registry changed; reload before saving.',
          'KNOWLEDGE_BASE_REVISION_CONFLICT', 409);
      }
      const document = registryDocument(input.knowledgeBases || []);
      const candidate = await this.#normalizeDocument(document, 'managed');
      await this.#bindSnapshot(candidate);
      await atomicPrivateJson(this.managedFile, document);
      this.current = candidate;
      this.lastDigest = digest(document);
      return publicSnapshot(this.current);
    });
  }
}

export const knowledgeBaseRegistryInternals = Object.freeze({
  REGISTRY_VERSION,
  BINDING_VERSION,
  KNOWLEDGE_BASE_ID,
  insideOrEqual,
  overlaps,
  relativeVaultPath,
  canonicalPotential,
  isActualDirectory,
  hasImmediateVault,
  managedStateRoot,
  rootBinding,
  bindingDocument,
  readPrivateJson,
  atomicPrivateJson,
});
