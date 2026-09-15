import path from 'node:path';

import { EmbeddingClient } from './embedding-client.mjs';
import {
  EmbeddingRuntime,
  EmbeddingRuntimeError,
  promotePreviousEmbedding,
  resolveActiveEmbedding,
} from './embedding-runtime.mjs';
import { SdkKnowledgeIndex as KnowledgeIndex } from './sdk-knowledge-index.mjs';
import { SdkKnowledgeManager } from './sdk-knowledge-manager.mjs';
import { SdkKnowledgeStore } from './sdk-knowledge-store.mjs';
import { createSdkWebServer } from './sdk-web-search.mjs';
import { migrateSdkState } from './sdk-state-migration.mjs';

function disabledEmbedding(config = {}) {
  return {
    ...(config || {}),
    provider: 'disabled',
    apiBase: '',
    endpoint: '',
    apiKey: '',
    model: '',
  };
}

function usable(index, state) {
  const status = index?.status?.() || {};
  if (status.available !== true || status.lexicalAvailable !== true) return false;
  const expected = state.embedding || {};
  const actual = status.embedding || {};
  return String(actual.provider || 'disabled') === String(expected.provider || 'disabled') && (
    expected.provider === 'disabled' || (
      String(actual.model || '') === String(expected.model || '') &&
      Number(actual.dimensions) === Number(expected.dimensions)
    )
  );
}

async function openIndex(config, state, options = {}) {
  const activeConfig = { ...config, indexDir: state.indexDir, embedding: state.embedding };
  const client = options.client || new EmbeddingClient(state.embedding);
  const index = options.indexFactory
    ? options.indexFactory(activeConfig, { client, autoBuild: state.selection === 'base' })
    : new KnowledgeIndex(activeConfig, { client, autoBuild: state.selection === 'base' });
  try {
    await index.ready;
    return { client, index };
  } catch (error) {
    await Promise.resolve(index.close?.()).catch(() => {});
    throw error;
  }
}

async function dynamicIndex(config, entry, runtimeConfig, options = {}) {
  const runtimeOptions = {
    activeProfileFile: entry.state.embeddingProfileFile,
    slotsRoot: entry.state.embeddingSlotsRoot,
    lookup: options.lookup,
    embeddingFetch: options.embeddingFetch,
    httpsRequest: options.httpsRequest || options.request,
    embeddingClientFactory: options.embeddingClientFactory,
    indexFactory: options.embeddingIndexFactory || options.indexFactory,
  };
  let activeState = await resolveActiveEmbedding(config, runtimeOptions);
  // A desired remote embedding configuration is not an activated index. On a
  // fresh installation, build the lexical base without issuing a paid request;
  // only the explicit validate-and-build flow may create the first vector slot.
  if (activeState.selection === 'base' && activeState.embedding.provider !== 'disabled') {
    activeState = {
      ...activeState,
      embedding: disabledEmbedding(activeState.embedding),
      revision: `lexical-${activeState.revision}`,
    };
  }
  let opened;
  try {
    opened = await openIndex(config, activeState, {
      indexFactory: options.indexFactory,
      client: options.embedding,
    });
    if (activeState.selection !== 'base' && !usable(opened.index, activeState)) {
      throw new EmbeddingRuntimeError(
        'The committed embedding index does not match its active profile.',
        'ACTIVE_EMBEDDING_INDEX_INVALID',
        503,
      );
    }
  } catch (currentError) {
    await Promise.resolve(opened?.index?.close?.()).catch(() => {});
    if (activeState.selection === 'base') throw currentError;
    let previousState;
    let previousOpened;
    try {
      previousState = await resolveActiveEmbedding(config, { ...runtimeOptions, selection: 'previous' });
      previousOpened = await openIndex(config, previousState, { indexFactory: options.indexFactory });
      if (!usable(previousOpened.index, previousState)) {
        throw new EmbeddingRuntimeError(
          'The previous embedding index does not match its saved profile.',
          'ACTIVE_EMBEDDING_PREVIOUS_INVALID',
          503,
        );
      }
      await promotePreviousEmbedding({
        activeProfileFile: runtimeOptions.activeProfileFile,
        expectedCurrentRevision: activeState.revision,
      });
      activeState = previousState;
      opened = previousOpened;
    } catch (previousError) {
      await Promise.resolve(previousOpened?.index?.close?.()).catch(() => {});
      throw new EmbeddingRuntimeError(
        'Neither the current nor previous embedding index could be opened safely.',
        'ACTIVE_EMBEDDING_INDEX_UNAVAILABLE',
        503,
        { cause: previousError, currentError },
      );
    }
  }
  const embeddingRuntime = new EmbeddingRuntime({
    registry: runtimeConfig,
    baseConfig: config,
    activeProfileFile: runtimeOptions.activeProfileFile,
    slotsRoot: runtimeOptions.slotsRoot,
    activeState,
    activeIndex: opened.index,
    lookup: runtimeOptions.lookup,
    embeddingFetch: runtimeOptions.embeddingFetch,
    httpsRequest: runtimeOptions.httpsRequest,
    embeddingClientFactory: runtimeOptions.embeddingClientFactory,
    indexFactory: runtimeOptions.indexFactory || ((cfg, opts) => new KnowledgeIndex(cfg, opts)),
  });
  return { index: embeddingRuntime.index, embedding: opened.client, embeddingRuntime };
}

export async function createKnowledgeBaseContext(baseConfig, entry, dependencies = {}) {
  // The previous engine's state is preserved in place. New-format state uses
  // separate paths until the explicit, backed-up migration has completed.
  const legacyState = {
    conversationFile: path.join(entry.state.dataDir, 'conversations.json'),
    draftDir: path.join(entry.state.dataDir, 'drafts'), ...entry.state,
  };
  const sdkDataDir = path.join(entry.state.dataDir, 'sdk-v1');
  const config = {
    ...baseConfig,
    knowledgeBaseId: entry.knowledgeBaseId,
    knowledgeBaseRevision: entry.revision,
    vaultLabel: entry.name,
    vaultPath: entry.rootPath,
    ...entry.state,
    dataDir: sdkDataDir,
    indexDir: path.join(sdkDataDir, 'index'),
    draftDir: path.join(sdkDataDir, 'drafts'),
    conversationFile: path.join(sdkDataDir, 'conversations.json'),
    auditFile: path.join(sdkDataDir, 'audit.jsonl'),
  };
  const sdkEntry = { ...entry, state: { ...entry.state,
    embeddingProfileFile: path.join(sdkDataDir, 'embedding-active.json'),
    embeddingSlotsRoot: path.join(sdkDataDir, 'embedding-slots'),
  } };
  await migrateSdkState(legacyState, config);
  let index;
  let embedding;
  let embeddingRuntime = null;
  let store;
  let conversations;
  let manager;
  try {
    if (dependencies.indexFactoryByKnowledgeBase) {
      const supplied = await dependencies.indexFactoryByKnowledgeBase(entry, config);
      index = supplied.index || supplied;
      embedding = supplied.embedding || dependencies.embedding;
      embeddingRuntime = supplied.embeddingRuntime || null;
    } else if (dependencies.embeddingRuntime) {
      embedding = dependencies.embedding || new EmbeddingClient(config.embedding);
      index = dependencies.index || new KnowledgeIndex(config, { client: embedding });
      await index.ready;
      embeddingRuntime = dependencies.embeddingRuntime;
    } else if (dependencies.runtimeConfig) {
      ({ index, embedding, embeddingRuntime } = await dynamicIndex(
        config,
        sdkEntry,
        dependencies.runtimeConfig,
        dependencies.embeddingRuntimeOptions || {},
      ));
    } else {
      embedding = dependencies.embedding || new EmbeddingClient(config.embedding);
      index = dependencies.index || new KnowledgeIndex(config, { client: embedding });
    }
    store = dependencies.storeFactory
      ? await dependencies.storeFactory(entry, config, index)
      : new SdkKnowledgeStore(config, { ...baseConfig, ...entry.state, vaultPath: entry.rootPath }, index);
    manager = dependencies.managerFactory
      ? await dependencies.managerFactory(entry, config, { index, store, conversations })
      : new SdkKnowledgeManager(config, {
          index,
          store,
          queryFn: dependencies.sdkQuery,
          sdkFetch: dependencies.sdkFetch,
          webFactory: dependencies.sdkWebFactory || createSdkWebServer,
          runtimeConfig: dependencies.runtimeConfig,
          transcriptionOptions: { tempRoot: path.join(sdkDataDir, 'speech') },
          videoOptions: { tempRoot: path.join(sdkDataDir, 'video') },
        });
    conversations = manager.conversations;
    const ready = manager.ready;
    await ready;
    return Object.freeze({
      knowledgeBaseId: entry.knowledgeBaseId,
      knowledgeBaseRevision: entry.revision,
      name: entry.name,
      config,
      index,
      embedding,
      embeddingRuntime,
      store,
      conversations,
      manager,
      ready,
      async close() {
        let failure = null;
        try {
          await manager.close();
        } catch (error) {
          failure = error;
        }
        try {
          await embeddingRuntime?.waitForMaintenance?.();
        } catch (error) {
          failure ||= error;
        }
        if (failure) throw failure;
      },
    });
  } catch (error) {
    if (manager?.close) await Promise.resolve(manager.close()).catch(() => {});
    else await Promise.resolve(index?.close?.()).catch(() => {});
    await Promise.resolve(embeddingRuntime?.waitForMaintenance?.()).catch(() => {});
    throw error;
  }
}

export const knowledgeBaseRuntimeInternals = Object.freeze({ disabledEmbedding, usable, openIndex });
