import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversationStore } from '../src/conversation-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { temporaryProject } from './helpers.mjs';

const MODEL_CATALOG = [{
  id: 'qwen',
  label: 'Qwen 3.8 Max',
  shortLabel: 'Qwen 3.8 Max',
  actualModel: 'qwen3.8-max',
  efforts: ['low', 'medium', 'xhigh'],
  defaultEffort: 'xhigh',
  available: true,
  capabilityVerified: true,
}, {
  id: 'kimi',
  label: 'Kimi K3',
  shortLabel: 'Kimi K3',
  actualModel: 'kimi-k3',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'medium',
  available: true,
  capabilityVerified: true,
}, {
  id: 'offline',
  label: 'Offline fixture',
  actualModel: 'offline-fixture',
  efforts: ['high'],
  defaultEffort: 'high',
  available: false,
}];

async function fixture(t, options = {}) {
  const project = await temporaryProject('second-mind-model-catalog-');
  t.after(project.cleanup);
  const calls = [];
  const conversations = new ConversationStore(project.config.conversationFile);
  const manager = new TaskManager({
    ...project.config,
    appName: 'Second Mind',
    vaultLabel: 'Fixture Vault',
    timezone: 'UTC',
    modelCatalog: options.modelCatalog ?? MODEL_CATALOG,
    llm: {
      provider: 'anthropic',
      model: 'qwen3.8-max',
      temperature: null,
      maxOutputTokens: 131_072,
    },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 8, maxContextChars: 24_000 },
    deep: { enabled: true, topK: 12 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  }, {
    allowLegacyTestEngine: true,
    index: {
      ready: Promise.resolve(),
      status: () => ({ available: true, files: 1, chunks: 1, semanticAvailable: false }),
      search: async () => ({ route: 'keyword', results: [], diagnostics: {} }),
      close: async () => {},
    },
    store: { ready: Promise.resolve(), cleanupDrafts: async () => {} },
    llm: {
      generate: async (messages, options) => {
        calls.push({ messages, options });
        return messages[0]?.content.includes('bounded search queries')
          ? '{"queries":["one","two"]}'
          : 'Grounded answer.';
      },
    },
    conversations,
  });
  t.after(() => manager.close());
  await manager.ready;
  return { manager, conversations, calls };
}

test('optional model catalog is published and selected model settings reach every Deep generation call', async (t) => {
  const value = await fixture(t);
  const status = await value.manager.publicStatus('admin');
  assert.deepEqual(status.models.map((model) => model.id), ['qwen', 'kimi', 'offline']);
  assert.equal(status.models[0].defaultEffort, 'xhigh');
  assert.deepEqual(status.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(status.models[0].effortMapping, {
    low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh',
  });
  assert.equal(status.models[2].available, false);

  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Compare the evidence.', taskMode: 'deep', model: 'qwen', effort: 'xhigh',
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(value.calls.length, 2);
  for (const call of value.calls) {
    assert.equal(call.options.model, 'qwen3.8-max');
    assert.equal(call.options.effort, 'xhigh');
    assert.equal(call.options.temperature, null);
  }
  assert.equal(value.calls[0].options.maxOutputTokens, 768);
  assert.equal(value.calls[1].options.maxOutputTokens, 32_768);
  assert.deepEqual(value.manager.publicTask(task), {
    id: task.id,
    conversationId: created.conversationId,
    forkedFromConversationId: null,
    kind: 'qa',
    taskMode: 'deep',
    model: 'qwen',
    actualModel: 'qwen3.8-max',
    modelProvider: 'anthropic',
    modelBindingRevision: task.model.bindingRevision,
    modelCatalogRevision: task.modelCatalogRevision,
    effort: 'xhigh',
    requestedEffort: 'xhigh',
    effectiveEffort: 'xhigh',
    webSearch: false,
    webSearchProvider: null,
    webSearchBindingRevision: null,
    status: 'completed',
    draftId: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
  assert.equal(value.conversations.list('admin')[0].model, 'qwen');
  assert.equal(value.conversations.list('admin')[0].effort, 'xhigh');
});

test('an explicit empty runtime catalog reports unconfigured and rejects before task mutation', async (t) => {
  const value = await fixture(t, { modelCatalog: [] });
  const status = await value.manager.publicStatus('admin');
  assert.deepEqual(status.models, []);
  assert.deepEqual(status.efforts, []);
  assert.equal(status.defaultModelId, null);
  assert.equal(status.llm.configured, false);
  assert.equal(status.llm.model, null);

  await assert.rejects(
    () => value.manager.createTask('admin', {
      kind: 'qa', prompt: 'This must not create a conversation or task.',
    }),
    { code: 'LLM_NOT_CONFIGURED', status: 503 },
  );
  assert.equal(value.manager.tasks.size, 0);
  assert.deepEqual(value.manager.listConversations('admin'), []);
  assert.deepEqual(value.calls, []);
});

test('catalog accepts aliases and maps every universal effort onto model capabilities', async (t) => {
  const value = await fixture(t);
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Use Kimi.', model: 'kimi-k3', effort: 'medium',
  });
  const task = value.manager.getTask('admin', created.taskId);
  await task.runPromise;
  assert.equal(value.calls[0].options.model, 'kimi-k3');
  assert.equal(value.calls[0].options.effort, 'medium');

  await assert.rejects(
    () => value.manager.createTask('admin', {
      kind: 'qa', prompt: 'Unavailable.', model: 'offline', effort: 'high',
    }),
    { code: 'MODEL_UNAVAILABLE' },
  );
  const mapped = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Mapped effort.', model: 'qwen', effort: 'max',
  });
  const mappedTask = value.manager.getTask('admin', mapped.taskId);
  await mappedTask.runPromise;
  assert.equal(mappedTask.effort, 'max');
  assert.equal(mappedTask.effectiveEffort, 'xhigh');
  assert.equal(value.calls.at(-1).options.effort, 'xhigh');
});

test('a duplicated real model ID must be selected through its stable catalog ID', async (t) => {
  const project = await temporaryProject('second-mind-duplicate-model-alias-');
  t.after(project.cleanup);
  const manager = new TaskManager({
    ...project.config,
    modelCatalog: [{
      id: 'provider-a-model', label: 'Provider A', actualModel: 'shared-model',
      provider: 'provider-a', efforts: ['default'], defaultEffort: 'default', available: true,
    }, {
      id: 'provider-b-model', label: 'Provider B', actualModel: 'shared-model',
      provider: 'provider-b', efforts: ['default'], defaultEffort: 'default', available: true,
    }],
    embedding: { provider: 'disabled' },
  }, {
    allowLegacyTestEngine: true,
    index: {
      ready: Promise.resolve(),
      status: () => ({ available: true, files: 0, chunks: 0, semanticAvailable: false }),
      search: async () => ({ route: 'keyword', results: [], diagnostics: {} }),
      close: async () => {},
    },
    store: { ready: Promise.resolve(), cleanupDrafts: async () => {} },
    llm: { generate: async () => 'Grounded answer.' },
    conversations: new ConversationStore(project.config.conversationFile),
  });
  t.after(() => manager.close());
  await manager.ready;

  await assert.rejects(
    () => manager.createTask('admin', { kind: 'qa', prompt: 'Ambiguous alias.', model: 'shared-model' }),
    { code: 'INVALID_MODEL' },
  );
  const created = await manager.createTask('admin', {
    kind: 'qa', prompt: 'Stable selection.', model: 'provider-b-model',
  });
  await manager.getTask('admin', created.taskId).runPromise;
  assert.equal(manager.getTask('admin', created.taskId).model.id, 'provider-b-model');

  // Simulate a pre-upgrade no-control conversation, which persisted the
  // literal `default` value before every model exposed the universal tiers.
  manager.conversations.get('admin', created.conversationId).effort = 'default';
  const continued = await manager.createTask('admin', {
    kind: 'qa', prompt: 'Continue legacy default.', conversationId: created.conversationId,
  });
  await manager.getTask('admin', continued.taskId).runPromise;
  assert.equal(manager.getTask('admin', continued.taskId).effort, 'medium');
  assert.equal(manager.getTask('admin', continued.taskId).effectiveEffort, 'default');
});

test('model catalog revision contract accepts current or omitted guards and rejects stale, invalid, or unknown input', async (t) => {
  const value = await fixture(t);
  const status = await value.manager.publicStatus('admin');
  const revision = status.modelCatalogRevision;

  assert.equal(status.taskContractVersion, 2);
  assert.equal(status.capabilities.modelCatalogRevision, true);
  assert.equal(status.buildRevision, 'knowledge-ui-2.1.7');
  assert.match(revision, /^[0-9a-f]{64}$/);

  for (const invalid of [null, 7, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
    await assert.rejects(
      () => value.manager.createTask('admin', {
        kind: 'qa', prompt: 'Validate the request.', modelCatalogRevision: invalid,
      }),
      { code: 'INVALID_MODEL_CATALOG_REVISION', status: 400 },
    );
  }
  for (const invalidBody of [null, [], 'request', 1]) {
    await assert.rejects(
      () => value.manager.createTask('admin', invalidBody),
      { code: 'INVALID_TASK_REQUEST', status: 400 },
    );
  }
  assert.equal(value.calls.length, 0, 'invalid guards must fail before model generation');

  const staleRevision = `${revision[0] === '0' ? '1' : '0'}${revision.slice(1)}`;
  await assert.rejects(
    () => value.manager.createTask('admin', {
      kind: 'qa', prompt: 'Reject stale state.', modelCatalogRevision: staleRevision,
    }),
    { code: 'MODEL_CATALOG_CHANGED', status: 409 },
  );
  await assert.rejects(
    () => value.manager.createTask('admin', {
      kind: 'qa', prompt: 'Reject unknown input.', modelCatalogRevision: revision, unexpected: true,
    }),
    { code: 'UNSUPPORTED_TASK_OPTION', status: 400 },
  );
  assert.equal(value.calls.length, 0, 'stale and unknown input must fail before model generation');

  const guarded = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Use the guarded catalog.', modelCatalogRevision: revision.toUpperCase(),
  });
  await value.manager.getTask('admin', guarded.taskId).runPromise;
  assert.equal(value.manager.getTask('admin', guarded.taskId).status, 'completed');

  const unguarded = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'Allow an older client without the optional guard.',
  });
  await value.manager.getTask('admin', unguarded.taskId).runPromise;
  assert.equal(value.manager.getTask('admin', unguarded.taskId).status, 'completed');
});

test('continuations keep their canonical model and effort before appending a message', async (t) => {
  const value = await fixture(t);
  const created = await value.manager.createTask('admin', {
    kind: 'qa', prompt: 'First turn.', model: 'qwen', effort: 'xhigh',
  });
  await value.manager.getTask('admin', created.taskId).runPromise;
  const conversation = value.conversations.get('admin', created.conversationId);
  const messageCount = conversation.messages.length;

  await assert.rejects(
    () => value.manager.createTask('admin', {
      kind: 'qa',
      prompt: 'Changed settings.',
      conversationId: created.conversationId,
      model: 'kimi',
      effort: 'medium',
    }),
    { code: 'CONVERSATION_SETTINGS_CHANGED' },
  );
  assert.equal(conversation.messages.length, messageCount);

  const continued = await value.manager.createTask('admin', {
    kind: 'qa',
    prompt: 'Same settings.',
    conversationId: created.conversationId,
    model: 'qwen3.8-max',
    effort: 'xhigh',
  });
  await value.manager.getTask('admin', continued.taskId).runPromise;
  // Durable commits replace the in-memory snapshot atomically, so callers must
  // re-read instead of relying on an object reference captured before commit.
  const continuedConversation = value.conversations.get('admin', created.conversationId);
  assert.equal(continuedConversation.messages.length, messageCount + 2);
  assert.equal(conversation.messages.length, messageCount);
});
