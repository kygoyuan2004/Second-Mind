import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VaultPathPolicy } from '../src/path-policy.mjs';
import { resolveSource } from '../src/source-resolver.mjs';

test('source resolution prefers exact files and only resolves unambiguous readable suffixes', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'source-resolver-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const files = ['Note.md', 'Learning/Note.md', 'Diary/草稿/汇报 09.md', 'A/Shared.md', 'B/Shared.md', '.obsidian/Hidden.md'];
  for (const name of files) {
    await fsp.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fsp.writeFile(path.join(root, name), '# synthetic source');
  }
  const policy = new VaultPathPolicy(root, ['.obsidian']);
  await policy.initialize();
  const resolve = (value) => resolveSource(value, {
    existingFile: (name) => policy.existingFile(name), walk: () => policy.walk(),
  });
  assert.deepEqual(await resolve('Note.md'), { path: 'Note.md' });
  assert.deepEqual(await resolve('Note'), { path: 'Note.md' });
  assert.deepEqual(await resolve('草稿/汇报 09.md'), { path: 'Diary/草稿/汇报 09.md' });
  assert.deepEqual(await resolve('汇报 09'), { path: 'Diary/草稿/汇报 09.md' });
  assert.deepEqual(await resolve('Shared.md'), { candidates: ['A/Shared.md', 'B/Shared.md'] });
  for (const invalid of ['', '/Note.md', '../Note.md', 'A/../Note.md', 'A//Note.md', 'A\\Note.md', 'https://example.test/Note.md', 'A\0.md']) {
    await assert.rejects(resolve(invalid), { status: 400 });
  }
  await assert.rejects(resolve('.obsidian/Hidden.md'), { status: 403 });
  await assert.rejects(resolve('Hidden.md'), { status: 404 });
  await assert.rejects(resolve('absent.md'), { status: 404 });
  if (process.platform !== 'win32') {
    await fsp.symlink(path.join(root, 'Note.md'), path.join(root, 'Alias.md'));
    await assert.rejects(resolve('Alias.md'), { code: 'VAULT_SYMLINK_DENIED' });
  }
});
