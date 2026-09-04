import { randomUUID } from 'node:crypto';

const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,80}$/;

export class IndexRouterError extends Error {
  constructor(message, code, status = 500) {
    super(message);
    this.name = 'IndexRouterError';
    this.code = code;
    this.status = status;
  }
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function safeCode(error, fallback = 'INDEX_REBUILD_FAILED') {
  const value = String(error?.code || '').toUpperCase();
  return SAFE_CODE_PATTERN.test(value) ? value : fallback;
}

function assertRevision(value) {
  const revision = String(value || '').trim();
  if (!REVISION_PATTERN.test(revision)) {
    throw new IndexRouterError(
      'Index configuration revision is invalid.',
      'INDEX_REVISION_INVALID',
      400,
    );
  }
  return revision;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Return the only embedding fields that may be shown outside the server.
 * In particular, endpoint/apiBase/apiKey and arbitrary provider errors are
 * deliberately omitted.
 */
export function publicEmbeddingDescriptor(configInput = {}) {
  const config = configInput?.embedding && typeof configInput.embedding === 'object'
    ? configInput.embedding
    : configInput;
  const provider = String(config?.provider || 'disabled').trim().toLowerCase();
  const enabled = provider !== 'disabled';
  return {
    provider,
    model: enabled ? String(config?.model || '').trim() || null : null,
    dimensions: enabled ? positiveInteger(config?.dimensions) : null,
  };
}

function publicIndexStatus(index) {
  let status = {};
  try {
    status = index?.status?.() || {};
  } catch {}
  const embedding = publicEmbeddingDescriptor(status.embedding || {});
  return {
    available: status.available === true,
    generation: String(status.generation || 'unbuilt').slice(0, 160),
    previousGeneration: status.previousGeneration
      ? String(status.previousGeneration).slice(0, 160)
      : null,
    createdAt: status.createdAt ? String(status.createdAt).slice(0, 40) : null,
    files: Math.max(0, Number(status.files) || 0),
    chunks: Math.max(0, Number(status.chunks) || 0),
    embeddedChunks: Math.max(0, Number(status.embeddedChunks) || 0),
    lexicalAvailable: status.lexicalAvailable === true,
    semanticAvailable: status.semanticAvailable === true,
    embedding,
    watchEnabled: status.watchEnabled === true,
    lastReconciledAt: status.lastReconciledAt
      ? String(status.lastReconciledAt).slice(0, 40)
      : null,
    lastError: status.lastError
      ? { code: safeCode(status.lastError, 'KNOWLEDGE_INDEX_ERROR') }
      : null,
  };
}

function publicProgress(value = {}) {
  const completed = Math.max(0, Number(value.completed) || 0);
  const total = Math.max(0, Number(value.total) || 0);
  return {
    phase: String(value.phase || 'building').slice(0, 40),
    completed,
    total,
    ...(total > 0 ? { percent: Math.min(100, Math.floor((completed / total) * 100)) } : {}),
  };
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    revision: job.revision,
    status: job.status,
    phase: job.phase,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    embedding: { ...job.embedding },
    progress: { ...job.progress },
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.generation ? { generation: job.generation } : {}),
  };
}

function asCandidate(value) {
  const index = value?.index || value;
  if (!index || typeof index.search !== 'function' || typeof index.status !== 'function') {
    throw new IndexRouterError(
      'Index factory returned an invalid candidate.',
      'INDEX_CANDIDATE_INVALID',
    );
  }
  return index;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new IndexRouterError(
    'Index rebuild was cancelled.',
    'INDEX_REBUILD_CANCELLED',
    409,
  );
  error.name = 'AbortError';
  throw error;
}

function relayAbort(source, controller) {
  if (!source) return () => {};
  const abort = () => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

function slotFor(index, revision, slotId) {
  return {
    index,
    revision,
    slotId,
    references: 0,
    retiring: false,
    disposePromise: null,
    releaseWaiters: [],
  };
}

/**
 * Coordinates an online embedding-index replacement without exposing secrets.
 *
 * The factory must build candidates in a different index directory/slot from
 * the active KnowledgeIndex. commitActive must atomically persist a pointer to
 * that slot; it intentionally receives no provider URL or API key. On restart,
 * the caller should resolve that pointer against a private, versioned embedding
 * profile and construct the selected KnowledgeIndex with autoBuild:false.
 */
export class IndexRouter {
  constructor(options = {}) {
    if (!options.activeIndex || typeof options.activeIndex.search !== 'function') {
      throw new TypeError('IndexRouter requires an active index.');
    }
    if (typeof options.createCandidate !== 'function') {
      throw new TypeError('IndexRouter requires createCandidate.');
    }
    this.createCandidate = options.createCandidate;
    this.commitActive = options.commitActive || (async () => {});
    this.validateCandidate = options.validateCandidate || null;
    this.closeIndex = options.closeIndex || (async (index) => index?.close?.());
    this.discardCandidate = options.discardCandidate || (async () => {});
    this.now = options.now || Date.now;
    this.makeId = options.makeId || randomUUID;
    this.requireSemantic = options.requireSemantic !== false;
    this._active = slotFor(
      options.activeIndex,
      assertRevision(options.activeRevision || 'initial'),
      String(options.activeSlotId || 'initial'),
    );
    this._pending = null;
    this._lastAttempt = null;
    this._retired = new Set();
    this._closed = false;
    this._closePromise = null;
    this.ready = Promise.resolve(options.activeIndex.ready).then(() => this);
  }

  get policy() {
    return this._active.index.policy;
  }

  get activeRevision() {
    return this._active.revision;
  }

  assertOpen() {
    if (this._closed) {
      throw new IndexRouterError('Index router is closed.', 'INDEX_ROUTER_CLOSED', 503);
    }
  }

  status() {
    const activeStatus = publicIndexStatus(this._active.index);
    return {
      state: this._closed ? 'closed' : this._pending ? 'rebuilding' : 'ready',
      active: {
        revision: this._active.revision,
        ...activeStatus,
      },
      pending: publicJob(this._pending),
      lastAttempt: publicJob(this._lastAttempt),
      // Mirror KnowledgeIndex.status() so the router is a drop-in dependency
      // for the current TaskManager and readiness endpoint.
      ...activeStatus,
      configRevision: this._active.revision,
    };
  }

  acquireSnapshot() {
    this.assertOpen();
    const slot = this._active;
    slot.references += 1;
    let indexSnapshot = null;
    try {
      indexSnapshot = typeof slot.index.acquireSnapshot === 'function'
        ? slot.index.acquireSnapshot()
        : null;
    } catch (error) {
      slot.references = Math.max(0, slot.references - 1);
      if (slot.references === 0) {
        for (const resolve of slot.releaseWaiters.splice(0)) resolve();
        if (slot.retiring) this._disposeRetired(slot);
      }
      throw error;
    }
    const pinnedIndex = indexSnapshot || slot.index;
    let released = false;
    const assertHeld = () => {
      if (released) {
        throw new IndexRouterError(
          'Index snapshot has already been released.',
          'INDEX_SNAPSHOT_RELEASED',
          409,
        );
      }
    };
    return Object.freeze({
      revision: slot.revision,
      generation: indexSnapshot?.generation || null,
      status: () => {
        assertHeld();
        return publicIndexStatus(pinnedIndex);
      },
      search: (...args) => {
        assertHeld();
        return pinnedIndex.search(...args);
      },
      temporalInventory: (...args) => {
        assertHeld();
        if (typeof pinnedIndex.temporalInventory !== 'function') {
          throw new IndexRouterError(
            'The active index does not expose temporal file metadata.',
            'TEMPORAL_INVENTORY_UNAVAILABLE',
            503,
          );
        }
        return pinnedIndex.temporalInventory(...args);
      },
      release: () => {
        if (released) return;
        released = true;
        indexSnapshot?.release?.();
        slot.references = Math.max(0, slot.references - 1);
        if (slot.references === 0) {
          for (const resolve of slot.releaseWaiters.splice(0)) resolve();
          if (slot.retiring) this._disposeRetired(slot);
        }
      },
    });
  }

  async search(...args) {
    const snapshot = this.acquireSnapshot();
    try {
      return await snapshot.search(...args);
    } finally {
      snapshot.release();
    }
  }

  async temporalInventory(...args) {
    const snapshot = this.acquireSnapshot();
    try {
      return await snapshot.temporalInventory(...args);
    } finally {
      snapshot.release();
    }
  }

  async rebuild(options = {}) {
    const snapshot = this.acquireSnapshot();
    try {
      return await this._active.index.rebuild(options);
    } finally {
      snapshot.release();
    }
  }

  async updatePaths(paths) {
    this.assertOpen();
    const normalized = [...new Set((Array.isArray(paths) ? paths : []).map(String))];
    const pending = this._pending;
    if (pending && ['building', 'catching_up', 'validating'].includes(pending.phase)) {
      for (const item of normalized) pending.dirtyPaths.add(item);
    }
    if (pending && ['commit_barrier', 'switching'].includes(pending.phase)) {
      // The commit barrier deliberately makes a concurrent Vault write wait
      // for the new slot, then applies the path update to that active slot.
      await pending.promise;
      if (this._closed) return null;
      return this._active.index.updatePaths?.(normalized);
    }
    const slot = this._active;
    slot.references += 1;
    try {
      return await slot.index.updatePaths?.(normalized);
    } finally {
      slot.references = Math.max(0, slot.references - 1);
      if (slot.references === 0) {
        for (const resolve of slot.releaseWaiters.splice(0)) resolve();
        if (slot.retiring) this._disposeRetired(slot);
      }
    }
  }

  startRebuild(config, options = {}) {
    this.assertOpen();
    if (this._pending) {
      throw new IndexRouterError(
        'Another index rebuild is already running.',
        'INDEX_REBUILD_IN_PROGRESS',
        409,
      );
    }
    const revision = assertRevision(options.revision);
    if (revision === this._active.revision) {
      throw new IndexRouterError(
        'The requested index revision is already active.',
        'INDEX_REVISION_UNCHANGED',
        409,
      );
    }
    const controller = new AbortController();
    const removeExternalAbort = relayAbort(options.signal, controller);
    const job = {
      id: String(this.makeId()),
      slotId: String(this.makeId()),
      revision,
      embedding: publicEmbeddingDescriptor(config),
      status: 'running',
      phase: 'building',
      progress: publicProgress(),
      startedAt: isoNow(this.now),
      finishedAt: null,
      errorCode: null,
      generation: null,
      controller,
      removeExternalAbort,
      dirtyPaths: new Set(),
      candidate: null,
      promise: null,
    };
    this._pending = job;
    // _runRebuild always resolves to a public terminal job. Keeping failures
    // inside the lifecycle prevents an unobserved background rejection.
    job.promise = this._runRebuild(job, config);
    return publicJob(job);
  }

  waitForRebuild(id) {
    const jobId = String(id || '');
    if (this._pending?.id === jobId) return this._pending.promise;
    if (this._lastAttempt?.id === jobId) return Promise.resolve(publicJob(this._lastAttempt));
    throw new IndexRouterError('Index rebuild was not found.', 'INDEX_REBUILD_NOT_FOUND', 404);
  }

  cancelRebuild(id) {
    const job = this._pending;
    if (!job || (id && String(id) !== job.id)) return false;
    if (['commit_barrier', 'switching'].includes(job.phase)) return false;
    job.controller.abort(new DOMException('Index rebuild cancelled', 'AbortError'));
    return true;
  }

  async _drainDirtyPaths(job) {
    while (job.dirtyPaths.size > 0) {
      throwIfAborted(job.controller.signal);
      job.phase = 'catching_up';
      const paths = [...job.dirtyPaths];
      job.dirtyPaths.clear();
      await job.candidate.updatePaths?.(paths);
    }
  }

  async _validate(job) {
    throwIfAborted(job.controller.signal);
    const status = publicIndexStatus(job.candidate);
    if (!status.available) {
      throw new IndexRouterError(
        'Candidate index did not produce an available generation.',
        'INDEX_CANDIDATE_UNAVAILABLE',
      );
    }
    if (this.requireSemantic && status.chunks > 0 && !status.semanticAvailable) {
      throw new IndexRouterError(
        'Candidate index did not produce semantic vectors.',
        'INDEX_CANDIDATE_SEMANTIC_UNAVAILABLE',
      );
    }
    const expected = job.embedding;
    const actual = status.embedding;
    if (
      actual.provider !== expected.provider ||
      actual.model !== expected.model ||
      actual.dimensions !== expected.dimensions
    ) {
      throw new IndexRouterError(
        'Candidate index embedding signature does not match the requested configuration.',
        'INDEX_CANDIDATE_SIGNATURE_MISMATCH',
      );
    }
    if (this.validateCandidate) {
      await this.validateCandidate(job.candidate, {
        revision: job.revision,
        slotId: job.slotId,
        status,
        signal: job.controller.signal,
      });
    }
    return status;
  }

  async _runRebuild(job, config) {
    let switched = false;
    try {
      throwIfAborted(job.controller.signal);
      const reportProgress = (value) => {
        if (this._pending === job && !job.controller.signal.aborted) {
          job.progress = publicProgress(value);
        }
      };
      const candidateValue = await this.createCandidate({
        config,
        revision: job.revision,
        slotId: job.slotId,
        signal: job.controller.signal,
        reportProgress,
      });
      job.candidate = asCandidate(candidateValue);
      if (job.candidate === this._active.index) {
        throw new IndexRouterError(
          'Candidate index must use an independent slot.',
          'INDEX_CANDIDATE_NOT_ISOLATED',
        );
      }
      await Promise.resolve(job.candidate.ready);
      throwIfAborted(job.controller.signal);

      // Repeat validation if a Vault write arrived while the previous pass was
      // running. Setting commit_barrier is synchronous with the empty check, so
      // later writes wait for the switch and update the new active index.
      let candidateStatus;
      while (true) {
        await this._drainDirtyPaths(job);
        job.phase = 'validating';
        candidateStatus = await this._validate(job);
        if (job.dirtyPaths.size === 0) {
          job.phase = 'commit_barrier';
          break;
        }
      }

      // This callback is the durable linearization point. It receives only a
      // sanitized pointer payload and must atomically replace the active-slot
      // manifest. Cancellation is intentionally no longer accepted here.
      const commitPayload = {
        version: 1,
        slotId: job.slotId,
        revision: job.revision,
        generation: candidateStatus.generation,
        embedding: { ...candidateStatus.embedding },
        activatedAt: isoNow(this.now),
      };
      await this.commitActive(commitPayload);
      job.phase = 'switching';
      const previous = this._active;
      this._active = slotFor(job.candidate, job.revision, job.slotId);
      switched = true;
      job.candidate = null;
      job.generation = candidateStatus.generation;
      job.status = 'succeeded';
      this._retire(previous);
    } catch (error) {
      const cancelled = job.controller.signal.aborted || error?.name === 'AbortError';
      job.status = cancelled ? 'cancelled' : 'failed';
      job.errorCode = cancelled
        ? 'INDEX_REBUILD_CANCELLED'
        : safeCode(error);
    } finally {
      job.removeExternalAbort();
      if (!switched && job.candidate) {
        const candidate = job.candidate;
        job.candidate = null;
        await Promise.resolve(this.closeIndex(candidate, {
          role: 'candidate',
          reason: job.status,
          revision: job.revision,
          slotId: job.slotId,
        })).catch(() => {});
        await Promise.resolve(this.discardCandidate({
          index: candidate,
          revision: job.revision,
          slotId: job.slotId,
          reason: job.status,
        })).catch(() => {});
      }
      job.phase = job.status;
      job.finishedAt = isoNow(this.now);
      job.progress = publicProgress({
        ...job.progress,
        phase: job.phase,
      });
      this._lastAttempt = job;
      if (this._pending === job) this._pending = null;
    }
    return publicJob(job);
  }

  _retire(slot) {
    slot.retiring = true;
    this._retired.add(slot);
    if (slot.references === 0) this._disposeRetired(slot);
  }

  _disposeRetired(slot) {
    if (slot.disposePromise) return slot.disposePromise;
    slot.disposePromise = Promise.resolve(this.closeIndex(slot.index, {
      role: 'retired',
      reason: 'replaced',
      revision: slot.revision,
      slotId: slot.slotId,
    })).catch(() => {}).finally(() => {
      this._retired.delete(slot);
    });
    return slot.disposePromise;
  }

  async waitForIdle() {
    const pending = this._pending?.promise;
    if (pending) await pending;
    await Promise.all([...this._retired].map((slot) => {
      if (slot.references === 0) return this._disposeRetired(slot);
      return new Promise((resolve) => slot.releaseWaiters.push(resolve))
        .then(() => this._disposeRetired(slot));
    }));
  }

  async close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;
    this._closePromise = (async () => {
      const pending = this._pending;
      if (pending && !['commit_barrier', 'switching'].includes(pending.phase)) {
        pending.controller.abort(new DOMException('Index router closing', 'AbortError'));
      }
      if (pending) await pending.promise;
      const active = this._active;
      this._retire(active);
      await this.waitForIdle();
    })();
    return this._closePromise;
  }
}

export const indexRouterInternals = {
  publicIndexStatus,
  publicJob,
  safeCode,
};
