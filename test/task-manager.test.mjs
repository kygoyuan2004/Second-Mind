import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { temporaryProject } from './helpers.mjs';

test('conversation persistence failure rolls back the queued task and allows retry', async (t) => {
  const project = await temporaryProject('vaultmind-task-rollback-');
  t.after(project.cleanup);
  const filename = path.join(project.dataDir, 'state', 'conversations.json');
  const conversations = new ConversationStore(filename);
  await conversations.ready;
  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 0, chunks: 0, semanticAvailable: false }),
    search: async () => ({ results: [], diagnostics: {} }),
    close: async () => {},
  };
  const store = {
    ready: Promise.resolve(),
    cleanupDrafts: async () => {},
  };
  const llm = {
    generate: async (_messages, options) => {
      options.onToken?.('fixture answer');
      return 'fixture answer';
    },
  };
  const config = {
    ...project.config,
    appName: 'Fixture', vaultLabel: 'Fixture Vault', timezone: 'UTC',
    llm: { provider: 'openai-compatible', model: 'fixture-model' },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 3, maxContextChars: 2_000 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
  const manager = new TaskManager(config, {
    index, store, llm, conversations, allowLegacyTestEngine: true,
  });
  t.after(() => manager.close());
  await manager.ready;

  await fsp.rm(path.dirname(filename), { recursive: true });
  await fsp.writeFile(path.dirname(filename), 'not-a-directory');
  await assert.rejects(
    () => manager.createTask('admin', { kind: 'qa', prompt: 'first attempt' }),
    { code: 'CONVERSATION_PERSIST_FAILED' },
  );
  assert.equal(manager.tasks.size, 0);
  assert.equal(conversations.list('admin').length, 0);

  await fsp.rm(path.dirname(filename));
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const retry = await manager.createTask('admin', { kind: 'qa', prompt: 'retry' });
  const task = manager.getTask('admin', retry.taskId);
  await task.runPromise;
  assert.equal(task.status, 'completed');

  const persistedSave = conversations.save.bind(conversations);
  let saveCalls = 0;
  conversations.save = (snapshot) => {
    saveCalls += 1;
    return saveCalls === 2
      ? Promise.reject(new Error('fixture disk failure after generation'))
      : persistedSave(snapshot);
  };
  const generated = await manager.createTask('admin', { kind: 'qa', prompt: 'must persist before done' });
  const generatedTask = manager.getTask('admin', generated.taskId);
  await generatedTask.runPromise;
  assert.equal(generatedTask.status, 'failed');
  assert.equal(generatedTask.events.at(-1).type, 'done');
  assert.equal(generatedTask.events.at(-1).data.status, 'failed');
  assert.match(generatedTask.events.at(-2).data.message, /could not be persisted/i);
  assert.deepEqual(
    conversations.get('admin', generated.conversationId).messages.map((message) => message.role),
    ['user'],
  );

  conversations.save = persistedSave;
  let releaseInitialCommit;
  let initialCommitStarted;
  const initialCommitGate = new Promise((resolve) => { releaseInitialCommit = resolve; });
  const enteredInitialCommit = new Promise((resolve) => { initialCommitStarted = resolve; });
  let held = true;
  conversations.save = async (snapshot) => {
    if (held) {
      held = false;
      initialCommitStarted();
      await initialCommitGate;
    }
    return persistedSave(snapshot);
  };
  const pendingCreate = manager.createTask('admin', { kind: 'qa', prompt: 'pending atomic create' });
  await enteredInitialCommit;
  assert.equal((await manager.publicStatus('admin')).activeTask, null);
  await assert.rejects(
    () => manager.createTask('admin', { kind: 'qa', prompt: 'second tab' }),
    { code: 'TASK_ALREADY_RUNNING' },
  );
  releaseInitialCommit();
  const atomicCreate = await pendingCreate;
  const atomicTask = manager.getTask('admin', atomicCreate.taskId);
  await atomicTask.runPromise;
  assert.equal(atomicTask.status, 'completed');
});

test('close waits for a gated initial commit and no task can launch after shutdown', async (t) => {
  const project = await temporaryProject('vaultmind-task-close-race-');
  t.after(project.cleanup);
  const conversations = new ConversationStore(path.join(project.dataDir, 'state', 'conversations.json'));
  await conversations.ready;

  let releaseSave;
  let notifySaveStarted;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise((resolve) => { notifySaveStarted = resolve; });
  const persistedSave = conversations.save.bind(conversations);
  let gateFirstSave = true;
  conversations.save = async (snapshot) => {
    if (gateFirstSave) {
      gateFirstSave = false;
      notifySaveStarted();
      await saveGate;
    }
    return persistedSave(snapshot);
  };

  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 0, chunks: 0, semanticAvailable: false }),
    search: async () => ({ results: [], diagnostics: {} }),
    close: async () => {},
  };
  const store = { ready: Promise.resolve(), cleanupDrafts: async () => {} };
  const llm = { generate: async () => 'unused fixture answer' };
  const config = {
    ...project.config,
    appName: 'Fixture', vaultLabel: 'Fixture Vault', timezone: 'UTC',
    llm: { provider: 'openai-compatible', model: 'fixture-model' },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 3, maxContextChars: 2_000 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
  const manager = new TaskManager(config, { index, store, llm, conversations });
  await manager.ready;

  let runStarts = 0;
  manager.run = async (task) => {
    runStarts += 1;
    if (task.abortController.signal.aborted) return;
    await new Promise((resolve) => {
      task.abortController.signal.addEventListener('abort', resolve, { once: true });
    });
  };

  const pendingCreate = manager.createTask('admin', { kind: 'qa', prompt: 'commit is still pending' });
  await saveStarted;

  let closeSettled = false;
  const closing = manager.close().then(() => { closeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false, 'close must wait for the in-flight initial commit');
  await assert.rejects(
    () => manager.createTask('another-user', { kind: 'qa', prompt: 'too late' }),
    { status: 503, code: 'SERVER_CLOSING' },
  );

  releaseSave();
  await pendingCreate;
  await closing;
  assert.equal(runStarts, 1, 'the pre-shutdown creation may attach exactly one run');
  assert.equal(manager.tasks.size, 0);

  const startsAfterClose = runStarts;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runStarts, startsAfterClose, 'nothing may launch after close resolves');
  await assert.rejects(
    () => manager.createTask('admin', { kind: 'qa', prompt: 'server is closed' }),
    { status: 503, code: 'SERVER_CLOSING' },
  );
  await manager.close();
});

test('close drains an early task admission before runtime refresh can create work', async (t) => {
  const project = await temporaryProject('vaultmind-task-early-close-race-');
  t.after(project.cleanup);
  const conversations = new ConversationStore(path.join(project.dataDir, 'state', 'conversations.json'));
  await conversations.ready;
  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 0, chunks: 0, semanticAvailable: false }),
    search: async () => ({ results: [], diagnostics: {} }),
    close: async () => {},
  };
  const store = { ready: Promise.resolve(), cleanupDrafts: async () => {} };
  const llm = { generate: async () => 'must not run' };
  const config = {
    ...project.config,
    appName: 'Fixture', vaultLabel: 'Fixture Vault', timezone: 'UTC',
    llm: { provider: 'openai-compatible', model: 'fixture-model' },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 3, maxContextChars: 2_000 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
  const manager = new TaskManager(config, { index, store, llm, conversations });
  await manager.ready;

  let releaseRefresh;
  let notifyRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const refreshStarted = new Promise((resolve) => { notifyRefresh = resolve; });
  manager.refreshRuntimeConfiguration = async () => {
    notifyRefresh();
    await refreshGate;
  };

  const creating = manager.createTask('admin', { kind: 'qa', prompt: 'admitted before close' });
  await refreshStarted;
  let closeSettled = false;
  const closing = manager.close().then(() => { closeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  releaseRefresh();
  await assert.rejects(creating, { code: 'SERVER_CLOSING' });
  await closing;
  assert.equal(manager.tasks.size, 0);
  assert.equal(manager.pendingCreations.size, 0);
});

test('task creation releases pinned web leases when the retrieval snapshot cannot be acquired', async (t) => {
  const project = await temporaryProject('vaultmind-task-snapshot-failure-');
  t.after(project.cleanup);
  const conversations = new ConversationStore(path.join(project.dataDir, 'state', 'conversations.json'));
  await conversations.ready;
  const indexError = Object.assign(new Error('fixture snapshot unavailable'), {
    code: 'INDEX_SNAPSHOT_UNAVAILABLE',
  });
  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 0, chunks: 0, semanticAvailable: false }),
    acquireSnapshot: () => { throw indexError; },
    close: async () => {},
  };
  const store = { ready: Promise.resolve(), cleanupDrafts: async () => {} };
  const llm = { generate: async () => 'unused fixture answer' };
  let searchClosed = 0;
  let extractClosed = 0;
  const webSearch = {
    publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
    acquireForTask: async () => ({
      provider: 'bailian-mcp',
      publicStatus: () => ({ enabled: true, configured: true, provider: 'bailian-mcp' }),
      searchMany: async () => ({ results: [], attempts: [], errors: [] }),
      close: async () => { searchClosed += 1; },
    }),
  };
  const responsesExtractor = {
    acquireForTask: async () => ({
      publicStatus: () => ({ enabled: false, configured: false, provider: 'bailian-responses' }),
      extract: async () => ({ documents: [], attempts: [], errors: [] }),
      close: async () => { extractClosed += 1; },
    }),
  };
  const config = {
    ...project.config,
    appName: 'Fixture', vaultLabel: 'Fixture Vault', timezone: 'UTC',
    llm: { provider: 'openai-compatible', model: 'fixture-model' },
    embedding: { provider: 'disabled' },
    webSearch: { enabled: true, provider: 'bailian-mcp' },
    retrieval: { topK: 3, maxContextChars: 2_000 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
  const manager = new TaskManager(config, {
    index, store, llm, conversations, webSearch, responsesExtractor,
  });
  t.after(() => manager.close());
  await manager.ready;

  await assert.rejects(
    () => manager.createTask('admin', {
      kind: 'qa', prompt: 'fixture query', webSearch: true,
    }),
    { code: 'INDEX_SNAPSHOT_UNAVAILABLE' },
  );
  assert.equal(searchClosed, 1);
  assert.equal(extractClosed, 1);
  assert.equal(manager.tasks.size, 0);
  assert.equal(conversations.list('admin').length, 0);
});

test('task failure events discard provider endpoints and credential-shaped details', async (t) => {
  const project = await temporaryProject('vaultmind-task-public-error-');
  t.after(project.cleanup);
  const conversations = new ConversationStore(path.join(project.dataDir, 'state', 'conversations.json'));
  await conversations.ready;
  const privateEndpoint = 'https://private-provider.example/v1';
  const privateCredential = 'fixture-secret-value-12345';
  const providerFailure = Object.assign(
    new Error(`request to ${privateEndpoint} failed with api_key=${privateCredential}`),
    { code: 'LLM_NETWORK_ERROR' },
  );
  const index = {
    ready: Promise.resolve(),
    status: () => ({ available: true, files: 0, chunks: 0, semanticAvailable: false }),
    search: async () => ({ results: [], diagnostics: {} }),
    close: async () => {},
  };
  const store = { ready: Promise.resolve(), cleanupDrafts: async () => {} };
  const llm = { generate: async () => { throw providerFailure; } };
  const config = {
    ...project.config,
    appName: 'Fixture', vaultLabel: 'Fixture Vault', timezone: 'UTC',
    llm: { provider: 'openai-compatible', model: 'fixture-model' },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 3, maxContextChars: 2_000 },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
  const manager = new TaskManager(config, {
    index, store, llm, conversations, allowLegacyTestEngine: true,
  });
  t.after(() => manager.close());
  await manager.ready;

  const created = await manager.createTask('admin', { kind: 'qa', prompt: 'safe failure boundary' });
  const task = manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'failed');
  const terminalEvents = task.events.filter((event) => ['task_error', 'done'].includes(event.type));
  assert.deepEqual(terminalEvents.map((event) => event.data.code), [
    'LLM_NETWORK_ERROR', 'LLM_NETWORK_ERROR',
  ]);
  const serialized = JSON.stringify(terminalEvents);
  assert.equal(serialized.includes(privateEndpoint), false);
  assert.equal(serialized.includes(privateCredential), false);
  assert.match(terminalEvents[0].data.message, /model provider/i);
});
