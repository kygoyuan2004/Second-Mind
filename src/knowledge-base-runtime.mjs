import path from 'node:path';

import { ConversationStore } from './conversation-store.mjs';
import { EmbeddingClient } from './embedding-client.mjs';
import {
  EmbeddingRuntime,
  EmbeddingRuntimeError,
  promotePreviousEmbedding,
  resolveActiveEmbedding,
} from './embedding-runtime.mjs';
import { KnowledgeIndex } from './knowledge-index.mjs';
import { TaskManager } from './task-manager.mjs';
import { VaultStore } from './vault-store.mjs';

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
    indexFactory: runtimeOptions.indexFactory,
  });
  return { index: embeddingRuntime.index, embedding: opened.client, embeddingRuntime };
}

export async function createKnowledgeBaseContext(baseConfig, entry, dependencies = {}) {
  const config = {
    ...baseConfig,
    knowledgeBaseId: entry.knowledgeBaseId,
    knowledgeBaseRevision: entry.revision,
    vaultLabel: entry.name,
    vaultPath: entry.rootPath,
    ...entry.state,
    pi: {
      ...(baseConfig.pi || {}),
      sessionDir: entry.state.piSessionDir || path.join(entry.state.dataDir, 'pi-sessions'),
    },
  };
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
    } else if (dependencies.runtimeConfig) {
      ({ index, embedding, embeddingRuntime } = await dynamicIndex(
        config,
        entry,
        dependencies.runtimeConfig,
        dependencies.embeddingRuntimeOptions || {},
      ));
    } else {
      embedding = dependencies.embedding || new EmbeddingClient(config.embedding);
      index = dependencies.index || new KnowledgeIndex(config, { client: embedding });
    }
    store = dependencies.storeFactory
      ? await dependencies.storeFactory(entry, config, index)
      : new VaultStore(config, { policy: index.policy, index });
    conversations = dependencies.conversationFactory
      ? await dependencies.conversationFactory(entry, config)
      : new ConversationStore(config.conversationFile);
    manager = dependencies.managerFactory
      ? await dependencies.managerFactory(entry, config, { index, store, conversations })
      : new TaskManager(config, {
          index,
          store,
          conversations,
          llm: dependencies.llm,
          llmRouter: dependencies.llmRouter,
          webSearch: dependencies.webSearch,
          webReader: dependencies.webReader,
          responsesExtractor: dependencies.responsesExtractor,
          runtimeConfig: dependencies.runtimeConfig,
          allowLegacyTestEngine: dependencies.allowLegacyTestEngine === true,
        });
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
    if (manager?.close) await manager.close().catch(() => {});
    else await index?.close?.().catch(() => {});
    await embeddingRuntime?.waitForMaintenance?.().catch(() => {});
    throw error;
  }
}

export const knowledgeBaseRuntimeInternals = Object.freeze({ disabledEmbedding, usable, openIndex });
