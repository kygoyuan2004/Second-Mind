import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createKnowledgeBaseContext } from '../src/knowledge-base-runtime.mjs';

function fakeIndex(config) {
  return {
    config,
    ready: Promise.resolve(),
    policy: {},
    search: async () => ({ route: 'keyword', results: [] }),
    status: () => ({
      available: true,
      lexicalAvailable: true,
      semanticAvailable: config.embedding.provider !== 'disabled',
      generation: 'example-generation',
      files: 1,
      embedding: { ...config.embedding },
    }),
    close: async () => {},
  };
}

test('fresh dynamic context builds lexical state without calling a paid embedding provider', async () => {
  const created = await fsp.mkdtemp(path.join(os.tmpdir(), 'second-mind-kb-runtime-'));
  const root = await fsp.realpath(created);
  try {
    const vaultPath = path.join(root, 'vault');
    const state = path.join(root, 'state');
    await Promise.all([fsp.mkdir(vaultPath), fsp.mkdir(state)]);
    let providerCalls = 0;
    const runtimeConfig = {
      ready: Promise.resolve(),
      refresh: async () => runtimeConfig.publicSnapshot(),
      publicSnapshot: () => ({
        revision: 'runtime-1',
        models: [],
        embedding: { provider: 'openai-compatible', configured: true },
      }),
      runtimeSnapshot: () => ({
        revision: 'runtime-1',
        models: [],
        embedding: {
          provider: 'openai-compatible',
          apiBase: 'https://embedding.example.com/v1',
          apiKey: 'TEST_ONLY_NOT_A_REAL_EMBEDDING_KEY',
          model: 'example-embedding-model',
          dimensions: 64,
        },
      }),
    };
    let openedConfig;
    const entry = {
      knowledgeBaseId: 'alpha',
      revision: 'alpha-1',
      name: 'Example Alpha',
      rootPath: vaultPath,
      state: {
        dataDir: state,
        indexDir: path.join(state, 'index'),
        draftDir: path.join(state, 'drafts'),
        recoveryDir: path.join(state, 'recovery'),
        conversationFile: path.join(state, 'conversations.json'),
        auditFile: path.join(state, 'audit.jsonl'),
        embeddingProfileFile: path.join(state, 'embedding-active.json'),
        embeddingSlotsRoot: path.join(state, 'embedding-slots'),
      },
    };
    const context = await createKnowledgeBaseContext({
      appName: 'Second Mind',
      embedding: runtimeConfig.runtimeSnapshot().embedding,
    }, entry, {
      runtimeConfig,
      embeddingRuntimeOptions: {
        embeddingFetch: async () => {
          providerCalls += 1;
          throw new Error('provider must not be called');
        },
        indexFactory: (config) => {
          openedConfig = config;
          return fakeIndex(config);
        },
      },
      storeFactory: async () => ({ ready: Promise.resolve() }),
      conversationFactory: async () => ({ ready: Promise.resolve() }),
      managerFactory: async (_item, _config, services) => ({
        ...services,
        ready: Promise.resolve(),
        close: async () => services.index.close(),
      }),
    });
    assert.equal(providerCalls, 0);
    assert.equal(openedConfig.embedding.provider, 'disabled');
    assert.equal(context.index.status().semanticAvailable, false);
    await context.close();
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('each knowledge-base context overrides a shared Pi session directory', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'second-mind-kb-pi-session-'));
  try {
    const captured = [];
    const baseConfig = {
      embedding: { provider: 'disabled', dimensions: 8 },
      pi: { sessionDir: path.join(root, 'unsafe-shared-pi-sessions') },
    };
    const dependencies = {
      indexFactoryByKnowledgeBase: async (_entry, config) => fakeIndex(config),
      storeFactory: async () => ({ ready: Promise.resolve() }),
      conversationFactory: async () => ({ ready: Promise.resolve() }),
      managerFactory: async (_entry, config) => {
        captured.push(config);
        return { ready: Promise.resolve(), close: async () => {} };
      },
    };
    const contexts = [];
    for (const id of ['alpha', 'beta']) {
      const stateRoot = path.join(root, 'state', id);
      contexts.push(await createKnowledgeBaseContext(baseConfig, {
        knowledgeBaseId: id,
        revision: `${id}-1`,
        name: `Example ${id}`,
        rootPath: path.join(root, 'vaults', id),
        state: {
          dataDir: stateRoot,
          indexDir: path.join(stateRoot, 'index'),
          draftDir: path.join(stateRoot, 'drafts'),
          recoveryDir: path.join(stateRoot, 'recovery'),
          conversationFile: path.join(stateRoot, 'conversations.json'),
          auditFile: path.join(stateRoot, 'audit.jsonl'),
          piSessionDir: path.join(stateRoot, 'pi-sessions'),
          embeddingProfileFile: path.join(stateRoot, 'embedding-active.json'),
          embeddingSlotsRoot: path.join(stateRoot, 'embedding-slots'),
        },
      }, dependencies));
    }

    assert.deepEqual(
      captured.map((config) => config.pi.sessionDir),
      ['alpha', 'beta'].map((id) => path.join(root, 'state', id, 'pi-sessions')),
    );
    assert.ok(captured.every((config) => config.pi.sessionDir !== baseConfig.pi.sessionDir));
    await Promise.all(contexts.map((context) => context.close()));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('context close drains embedding maintenance after the manager releases its index', async () => {
  const order = [];
  const stateRoot = path.join(os.tmpdir(), 'second-mind-close-order-state');
  const config = { embedding: { provider: 'disabled', dimensions: 8 } };
  const context = await createKnowledgeBaseContext(config, {
    knowledgeBaseId: 'close-order',
    revision: 'close-order-1',
    name: 'Close order',
    rootPath: path.join(os.tmpdir(), 'second-mind-close-order-vault'),
    state: {
      dataDir: stateRoot,
      piSessionDir: path.join(stateRoot, 'pi-sessions'),
    },
  }, {
    indexFactoryByKnowledgeBase: async (_entry, contextConfig) => ({
      index: fakeIndex(contextConfig),
      embeddingRuntime: {
        waitForMaintenance: async () => { order.push('maintenance'); },
      },
    }),
    storeFactory: async () => ({ ready: Promise.resolve() }),
    conversationFactory: async () => ({ ready: Promise.resolve() }),
    managerFactory: async () => ({
      ready: Promise.resolve(),
      close: async () => { order.push('manager'); },
    }),
  });

  await context.close();
  assert.deepEqual(order, ['manager', 'maintenance']);
});

test('a failed context construction closes an index opened earlier in the pipeline', async () => {
  let closed = 0;
  const stateRoot = path.join(os.tmpdir(), 'second-mind-failed-context-state');
  await assert.rejects(() => createKnowledgeBaseContext({
    embedding: { provider: 'disabled', dimensions: 8 },
  }, {
    knowledgeBaseId: 'failed-context',
    revision: 'failed-context-1',
    name: 'Failed context',
    rootPath: path.join(os.tmpdir(), 'second-mind-failed-context-vault'),
    state: {
      dataDir: stateRoot,
      piSessionDir: path.join(stateRoot, 'pi-sessions'),
    },
  }, {
    indexFactoryByKnowledgeBase: async (_entry, contextConfig) => ({
      index: { ...fakeIndex(contextConfig), close: async () => { closed += 1; } },
    }),
    storeFactory: async () => ({ ready: Promise.resolve() }),
    conversationFactory: async () => ({ ready: Promise.resolve() }),
    managerFactory: async () => {
      throw Object.assign(new Error('fixture manager failure'), { code: 'FIXTURE_MANAGER_FAILED' });
    },
  }), (error) => error?.code === 'FIXTURE_MANAGER_FAILED');
  assert.equal(closed, 1);
});
