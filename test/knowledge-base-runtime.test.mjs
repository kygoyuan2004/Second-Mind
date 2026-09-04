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
