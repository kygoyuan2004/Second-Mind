import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { VaultStore } from '../src/vault-store.mjs';
import { temporaryProject } from './helpers.mjs';

test('hidden Obsidian settings cannot be read through the Vault gateway', async (t) => {
  const project = await temporaryProject();
  t.after(project.cleanup);
  const store = new VaultStore(project.config);
  await store.ready;
  await fsp.mkdir(path.join(project.vaultPath, '.obsidian', 'plugins', 'livesync'), { recursive: true });
  await fsp.writeFile(path.join(project.vaultPath, '.obsidian', 'plugins', 'livesync', 'data.json'), '{"password":"private"}');
  await assert.rejects(() => store.existingFile('.obsidian/plugins/livesync/data.json'), {
    code: 'VAULT_PATH_EXCLUDED',
  });
});

test('draft preview does not mutate the Vault and confirmation writes it', async (t) => {
  const project = await temporaryProject();
  t.after(project.cleanup);
  const store = new VaultStore(project.config);
  await store.ready;
  const prepared = await store.prepareDated('diary', '2026-08-30');
  const target = path.join(project.vaultPath, prepared.relative);
  const draft = await store.createDraft({
    userId: 'admin',
    kind: 'diary',
    date: prepared.date,
    prepared,
    content: '# 2026-08-30\n\n## Today\n\nBuilt a safe RAG pipeline.',
  });
  assert.equal(await fsp.stat(target).then(() => true, () => false), false);
  const saved = await store.saveDraft('admin', draft.id, { content: draft.content });
  assert.equal(saved.path, prepared.relative);
  assert.match(await fsp.readFile(target, 'utf8'), /safe RAG pipeline/);
});

test('dated draft detects an Obsidian-side concurrent modification', async (t) => {
  const project = await temporaryProject();
  t.after(project.cleanup);
  const store = new VaultStore(project.config);
  await store.ready;
  const target = path.join(project.vaultPath, project.config.paths.plan, '2026-08-30.md');
  await fsp.writeFile(target, '# Original\n');
  const prepared = await store.prepareDated('plan', '2026-08-30');
  const draft = await store.createDraft({
    userId: 'admin', kind: 'plan', date: prepared.date, prepared,
    content: '# Updated plan\n\n- [ ] Ship tests\n',
  });
  await fsp.writeFile(target, '# Edited in Obsidian\n');
  await assert.rejects(() => store.saveDraft('admin', draft.id), { code: 'DRAFT_CONFLICT' });
  assert.equal(await fsp.readFile(target, 'utf8'), '# Edited in Obsidian\n');
});

test('replacing an existing note keeps a private recovery copy of the verified preimage', async (t) => {
  const project = await temporaryProject();
  t.after(project.cleanup);
  const store = new VaultStore(project.config);
  await store.ready;
  const target = path.join(project.vaultPath, project.config.paths.plan, '2026-08-30.md');
  await fsp.writeFile(target, '# Original plan\n\n- [ ] Keep a recovery copy\n');
  const prepared = await store.prepareDated('plan', '2026-08-30');
  const draft = await store.createDraft({
    userId: 'admin', kind: 'plan', date: prepared.date, prepared,
    content: '# Updated plan\n\n- [x] Keep a recovery copy\n',
  });
  const saved = await store.saveDraft('admin', draft.id);
  assert.match(saved.recoveryId, /^[a-f0-9-]{36}$/i);
  const recovery = path.join(project.config.recoveryDir, saved.recoveryId);
  assert.match(await fsp.readFile(path.join(recovery, 'note.md'), 'utf8'), /Original plan/);
  const metadata = JSON.parse(await fsp.readFile(path.join(recovery, 'metadata.json'), 'utf8'));
  assert.equal(metadata.targetRelative, prepared.relative);
  assert.equal(metadata.sourceHash, prepared.sourceHash);
  assert.match(await fsp.readFile(target, 'utf8'), /Updated plan/);
});

test('scratch attachments are staged outside the Vault and copied on confirmation', async (t) => {
  const project = await temporaryProject();
  t.after(project.cleanup);
  const store = new VaultStore(project.config);
  await store.ready;
  const draft = await store.createDraft({
    userId: 'admin', kind: 'scratch', content: '# Retrieval notes\n\nRRF combines rank lists.\n',
    attachments: [{ name: 'example.txt', type: 'text/plain', kind: 'text', buffer: Buffer.from('fixture') }],
  });
  assert.equal(await fsp.stat(path.join(project.vaultPath, draft.targetPath)).then(() => true, () => false), false);
  const result = await store.saveDraft('admin', draft.id);
  const note = await fsp.readFile(path.join(project.vaultPath, result.path), 'utf8');
  assert.match(note, /vaultmind-attachments:start/);
  const asset = path.join(project.vaultPath, project.config.paths.scratch, 'assets', 'Retrieval notes', 'example.txt');
  assert.equal(await fsp.readFile(asset, 'utf8'), 'fixture');
});

test('symbolic links are denied even when their target remains inside the Vault', async (t) => {
  const project = await temporaryProject();
  t.after(project.cleanup);
  const store = new VaultStore(project.config);
  await store.ready;
  await fsp.writeFile(path.join(project.vaultPath, 'real.md'), '# real');
  await fsp.symlink('real.md', path.join(project.vaultPath, 'alias.md'));
  await assert.rejects(() => store.existingFile('alias.md'), { code: 'VAULT_SYMLINK_DENIED' });
});

test('audit failure is reported as a warning after a successful Vault commit', async (t) => {
  const project = await temporaryProject();
  t.after(project.cleanup);
  const store = new VaultStore(project.config);
  await store.ready;
  store.audit = async () => { throw new Error('fixture audit failure'); };
  const prepared = await store.prepareDated('diary', '2026-08-30');
  const draft = await store.createDraft({
    userId: 'admin', kind: 'diary', date: prepared.date, prepared,
    content: '# 2026-08-30\n\nSaved despite audit outage.\n',
  });
  assert.deepEqual(draft.warnings, ['AUDIT_WRITE_FAILED']);
  const saved = await store.saveDraft('admin', draft.id);
  assert.deepEqual(saved.warnings, ['AUDIT_WRITE_FAILED']);
  assert.match(
    await fsp.readFile(path.join(project.vaultPath, saved.path), 'utf8'),
    /Saved despite audit outage/,
  );
});
