import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IndexRouter,
  IndexRouterError,
  publicEmbeddingDescriptor,
} from '../src/index-router.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeIndex {
  constructor(name, options = {}) {
    this.name = name;
    this.policy = options.policy || { root: '/safe/vault' };
    this.ready = options.ready || Promise.resolve(this);
    this.available = options.available !== false;
    this.semanticAvailable = options.semanticAvailable !== false;
    this.embedding = options.embedding || {
      provider: 'dashscope',
      model: name,
      dimensions: 3,
    };
    this.chunks = options.chunks ?? 1;
    this.closed = 0;
    this.searchGate = options.searchGate || null;
    this.updatedPaths = [];
  }

  status() {
    return {
      available: this.available,
      generation: `generation-${this.name}`,
      previousGeneration: null,
      createdAt: '2026-09-02T00:00:00.000Z',
      files: this.chunks ? 1 : 0,
      chunks: this.chunks,
      embeddedChunks: this.semanticAvailable ? this.chunks : 0,
      lexicalAvailable: this.available,
      semanticAvailable: this.semanticAvailable,
      embedding: this.embedding,
      watchEnabled: false,
      lastReconciledAt: null,
      lastError: null,
    };
  }

  async search(query) {
    if (this.searchGate) await this.searchGate.promise;
    return { query, index: this.name };
  }

  async temporalInventory(query, options) {
    return { query, options, index: this.name };
  }

  async rebuild() {
    return this.status();
  }

  async updatePaths(paths) {
    this.updatedPaths.push([...paths]);
    return this.status();
  }

  async close() {
    this.closed += 1;
  }
}

function config(model, overrides = {}) {
  return {
    embedding: {
      provider: 'dashscope',
      model,
      dimensions: 3,
      apiBase: 'https://provider.invalid/secret-path',
      apiKey: 'sk-do-not-return-this',
      ...overrides,
    },
  };
}

function sequenceIds() {
  let id = 0;
  return () => `id-${++id}`;
}

test('successful rebuild commits a sanitized pointer then atomically routes new searches', async (t) => {
  const active = new FakeIndex('old');
  const candidate = new FakeIndex('new');
  const commits = [];
  let router;
  router = new IndexRouter({
    activeIndex: active,
    activeRevision: 'revision-old',
    activeSlotId: 'slot-old',
    makeId: sequenceIds(),
    createCandidate: async () => candidate,
    commitActive: async (payload) => {
      assert.equal((await router.search('during-commit')).index, 'old');
      assert.equal('apiKey' in payload, false);
      assert.equal('apiBase' in payload, false);
      commits.push(payload);
    },
  });
  t.after(() => router.close());

  const job = router.startRebuild(config('new'), { revision: 'revision-new' });
  const result = await router.waitForRebuild(job.id);

  assert.equal(result.status, 'succeeded');
  assert.equal((await router.search('after-switch')).index, 'new');
  assert.equal(router.status().active.revision, 'revision-new');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].generation, 'generation-new');
  await router.waitForIdle();
  assert.equal(active.closed, 1);
  assert.equal(candidate.closed, 0);
});

test('an in-flight search keeps the old snapshot alive until it completes', async (t) => {
  const gate = deferred();
  const active = new FakeIndex('old', { searchGate: gate });
  const candidate = new FakeIndex('new');
  const router = new IndexRouter({
    activeIndex: active,
    activeRevision: 'old-r1',
    makeId: sequenceIds(),
    createCandidate: async () => candidate,
  });
  t.after(() => router.close());

  const inFlight = router.search('held');
  await Promise.resolve();
  const job = router.startRebuild(config('new'), { revision: 'new-r2' });
  assert.equal((await router.waitForRebuild(job.id)).status, 'succeeded');
  assert.equal(active.closed, 0);
  assert.equal((await router.search('fresh')).index, 'new');

  gate.resolve();
  assert.equal((await inFlight).index, 'old');
  await router.waitForIdle();
  assert.equal(active.closed, 1);
});

test('a failed candidate remains private, is discarded, and leaves active search unchanged', async (t) => {
  const active = new FakeIndex('old');
  const candidate = new FakeIndex('new', { semanticAvailable: false });
  candidate.status = () => ({
    ...FakeIndex.prototype.status.call(candidate),
    lastError: {
      code: 'EMBEDDING_API_ERROR',
      message: 'provider rejected sk-do-not-return-this at https://private.invalid',
    },
  });
  const discarded = [];
  const router = new IndexRouter({
    activeIndex: active,
    activeRevision: 'old-r1',
    makeId: sequenceIds(),
    createCandidate: async () => candidate,
    discardCandidate: async (value) => discarded.push(value.slotId),
  });
  t.after(() => router.close());

  const job = router.startRebuild(config('new'), { revision: 'new-r2' });
  const result = await router.waitForRebuild(job.id);
  const serialized = JSON.stringify(router.status());

  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'INDEX_CANDIDATE_SEMANTIC_UNAVAILABLE');
  assert.equal((await router.search('still-active')).index, 'old');
  assert.equal(candidate.closed, 1);
  assert.deepEqual(discarded, ['id-2']);
  assert.equal(serialized.includes('sk-do-not-return-this'), false);
  assert.equal(serialized.includes('private.invalid'), false);
  assert.equal(serialized.includes('provider.invalid'), false);
});

test('only one rebuild runs at a time and cancellation keeps the old index', async (t) => {
  const active = new FakeIndex('old');
  const buildGate = deferred();
  const candidate = new FakeIndex('new', { ready: buildGate.promise });
  const router = new IndexRouter({
    activeIndex: active,
    activeRevision: 'old-r1',
    makeId: sequenceIds(),
    createCandidate: async () => candidate,
  });
  t.after(() => router.close());

  const job = router.startRebuild(config('new'), { revision: 'new-r2' });
  assert.throws(
    () => router.startRebuild(config('other'), { revision: 'other-r3' }),
    (error) => error instanceof IndexRouterError && error.code === 'INDEX_REBUILD_IN_PROGRESS',
  );
  assert.equal(router.cancelRebuild(job.id), true);
  buildGate.resolve(candidate);
  const result = await router.waitForRebuild(job.id);

  assert.equal(result.status, 'cancelled');
  assert.equal(result.errorCode, 'INDEX_REBUILD_CANCELLED');
  assert.equal((await router.search('old-remains')).index, 'old');
  assert.equal(candidate.closed, 1);
});

test('Vault path updates observed during a build are replayed before activation', async (t) => {
  const active = new FakeIndex('old');
  const buildGate = deferred();
  const candidate = new FakeIndex('new', { ready: buildGate.promise });
  const router = new IndexRouter({
    activeIndex: active,
    activeRevision: 'old-r1',
    makeId: sequenceIds(),
    createCandidate: async () => candidate,
  });
  t.after(() => router.close());

  const job = router.startRebuild(config('new'), { revision: 'new-r2' });
  await router.updatePaths(['notes/changed.md']);
  buildGate.resolve(candidate);
  assert.equal((await router.waitForRebuild(job.id)).status, 'succeeded');

  assert.deepEqual(active.updatedPaths, [['notes/changed.md']]);
  assert.deepEqual(candidate.updatedPaths, [['notes/changed.md']]);
});

test('explicit task snapshot can pin one index across multiple searches', async (t) => {
  const active = new FakeIndex('old');
  const candidate = new FakeIndex('new');
  const router = new IndexRouter({
    activeIndex: active,
    activeRevision: 'old-r1',
    makeId: sequenceIds(),
    createCandidate: async () => candidate,
  });
  t.after(() => router.close());

  const snapshot = router.acquireSnapshot();
  const job = router.startRebuild(config('new'), { revision: 'new-r2' });
  await router.waitForRebuild(job.id);

  assert.equal((await snapshot.search('task-second-query')).index, 'old');
  assert.equal((await snapshot.temporalInventory('task-time-query', {
    range: { startMs: 1, endMs: 2 },
  })).index, 'old');
  assert.equal((await router.search('new-task')).index, 'new');
  assert.equal(active.closed, 0);
  snapshot.release();
  await router.waitForIdle();
  assert.equal(active.closed, 1);
});

test('router task snapshot delegates to an index generation snapshot during same-slot updates', async (t) => {
  const active = new FakeIndex('mutable');
  let generation = 1;
  active.acquireSnapshot = () => {
    const pinned = generation;
    let released = false;
    const assertHeld = () => {
      if (released) throw new Error('released');
    };
    return {
      generation: `generation-${pinned}`,
      status: () => ({ ...active.status(), generation: `generation-${pinned}` }),
      search: async (query) => {
        assertHeld();
        return { query, generation: pinned };
      },
      temporalInventory: async (query, options) => {
        assertHeld();
        return { query, options, generation: pinned };
      },
      release: () => { released = true; },
    };
  };
  active.updatePaths = async (paths) => {
    active.updatedPaths.push([...paths]);
    generation += 1;
    return active.status();
  };
  active.search = async (query) => ({ query, generation });
  const router = new IndexRouter({
    activeIndex: active,
    activeRevision: 'same-slot-r1',
    createCandidate: async () => new FakeIndex('unused'),
  });
  t.after(() => router.close());

  const snapshot = router.acquireSnapshot();
  await router.updatePaths(['learning/changed.md']);
  assert.equal((await snapshot.search('pinned')).generation, 1);
  assert.equal((await snapshot.temporalInventory('pinned-time', {
    range: { startMs: 1, endMs: 2 },
  })).generation, 1);
  assert.equal((await router.search('live')).generation, 2);
  snapshot.release();
});

test('public descriptor and status never return endpoint or API key fields', async (t) => {
  assert.deepEqual(publicEmbeddingDescriptor(config('model-x')), {
    provider: 'dashscope',
    model: 'model-x',
    dimensions: 3,
  });
  const active = new FakeIndex('old');
  const router = new IndexRouter({
    activeIndex: active,
    activeRevision: 'old-r1',
    createCandidate: async () => new FakeIndex('new'),
  });
  t.after(() => router.close());
  const serialized = JSON.stringify(router.status());
  assert.equal(serialized.includes('apiKey'), false);
  assert.equal(serialized.includes('endpoint'), false);
  assert.equal(serialized.includes('apiBase'), false);
});

test('close cancels a pending build and closes both candidate and active index', async () => {
  const active = new FakeIndex('old');
  const buildGate = deferred();
  const candidate = new FakeIndex('new', { ready: buildGate.promise });
  const router = new IndexRouter({
    activeIndex: active,
    activeRevision: 'old-r1',
    makeId: sequenceIds(),
    createCandidate: async () => candidate,
  });
  const job = router.startRebuild(config('new'), { revision: 'new-r2' });
  const closing = router.close();
  buildGate.resolve(candidate);
  await closing;

  assert.equal((await router.waitForRebuild(job.id)).status, 'cancelled');
  assert.equal(candidate.closed, 1);
  assert.equal(active.closed, 1);
  assert.equal(router.status().state, 'closed');
});
