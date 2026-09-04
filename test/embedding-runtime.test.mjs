import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createPinnedEmbeddingFetch,
  EmbeddingRuntime,
  embeddingRuntimeInternals,
  promotePreviousEmbedding,
  resolveActiveEmbedding,
} from '../src/embedding-runtime.mjs';

const EMBEDDING_SECRET = ['embedding', 'runtime', 'fixture', 'credential'].join('-');
const API_BASE = 'https://embeddings.example.com/v1';

function embedding(overrides = {}) {
  return {
    provider: 'openai-compatible',
    apiBase: API_BASE,
    apiKey: EMBEDDING_SECRET,
    model: 'embedding-new',
    dimensions: 8,
    batchSize: 4,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function indexStatus(name, profile, overrides = {}) {
  const chunks = overrides.chunks ?? 2;
  return {
    available: overrides.available !== false,
    generation: `generation-${name}`,
    previousGeneration: null,
    createdAt: '2026-09-02T00:00:00.000Z',
    files: chunks ? 1 : 0,
    chunks,
    embeddedChunks: profile.provider === 'disabled' ? 0 : chunks,
    lexicalAvailable: true,
    semanticAvailable: profile.provider !== 'disabled',
    embedding: {
      provider: profile.provider,
      model: profile.provider === 'disabled' ? null : profile.model,
      dimensions: profile.provider === 'disabled' ? null : profile.dimensions,
    },
    watchEnabled: false,
    lastReconciledAt: null,
    lastError: null,
    ...overrides,
  };
}

class FakeIndex {
  constructor(name, profile, options = {}) {
    this.name = name;
    this.profile = profile;
    this.policy = { root: '/fixture/vault' };
    this.ready = options.ready || Promise.resolve(this);
    this.rebuildError = options.rebuildError || null;
    this.closed = 0;
    this.statusOverrides = options.statusOverrides || {};
  }

  status() {
    return indexStatus(this.name, this.profile, this.statusOverrides);
  }

  async search(query) {
    return { index: this.name, query };
  }

  async rebuild() {
    if (this.rebuildError) throw this.rebuildError;
    return this.status();
  }

  async updatePaths() {
    return this.status();
  }

  async close() {
    this.closed += 1;
  }
}

class FakeRegistry {
  constructor(profile, revision = 'runtime-config-r1') {
    this.profile = structuredClone(profile);
    this.revision = revision;
    this.stale = false;
  }

  async refresh() {
    return { revision: this.revision, stale: this.stale };
  }

  runtimeSnapshot() {
    return { embedding: structuredClone(this.profile) };
  }
}

function fakeHttpsRequest(responses, calls) {
  return (target, options, callback) => {
    const request = new EventEmitter();
    request.end = (body) => {
      let pinned;
      options.lookup(target.hostname, { all: false }, (error, address, family) => {
        if (error) throw error;
        pinned = { address, family };
      });
      calls.push({
        url: target.href,
        method: options.method,
        headers: { ...options.headers },
        servername: options.servername,
        agent: options.agent,
        pinned,
        body: Buffer.from(body).toString('utf8'),
      });
      const fixture = responses.shift() || {};
      queueMicrotask(() => {
        const responseBody = Buffer.from(fixture.body ?? '{}');
        const response = Readable.from([responseBody]);
        response.statusCode = fixture.statusCode ?? 200;
        response.statusMessage = fixture.statusMessage || 'OK';
        response.headers = {
          'content-type': 'application/json',
          'content-length': String(responseBody.byteLength),
          ...(fixture.headers || {}),
        };
        callback(response);
      });
    };
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    return request;
  };
}

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'embedding-runtime-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const oldProfile = embedding({
    apiKey: ['old', 'embedding', 'fixture', 'credential'].join('-'),
    model: 'embedding-old',
  });
  const activeIndex = new FakeIndex('old', oldProfile);
  const registry = options.registry || new FakeRegistry(embedding());
  const runtime = new EmbeddingRuntime({
    registry,
    baseConfig: {
      indexDir: path.join(root, 'base-index'),
      embedding: oldProfile,
      retrieval: { watch: false },
    },
    activeProfileFile: path.join(root, 'private', 'active-embedding.json'),
    slotsRoot: path.join(root, 'slots'),
    activeState: {
      manifest: { version: 1, current: null, previous: null },
      embedding: oldProfile,
      revision: 'base-old-revision',
      slotId: 'base',
    },
    activeIndex,
    lookup: options.lookup || (async () => [{ address: '93.184.216.34', family: 4 }]),
    embeddingClientFactory: options.embeddingClientFactory || (() => ({
      async embed(texts) {
        return texts.map(() => Array(8).fill(0.125));
      },
    })),
    indexFactory: options.indexFactory || ((config) => (
      new FakeIndex('new', config.embedding)
    )),
  });
  t.after(() => runtime.router.close());
  return { root, runtime, registry, activeIndex };
}

async function privateJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(filename, 0o600);
}

function manifestEntry(slotId, revision, model, generation) {
  return {
    slotId,
    revision,
    generation,
    activatedAt: '2026-09-02T00:00:00.000Z',
    embedding: embedding({
      apiKey: `${EMBEDDING_SECRET}-${revision}`,
      model,
    }),
  };
}

test('a successful rebuild persists a private profile and exposes only a sanitized index status', async (t) => {
  const value = await fixture(t);
  const job = await value.runtime.startRebuild(value.registry.revision);
  const completed = await value.runtime.router.waitForRebuild(job.id);

  assert.equal(completed.status, 'succeeded');
  assert.equal((await value.runtime.index.search('fresh task')).index, 'new');
  const publicJson = JSON.stringify(value.runtime.publicStatus());
  assert.equal(publicJson.includes(EMBEDDING_SECRET), false);
  assert.equal(publicJson.includes(API_BASE), false);
  assert.equal(publicJson.includes('apiKey'), false);
  assert.equal(publicJson.includes('apiBase'), false);

  const filename = path.join(value.root, 'private', 'active-embedding.json');
  const stat = await fsp.stat(filename);
  assert.equal(stat.mode & 0o777, 0o600);
  const privateDocument = JSON.parse(await fsp.readFile(filename, 'utf8'));
  assert.equal(privateDocument.current.embedding.apiKey, EMBEDDING_SECRET);
  assert.equal(privateDocument.current.embedding.apiBase, API_BASE);

  const resolved = await resolveActiveEmbedding({
    indexDir: path.join(value.root, 'base-index'),
    embedding: embedding({ provider: 'disabled' }),
  }, {
    activeProfileFile: filename,
    slotsRoot: path.join(value.root, 'slots'),
  });
  assert.equal(resolved.embedding.model, 'embedding-new');
  assert.equal(resolved.indexDir, path.join(value.root, 'slots', privateDocument.current.slotId));
});

test('private, CGNAT, IPv6 local, and mixed DNS answers are rejected before a paid validation call', async () => {
  for (const answers of [
    [{ address: '10.1.2.3', family: 4 }],
    [{ address: '100.64.0.1', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: 'fe80::1', family: 6 }],
    [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ],
  ]) {
    await assert.rejects(
      () => embeddingRuntimeInternals.assertPublicDestination(
        embedding(),
        async () => answers,
      ),
      { code: 'EMBEDDING_DESTINATION_DENIED', status: 400 },
    );
  }
});

test('runtime dimension detection uses the hardened destination check and returns the provider vector size', async (t) => {
  let probes = 0;
  const value = await fixture(t, {
    embeddingClientFactory: () => ({
      async detectDimensions() {
        probes += 1;
        return 768;
      },
    }),
  });
  const dimensions = await value.runtime.detectDimensions(embedding({ dimensions: 1_024 }));
  assert.equal(dimensions, 768);
  assert.equal(probes, 1);
});

test('pinned transport resolves every request, pins TLS to the verified IP, and blocks DNS rebinding', async () => {
  let resolution = 0;
  const requests = [];
  const fetchFn = createPinnedEmbeddingFetch({
    lookup: async () => {
      resolution += 1;
      return resolution === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    },
    request: fakeHttpsRequest([{ body: '{"ok":true}' }], requests),
  });
  const requestOptions = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${EMBEDDING_SECRET}`,
      'Content-Type': 'application/json',
      Host: 'attacker.example',
    },
    body: '{"input":["fixture"]}',
  };

  const response = await fetchFn(`${API_BASE}/embeddings`, requestOptions);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].pinned, { address: '93.184.216.34', family: 4 });
  assert.equal(requests[0].servername, 'embeddings.example.com');
  assert.equal(requests[0].agent, false);
  assert.equal(Object.keys(requests[0].headers).some((name) => name.toLowerCase() === 'host'), false);
  assert.equal(requests[0].headers.authorization, `Bearer ${EMBEDDING_SECRET}`);

  await assert.rejects(
    () => fetchFn(`${API_BASE}/embeddings`, requestOptions),
    { code: 'EMBEDDING_DESTINATION_DENIED' },
  );
  assert.equal(requests.length, 1, 'no credential-bearing request is made after rebinding');
});

test('pinned transport rejects redirects without forwarding authorization to the target', async () => {
  const requests = [];
  const fetchFn = createPinnedEmbeddingFetch({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: fakeHttpsRequest([{
      statusCode: 302,
      headers: { location: 'https://127.0.0.1/private' },
      body: '',
    }], requests),
  });

  await assert.rejects(
    () => fetchFn(`${API_BASE}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${EMBEDDING_SECRET}` },
      body: '{}',
    }),
    { code: 'EMBEDDING_REDIRECT_DENIED' },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${API_BASE}/embeddings`);
});

test('pinned transport bounds the complete provider response before exposing it to EmbeddingClient', async () => {
  const requests = [];
  const fetchFn = createPinnedEmbeddingFetch({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: fakeHttpsRequest([{ body: 'x'.repeat(1_025) }], requests),
    maxResponseBytes: 1_024,
  });
  await assert.rejects(
    () => fetchFn(`${API_BASE}/embeddings`, { method: 'POST', body: '{}' }),
    { code: 'EMBEDDING_RESPONSE_TOO_LARGE' },
  );
  assert.equal(requests.length, 1);
});

test('mixed public and private DNS answers are rejected before authorization leaves the process', async () => {
  const requests = [];
  const fetchFn = createPinnedEmbeddingFetch({
    lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ],
    request: fakeHttpsRequest([], requests),
  });

  await assert.rejects(
    () => fetchFn(`${API_BASE}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${EMBEDDING_SECRET}` },
      body: '{}',
    }),
    { code: 'EMBEDDING_DESTINATION_DENIED' },
  );
  assert.equal(requests.length, 0);
});

test('abort during DNS resolution prevents a request and rejects promptly', async () => {
  let finishLookup;
  const lookup = new Promise((resolve) => { finishLookup = resolve; });
  const requests = [];
  const controller = new AbortController();
  const fetchFn = createPinnedEmbeddingFetch({
    lookup: async () => lookup,
    request: fakeHttpsRequest([], requests),
  });

  const pending = fetchFn(`${API_BASE}/embeddings`, {
    method: 'POST',
    body: '{}',
    signal: controller.signal,
  });
  controller.abort(new DOMException('cancelled by fixture', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requests.length, 0);
  finishLookup([{ address: '93.184.216.34', family: 4 }]);
});

test('abort after connection creation destroys the pinned request and settles even without an error event', async () => {
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  let destroyed = false;
  const controller = new AbortController();
  const fetchFn = createPinnedEmbeddingFetch({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: () => {
      const request = new EventEmitter();
      request.end = () => requestStarted();
      request.destroy = () => { destroyed = true; };
      return request;
    },
  });

  const pending = fetchFn(`${API_BASE}/embeddings`, {
    method: 'POST',
    body: '{}',
    signal: controller.signal,
  });
  await started;
  controller.abort(new DOMException('cancelled by fixture', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(destroyed, true);
});

test('integration can resolve and durably promote a verified previous generation', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'embedding-fallback-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const slotsRoot = path.join(root, 'slots');
  const profileFile = path.join(root, 'private', 'active.json');
  const current = manifestEntry('slot-current-broken', 'revision-current', 'embedding-current', 'bad');
  const previous = manifestEntry('slot-previous-good', 'revision-previous', 'embedding-previous', 'good');
  await fsp.mkdir(path.join(slotsRoot, previous.slotId), { recursive: true, mode: 0o700 });
  await privateJson(profileFile, { version: 1, current, previous });
  const options = {
    activeProfileFile: profileFile,
    slotsRoot,
    embeddingFetch: async () => { throw new Error('network is not used while resolving'); },
  };
  const config = {
    indexDir: path.join(root, 'base-index'),
    embedding: embedding({ model: 'base' }),
  };

  const selectedCurrent = await resolveActiveEmbedding(config, options);
  assert.equal(selectedCurrent.selection, 'current');
  await assert.rejects(fsp.access(selectedCurrent.indexDir), { code: 'ENOENT' });

  const selectedPrevious = await resolveActiveEmbedding(config, {
    ...options,
    selection: 'previous',
  });
  assert.equal(selectedPrevious.selection, 'previous');
  assert.equal(selectedPrevious.revision, previous.revision);
  assert.equal(selectedPrevious.generation, 'good');
  await fsp.access(selectedPrevious.indexDir);

  await assert.rejects(
    () => promotePreviousEmbedding({
      activeProfileFile: profileFile,
      expectedCurrentRevision: 'stale-revision',
    }),
    { code: 'ACTIVE_EMBEDDING_REVISION_CONFLICT', status: 409 },
  );
  const promoted = await promotePreviousEmbedding({
    activeProfileFile: profileFile,
    expectedCurrentRevision: current.revision,
  });
  assert.deepEqual(promoted, {
    revision: previous.revision,
    slotId: previous.slotId,
    generation: previous.generation,
    previousRevision: current.revision,
  });
  assert.equal(JSON.stringify(promoted).includes(EMBEDDING_SECRET), false);

  const after = await resolveActiveEmbedding(config, options);
  assert.equal(after.selection, 'current');
  assert.equal(after.revision, previous.revision);
  assert.equal(after.slotId, previous.slotId);
  assert.equal((await fsp.stat(profileFile)).mode & 0o777, 0o600);
});

test('the persisted base generation always resolves to the original index directory', () => {
  assert.equal(
    embeddingRuntimeInternals.indexDirectory(
      '/srv/vaultmind/index',
      '/srv/vaultmind/index-slots',
      { slotId: 'base' },
    ),
    '/srv/vaultmind/index',
  );
});

test('a malformed current or previous profile is never silently ignored', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'embedding-corrupt-profile-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const profileFile = path.join(root, 'active.json');
  const config = {
    indexDir: path.join(root, 'base'),
    embedding: embedding(),
  };

  await fsp.writeFile(profileFile, '{not-json', { mode: 0o600 });
  await assert.rejects(
    () => resolveActiveEmbedding(config, { activeProfileFile: profileFile }),
    { code: 'INVALID_RUNTIME_CONFIG_JSON' },
  );

  await privateJson(profileFile, {
    version: 1,
    current: manifestEntry('valid-current', 'valid-current-revision', 'current', 'current-generation'),
    previous: {
      ...manifestEntry('valid-previous', 'valid-previous-revision', 'previous', 'previous-generation'),
      slotId: '../escape',
    },
  });
  await assert.rejects(
    () => resolveActiveEmbedding(config, { activeProfileFile: profileFile }),
    { code: 'ACTIVE_EMBEDDING_PROFILE_INVALID' },
  );
});

test('DNS rejection leaves the active index unchanged and never invokes the embedding client', async (t) => {
  let factoryCalls = 0;
  const value = await fixture(t, {
    lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
    embeddingClientFactory: () => {
      factoryCalls += 1;
      throw new Error('must not run');
    },
  });

  await assert.rejects(
    () => value.runtime.startRebuild(value.registry.revision),
    { code: 'EMBEDDING_DESTINATION_DENIED' },
  );
  assert.equal(factoryCalls, 0);
  assert.equal((await value.runtime.index.search('unchanged')).index, 'old');
  assert.equal(value.runtime.publicStatus().pending, null);
});

test('a failed provider preflight neither switches indexes nor leaks or retains its credential', async (t) => {
  const providerError = new Error(`provider rejected ${EMBEDDING_SECRET} at ${API_BASE}`);
  providerError.code = 'EMBEDDING_API_ERROR';
  const value = await fixture(t, {
    embeddingClientFactory: () => ({
      async embed() { throw providerError; },
    }),
  });

  const job = await value.runtime.startRebuild(value.registry.revision);
  const completed = await value.runtime.router.waitForRebuild(job.id);
  assert.equal(completed.status, 'failed');
  assert.equal(completed.errorCode, 'EMBEDDING_API_ERROR');
  assert.equal((await value.runtime.index.search('old remains')).index, 'old');
  assert.equal(value.runtime.profiles.size, 0);
  const publicJson = JSON.stringify(value.runtime.publicStatus());
  assert.equal(publicJson.includes(EMBEDDING_SECRET), false);
  assert.equal(publicJson.includes(API_BASE), false);
  await assert.rejects(
    fsp.access(path.join(value.root, 'private', 'active-embedding.json')),
    { code: 'ENOENT' },
  );
});

test('a candidate build failure closes and removes its private slot without switching', async (t) => {
  const failure = new Error('fixture build failure');
  failure.code = 'INDEX_FIXTURE_BUILD_FAILED';
  let candidate;
  const value = await fixture(t, {
    indexFactory: (config) => {
      candidate = new FakeIndex('failed', config.embedding, { rebuildError: failure });
      return candidate;
    },
  });

  const job = await value.runtime.startRebuild(value.registry.revision);
  const completed = await value.runtime.router.waitForRebuild(job.id);
  assert.equal(completed.status, 'failed');
  assert.equal(completed.errorCode, 'INDEX_FIXTURE_BUILD_FAILED');
  assert.equal(candidate.closed, 1);
  assert.equal(value.runtime.profiles.size, 0);
  assert.equal((await value.runtime.index.search('old remains')).index, 'old');
  assert.deepEqual(await fsp.readdir(path.join(value.root, 'slots')), []);
});

test('stale or mismatched runtime configuration cannot start a rebuild', async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    () => value.runtime.startRebuild('outdated-runtime-revision'),
    { code: 'RUNTIME_CONFIG_REVISION_CONFLICT', status: 409 },
  );
  value.registry.stale = true;
  await assert.rejects(
    () => value.runtime.startRebuild(value.registry.revision),
    { code: 'RUNTIME_CONFIG_STALE', status: 409 },
  );
  assert.equal((await value.runtime.index.search('old remains')).index, 'old');
});

test('a changed desired embedding profile cannot activate an obsolete candidate', async (t) => {
  let releaseBuild;
  let buildStarted;
  const started = new Promise((resolve) => { buildStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseBuild = resolve; });
  const value = await fixture(t, {
    indexFactory: (config) => {
      const candidate = new FakeIndex('obsolete', config.embedding);
      candidate.rebuild = async () => {
        buildStarted();
        await blocked;
        return candidate.status();
      };
      return candidate;
    },
  });
  const job = await value.runtime.startRebuild(value.registry.revision);
  await started;
  value.registry.profile = embedding({ model: 'embedding-newer' });
  value.registry.revision = 'runtime-config-r2';
  releaseBuild();
  const completed = await value.runtime.router.waitForRebuild(job.id);
  assert.equal(completed.status, 'failed');
  assert.equal(completed.errorCode, 'INDEX_EMBEDDING_CONFIG_CHANGED');
  assert.equal((await value.runtime.index.search('old remains')).index, 'old');
});

test('after successive successful commits only current and previous managed slots remain', async (t) => {
  const value = await fixture(t);
  const activatedSlots = [];
  for (let index = 0; index < 3; index += 1) {
    const job = await value.runtime.startRebuild(value.registry.revision);
    const completed = await value.runtime.router.waitForRebuild(job.id);
    assert.equal(completed.status, 'succeeded');
    activatedSlots.push(value.runtime.publicStatus().active.revision);
  }
  await value.runtime.waitForMaintenance();

  const manifest = JSON.parse(await fsp.readFile(
    path.join(value.root, 'private', 'active-embedding.json'),
    'utf8',
  ));
  const directories = (await fsp.readdir(path.join(value.root, 'slots'))).sort();
  assert.deepEqual(directories, [manifest.current.slotId, manifest.previous.slotId].sort());
  assert.equal(directories.length, 2);
  assert.equal(activatedSlots.length, 3);
});

test('superseded slot cleanup waits for an in-flight task snapshot to release', async (t) => {
  const value = await fixture(t);
  const firstJob = await value.runtime.startRebuild(value.registry.revision);
  assert.equal((await value.runtime.router.waitForRebuild(firstJob.id)).status, 'succeeded');
  const firstManifest = JSON.parse(await fsp.readFile(
    path.join(value.root, 'private', 'active-embedding.json'),
    'utf8',
  ));
  const firstSlot = firstManifest.current.slotId;
  const held = value.runtime.index.acquireSnapshot();

  for (let index = 0; index < 2; index += 1) {
    const job = await value.runtime.startRebuild(value.registry.revision);
    assert.equal((await value.runtime.router.waitForRebuild(job.id)).status, 'succeeded');
  }
  await fsp.access(path.join(value.root, 'slots', firstSlot));
  assert.equal((await held.search('still readable')).index, 'new');

  held.release();
  await value.runtime.waitForMaintenance();
  await assert.rejects(
    fsp.access(path.join(value.root, 'slots', firstSlot)),
    { code: 'ENOENT' },
  );
});
