import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.mjs';
import { temporaryProject } from './helpers.mjs';

test('a failed persistence attempt does not poison later conversation saves', async (t) => {
  const project = await temporaryProject('vaultmind-conversations-');
  t.after(project.cleanup);
  const filename = path.join(project.dataDir, 'state', 'conversations.json');
  const store = new ConversationStore(filename);
  await store.ready;
  const conversation = store.create('admin', 'qa', { title: 'Recovery test' });

  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(path.join(path.dirname(filename), 'blocker'), 'fixture');
  await fsp.rm(path.dirname(filename), { recursive: true });
  await fsp.writeFile(path.dirname(filename), 'not-a-directory');
  await assert.rejects(() => store.save());

  await fsp.rm(path.dirname(filename));
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  conversation.messages.push({ role: 'user', content: 'persist me' });
  await store.save();

  const persisted = JSON.parse(await fsp.readFile(filename, 'utf8'));
  assert.equal(persisted.conversations[0].messages[0].content, 'persist me');
});

test('failed delete and clear persistence restore in-memory conversations', async (t) => {
  const project = await temporaryProject('vaultmind-conversation-delete-');
  t.after(project.cleanup);
  const filename = path.join(project.dataDir, 'conversations.json');
  const store = new ConversationStore(filename);
  await store.ready;
  const first = store.create('admin', 'qa', { title: 'First' });
  const second = store.create('admin', 'qa', { title: 'Second' });
  await store.save();

  const blocked = path.join(project.dataDir, 'blocked-parent');
  await fsp.writeFile(blocked, 'not-a-directory');
  store.filename = path.join(blocked, 'conversations.json');
  await assert.rejects(() => store.delete('admin', first.id));
  assert.equal(store.get('admin', first.id).title, 'First');
  await assert.rejects(() => store.clear('admin', 'qa'));
  assert.deepEqual(
    store.list('admin').map((item) => item.id).sort(),
    [first.id, second.id].sort(),
  );
});
