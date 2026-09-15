import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { migrateSdkState } from '../src/sdk-state-migration.mjs';
import { SdkKnowledgeStore } from '../src/sdk-knowledge-store.mjs';
import { temporaryProject } from './helpers.mjs';

async function fixture(t) {
  const p = await temporaryProject('sdk-migration-');
  t.after(() => p.cleanup());
  await fs.mkdir(p.config.draftDir, { recursive: true });
  const config = { ...p.config, dataDir: path.join(p.dataDir, 'sdk-v1'),
    draftDir: path.join(p.dataDir, 'sdk-v1/drafts'),
    conversationFile: path.join(p.dataDir, 'sdk-v1/conversations.json') };
  const id = crypto.randomUUID();
  const old = { version: 3, conversations: [{ id, userId: 'admin', kind: 'qa', model: 'qwen', effort: 'xhigh',
    createdAt: '2026-09-01T00:00:00Z', messages: [{ role: 'user', content: '公开历史问题', at: '2026-09-01T00:00:00Z' },
      { role: 'assistant', content: [{ type: 'text', text: '公开历史答案' }] }] }] };
  const bytes = Buffer.from(JSON.stringify(old));
  await fs.writeFile(p.config.conversationFile, bytes);
  const draftId = crypto.randomUUID();
  const draft = { id: draftId, userId: 'admin', kind: 'scratch', title: '旧草稿', targetRelative: 'Second-Mind/Inbox/旧草稿.md',
    content: '# 旧草稿\n\n旧内容', attachments: [], createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00Z' };
  await fs.mkdir(path.join(p.config.draftDir, draftId));
  await fs.writeFile(path.join(p.config.draftDir, draftId, 'draft.json'), JSON.stringify(draft));
  return { p, config, bytes, id, draftId };
}

test('migration preserves bytes, conversations, drafts and survives a missing final receipt', async (t) => {
  const { p, config, bytes, id, draftId } = await fixture(t);
  const receipt = await migrateSdkState(p.config, config);
  assert.equal(receipt.conversations, 1);
  assert.equal(receipt.drafts, 1);
  assert.deepEqual(await fs.readFile(p.config.conversationFile), bytes);
  const imported = JSON.parse(await fs.readFile(config.conversationFile));
  assert.equal(imported.conversations[0].id, id);
  assert.equal(imported.conversations[0].sdkSessionId, null);
  assert.equal(imported.conversations[0].legacyContextPending, true);
  assert.deepEqual(imported.conversations[0].messages.map((m) => m.text), ['公开历史问题', '公开历史答案']);
  assert.equal(JSON.parse(await fs.readFile(path.join(config.draftDir, draftId, 'draft.json'))).legacyDraft, true);
  assert.deepEqual(await migrateSdkState(p.config, config), receipt);
  await fs.rm(path.join(config.dataDir, 'migration-receipt.json'));
  const resumed = await migrateSdkState(p.config, config);
  assert.equal(resumed.conversations, 1);
  assert.equal(resumed.drafts, 1);
  assert.deepEqual(await fs.readFile(p.config.conversationFile), bytes);
  if (process.platform !== 'win32') assert.equal((await fs.stat(config.conversationFile)).mode & 0o777, 0o600);
});

test('migration rejects symlink attachments and resumes once the unsafe source is removed', async (t) => {
  const { p, config, draftId } = await fixture(t);
  const bad = path.join(p.config.draftDir, draftId, 'linked.bin');
  await fs.symlink(p.config.conversationFile, bad);
  await assert.rejects(migrateSdkState(p.config, config), /LEGACY_DRAFT_UNSAFE_FILE/);
  await fs.rm(bad);
  const receipt = await migrateSdkState(p.config, config);
  assert.equal(receipt.conversations, 1);
  assert.equal(receipt.drafts, 1);
});

test('empty Vault stays unchanged until confirm, then original dated note layout and recovery work', async (t) => {
  const p = await temporaryProject('sdk-empty-vault-');
  t.after(() => p.cleanup());
  const store = new SdkKnowledgeStore(p.config, p.config, null);
  await store.initialize();
  const prepared = await store.prepareDatedDocument('diary', '2026-09-15');
  assert.equal(prepared.relative, 'daily_doc/日记/2026-09-15.md');
  const draft = await store.createDraft({ userId: 'admin', kind: 'diary', date: '2026-09-15',
    content: '# 日记\n\n公开正文', prepared, attachments: [] });
  assert.deepEqual(await fs.readdir(p.vaultPath), []);
  await store.saveDraft('admin', draft.id, { content: '# 日记\n\n修改后正文' });
  assert.match(await fs.readFile(path.join(p.vaultPath, prepared.relative), 'utf8'), /修改后正文/);
  const update = await store.createDraft({ userId: 'admin', kind: 'diary', date: '2026-09-15',
    content: '# 更新', prepared: await store.prepareDatedDocument('diary', '2026-09-15'), attachments: [] });
  await store.saveDraft('admin', update.id);
  const backups = await fs.readdir(store.recoveryRoot);
  assert.equal(backups.length, 1);
  assert.match(await fs.readFile(path.join(store.recoveryRoot, backups[0], 'before.md'), 'utf8'), /修改后正文/);
});

test('untrusted draft metadata cannot create paths outside the permitted write directory', async (t) => {
  const p = await temporaryProject('sdk-draft-boundary-');
  t.after(() => p.cleanup());
  const store = new SdkKnowledgeStore(p.config, p.config, null);
  await store.initialize();
  const id = crypto.randomUUID();
  await fs.mkdir(path.join(store.draftRoot, id));
  const file = path.join(store.draftRoot, id, 'draft.json');
  for (const targetRelative of ['../escape/new.md', 'private/new/note.md', '/tmp/escape/note.md']) {
    await fs.writeFile(file, JSON.stringify({ id, userId: 'admin', kind: 'diary', targetRelative, expiresAt: '2099-01-01' }));
    await assert.rejects(store.saveDraft('admin', id));
  }
  assert.deepEqual(await fs.readdir(p.vaultPath), []);
});
