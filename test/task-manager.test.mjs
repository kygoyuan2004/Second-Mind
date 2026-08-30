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
  const manager = new TaskManager(config, { index, store, llm, conversations });
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
  conversations.save = () => {
    saveCalls += 1;
    return saveCalls === 2
      ? Promise.reject(new Error('fixture disk failure after generation'))
      : persistedSave();
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
});
