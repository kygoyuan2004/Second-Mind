import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  atomicPrivateFile, decodePrivateBytes, encodePrivateBytes, installPrivateCodec,
  isInsidePath, isWindowsPathSegment, pathIdentity, protectPrivateDirectory,
  readPrivateFile, replaceFileAtomically, samePath,
} from '../../platform/private-storage.mjs';
import { RuntimeConfigRegistry, runtimeConfigInternals } from '../../src/runtime-config-registry.mjs';
import { promotePreviousEmbedding, resolveActiveEmbedding } from '../../src/embedding-runtime.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'second-mind-private-'));
  await protectPrivateDirectory(directory);
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

function installTestCodec(t) {
  const key = crypto.randomBytes(32);
  const remove = installPrivateCodec({
    async encrypt(bytes) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    async decrypt(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    },
  });
  t.after(remove);
  return remove;
}

test('Windows identities preserve drive, UNC and sibling boundaries', () => {
  assert.ok(samePath('C:\\用户\\Vault', 'c:\\用户\\VAULT', 'win32'));
  assert.ok(samePath('\\\\?\\C:\\Vault', 'C:\\VAULT', 'win32'));
  assert.equal(pathIdentity('\\\\?\\UNC\\host\\share\\Vault', 'win32'), '\\\\host\\share\\vault');
  assert.ok(isInsidePath('C:\\Vault', 'c:\\vault\\..notes\\a.md', 'win32'));
  assert.equal(isInsidePath('C:\\Vault', 'C:\\Vault-other\\a.md', 'win32'), false);
  assert.equal(isInsidePath('C:\\Vault', 'D:\\Vault\\a.md', 'win32'), false);
  assert.equal(isInsidePath('\\\\server\\one', '\\\\server\\two', 'win32'), false);
  for (const value of ['con', 'NUL.txt', 'com1.md', 'LPT².txt', 'note.md:secret', 'folder.', 'folder ', 'a?b']) {
    assert.equal(isWindowsPathSegment(value), false, value);
  }
  assert.ok(isWindowsPathSegment('中文 笔记.md'));
});

test('atomic replacement handles a sharing violation without deleting the previous document', async (t) => {
  const directory = await fixture(t), destination = path.join(directory, 'state.json'), source = path.join(directory, 'pending.json');
  await atomicPrivateFile(destination, Buffer.from('old'));
  await atomicPrivateFile(source, Buffer.from('new'));
  let attempts = 0;
  await replaceFileAtomically(source, destination, { platform: 'win32', rename: async (...args) => {
    attempts += 1;
    if (attempts === 1) { assert.equal((await readPrivateFile(destination)).toString(), 'old'); throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }); }
    return fs.rename(...args);
  } });
  assert.equal(attempts, 2);
  assert.equal((await readPrivateFile(destination)).toString(), 'new');
});

test('failed writes preserve committed bytes and leave no plaintext temporary file', async (t) => {
  const directory = await fixture(t), filename = path.join(directory, 'config.json');
  await atomicPrivateFile(filename, Buffer.from('original'));
  installTestCodec(t);
  await assert.rejects(decodePrivateBytes(Buffer.from('{"apiKey":"plain"}')), { code: 'PRIVATE_ENCRYPTION_REQUIRED' });
  const encrypted = await encodePrivateBytes(Buffer.from('private-value'));
  assert.equal(encrypted.includes(Buffer.from('private-value')), false);
  assert.equal((await decodePrivateBytes(encrypted)).toString(), 'private-value');
  await fs.link(filename, path.join(directory, 'hard-link'));
  await assert.rejects(atomicPrivateFile(filename, encrypted), { code: 'UNSAFE_PRIVATE_FILE' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['config.json', 'hard-link']);
});

test('runtime managed configuration and recovery backup both encrypt, reload, and recover credentials', async (t) => {
  const directory = await fixture(t);
  installTestCodec(t);
  const managedFile = path.join(directory, 'runtime.json'), secret = 'test-only-private-web-key';
  const options = { managedFile, modelCatalog: [], embedding: { provider: 'disabled' }, webSearch: { enabled: false, apiKey: secret } };
  const registry = new RuntimeConfigRegistry(options);
  await registry.ready;
  const first = await registry.bootstrapManagedV2();
  for (const filename of [managedFile, `${managedFile}.last-good`]) {
    const bytes = await fs.readFile(filename);
    assert.match(bytes.toString(), /^SMENC1\n/);
    assert.equal(bytes.includes(Buffer.from(secret)), false);
  }
  const restarted = new RuntimeConfigRegistry(options);
  assert.equal((await restarted.ready).revision, first.revision);
  assert.equal(restarted.runtimeSnapshot().webSearch.providerConfigs['bailian-mcp'].apiKey, secret);
  await fs.writeFile(managedFile, 'SMENC1\ninvalid');
  const recovered = new RuntimeConfigRegistry(options);
  assert.equal((await recovered.ready).recovered, true);
  assert.equal(recovered.runtimeSnapshot().webSearch.providerConfigs['bailian-mcp'].apiKey, secret);
  const pointer = path.join(directory, 'public-pointer.json');
  await runtimeConfigInternals.atomicPrivateJson(pointer, { slot: 'base' });
  assert.deepEqual(JSON.parse(await fs.readFile(pointer, 'utf8')), { slot: 'base' });
});

test('active and previous embedding credentials stay encrypted across generation rollback', async (t) => {
  const directory = await fixture(t);
  installTestCodec(t);
  const filename = path.join(directory, 'embedding-active.json');
  const embedding = { provider: 'openai-compatible', apiBase: 'https://embedding.example.com/v1', apiKey: 'test-only-embedding-key', model: 'example', dimensions: 8 };
  const entry = (slotId) => ({ slotId, revision: slotId, generation: slotId, activatedAt: new Date().toISOString(), embedding });
  await runtimeConfigInternals.atomicPrivateJson(filename, { version: 1, current: entry('current'), previous: entry('previous') }, { encrypted: true });
  const config = { indexDir: path.join(directory, 'index'), embedding };
  const before = await resolveActiveEmbedding(config, { activeProfileFile: filename });
  assert.equal(before.embedding.apiKey, embedding.apiKey);
  await promotePreviousEmbedding({ activeProfileFile: filename, expectedCurrentRevision: 'current' });
  const after = await resolveActiveEmbedding(config, { activeProfileFile: filename });
  assert.equal(after.slotId, 'previous');
  assert.equal(after.embedding.apiKey, embedding.apiKey);
  assert.equal((await fs.readFile(filename)).includes(Buffer.from(embedding.apiKey)), false);
});
