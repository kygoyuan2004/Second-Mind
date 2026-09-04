import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeBaseHub } from '../src/knowledge-base-hub.mjs';

function registryFixture(entries, revision = 'registry-1') {
  let generation = 1;
  let snapshot = {
    version: 1,
    revision,
    stale: false,
    source: 'managed',
    defaultKnowledgeBaseId: entries.find((entry) => entry.default)?.knowledgeBaseId,
    knowledgeBases: entries,
    allowedMounts: [],
  };
  return {
    ready: Promise.resolve(),
    refresh: async () => snapshot,
    runtimeSnapshot: () => snapshot,
    publicSnapshot: () => ({
      ...snapshot,
      knowledgeBases: snapshot.knowledgeBases.map((entry) => ({
        knowledgeBaseId: entry.knowledgeBaseId,
        name: entry.name,
        enabled: entry.enabled,
        default: entry.default,
        revision: entry.revision,
      })),
    }),
    administrativeSnapshot: () => snapshot,
    resolve(id, { allowDisabled = false } = {}) {
      const selected = snapshot.knowledgeBases.find((entry) => (
        entry.knowledgeBaseId === (id || snapshot.defaultKnowledgeBaseId)
      ));
      if (!selected) throw Object.assign(new Error('missing'), { code: 'KNOWLEDGE_BASE_NOT_FOUND', status: 404 });
      if (!allowDisabled && !selected.enabled) {
        throw Object.assign(new Error('disabled'), { code: 'KNOWLEDGE_BASE_DISABLED', status: 409 });
      }
      return selected;
    },
    async update(input, options = {}) {
      const expected = options.expectedRevision ?? input.expectedRevision;
      if (expected !== snapshot.revision) {
        throw Object.assign(new Error('stale'), {
          code: 'KNOWLEDGE_BASE_REVISION_CONFLICT', status: 409,
        });
      }
      generation += 1;
      const previous = new Map(snapshot.knowledgeBases.map((entry) => [entry.knowledgeBaseId, entry]));
      const knowledgeBases = input.knowledgeBases.map((item) => ({
        ...(previous.get(item.knowledgeBaseId) || {}),
        ...item,
        revision: `${item.knowledgeBaseId}-${generation}`,
      }));
      snapshot = {
        ...snapshot,
        revision: `registry-${generation}`,
        defaultKnowledgeBaseId: knowledgeBases.find((entry) => entry.default)?.knowledgeBaseId,
        knowledgeBases,
      };
      return snapshot;
    },
    replace(value) { snapshot = value; },
  };
}

function entry(id, options = {}) {
  return {
    knowledgeBaseId: id,
    name: options.name || `Example ${id}`,
    enabled: options.enabled !== false,
    default: options.default === true,
    revision: options.revision || `${id}-1`,
    unavailableCode: options.unavailableCode || '',
  };
}

function context(id, options = {}) {
  let closed = false;
  const status = options.status || { available: true, lexicalAvailable: true, files: 2 };
  return {
    knowledgeBaseId: id,
    index: { status: () => status },
    store: {},
    conversations: {},
    manager: {
      ready: options.ready || Promise.resolve(),
      tasks: new Map(),
      close: async () => { closed = true; },
    },
    get closed() { return closed; },
  };
}

test('one damaged knowledge base does not prevent another from becoming ready', async () => {
  const registry = registryFixture([
    entry('alpha', { default: true }),
    entry('beta'),
  ]);
  const created = new Map();
  const hub = new KnowledgeBaseHub({
    registry,
    createContext: async (item) => {
      if (item.knowledgeBaseId === 'beta') throw Object.assign(new Error('bad index'), {
        code: 'KNOWLEDGE_INDEX_CORRUPT',
      });
      const value = context(item.knowledgeBaseId);
      created.set(item.knowledgeBaseId, value);
      return value;
    },
  });
  await hub.ready;
  const status = hub.publicStatus();
  assert.equal(status.readyCount, 1);
  assert.deepEqual(status.knowledgeBases.map((item) => [item.knowledgeBaseId, item.status]), [
    ['alpha', 'ready'],
    ['beta', 'failed'],
  ]);
  assert.equal(hub.resolve('alpha'), created.get('alpha'));
  assert.throws(() => hub.resolve('beta'), (error) => (
    error.code === 'KNOWLEDGE_INDEX_CORRUPT' && error.status === 503
  ));
  await hub.close();
  assert.equal(created.get('alpha').closed, true);
});

test('registry revisions replace only changed contexts and close removed contexts', async () => {
  const alpha = entry('alpha', { default: true });
  const beta = entry('beta');
  const registry = registryFixture([alpha, beta]);
  const generations = [];
  let notifyOpening;
  let releaseOpening;
  const opening = new Promise((resolve) => { notifyOpening = resolve; });
  const openingGate = new Promise((resolve) => { releaseOpening = resolve; });
  const hub = new KnowledgeBaseHub({
    registry,
    createContext: async (item) => {
      if (item.revision === 'alpha-2') {
        notifyOpening();
        await openingGate;
      }
      const value = context(item.knowledgeBaseId);
      generations.push(value);
      return value;
    },
  });
  await hub.ready;
  const firstAlpha = hub.resolve('alpha');
  const firstBeta = hub.resolve('beta');
  registry.replace({
    ...registry.runtimeSnapshot(),
    revision: 'registry-2',
    knowledgeBases: [{ ...alpha, revision: 'alpha-2', name: 'Renamed Alpha' }],
  });
  assert.throws(() => hub.resolve('alpha'), (error) => error.code === 'KNOWLEDGE_BASE_UNAVAILABLE');
  const refreshing = hub.refresh();
  await opening;
  assert.throws(() => hub.resolve('alpha'), (error) => error.code === 'KNOWLEDGE_BASE_BUSY');
  releaseOpening();
  await refreshing;
  assert.notEqual(hub.resolve('alpha'), firstAlpha);
  assert.equal(firstAlpha.closed, true);
  assert.equal(firstBeta.closed, true);
  assert.equal(generations.length, 3);
  await hub.close();
});

test('registry updates reject an admission that is still creating its task', async () => {
  const alpha = entry('alpha', { default: true });
  const registry = registryFixture([alpha]);
  let releaseCreation;
  let notifyCreation;
  const creationGate = new Promise((resolve) => { releaseCreation = resolve; });
  const creationStarted = new Promise((resolve) => { notifyCreation = resolve; });
  const activeContext = context('alpha');
  activeContext.manager.createTask = async () => {
    notifyCreation();
    await creationGate;
    return { taskId: 'fixture-task' };
  };
  const hub = new KnowledgeBaseHub({
    registry,
    createContext: async () => activeContext,
  });
  await hub.ready;

  const creating = hub.createTask('alpha', 'admin', { prompt: 'fixture' });
  await creationStarted;
  await assert.rejects(
    hub.updateRegistry({
      expectedRevision: 'registry-1',
      knowledgeBases: [{ ...alpha, name: 'Renamed Alpha' }],
    }, { expectedRevision: 'registry-1' }),
    (error) => error.code === 'KNOWLEDGE_BASE_BUSY' && error.status === 409,
  );
  releaseCreation();
  assert.deepEqual(await creating, {
    context: activeContext,
    result: { taskId: 'fixture-task' },
  });
  assert.equal(registry.runtimeSnapshot().revision, 'registry-1');
  await hub.close();
});

test('disabled and unavailable registry entries are never opened', async () => {
  const registry = registryFixture([
    entry('alpha', { default: true }),
    entry('beta', { enabled: false }),
    entry('gamma', { unavailableCode: 'KNOWLEDGE_BASE_PATH_UNAVAILABLE' }),
  ]);
  const opened = [];
  const hub = new KnowledgeBaseHub({
    registry,
    createContext: async (item) => {
      opened.push(item.knowledgeBaseId);
      return context(item.knowledgeBaseId);
    },
  });
  await hub.ready;
  assert.deepEqual(opened, ['alpha']);
  assert.deepEqual(hub.publicStatus().knowledgeBases.map((item) => item.status), [
    'ready', 'disabled', 'failed',
  ]);
  await hub.close();
});
