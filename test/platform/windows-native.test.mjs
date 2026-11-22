import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeHelperPath, protectPrivateDirectory, verifyPrivatePath, assertNoReparseTraversal } from '../../platform/private-storage.mjs';
import { VaultPathPolicy } from '../../src/path-policy.mjs';
import { KnowledgeInventories } from '../../src/original/knowledge-inventory.mjs';

const windows = { skip: process.platform !== 'win32' };

test('Windows ACL isolation and junction traversal rejection use the native helper', windows, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'second-mind-win-acl-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await protectPrivateDirectory(directory);
  await verifyPrivatePath(directory);
  const outside = path.join(directory, 'outside'), vault = path.join(directory, '库 有空格');
  await fs.mkdir(outside); await fs.mkdir(vault);
  const link = path.join(vault, 'junction');
  await fs.symlink(outside, link, 'junction');
  await assert.rejects(assertNoReparseTraversal(link));
  const policy = await new VaultPathPolicy(vault, ['PRIVATE']).initialize();
  assert.equal(policy.isExcluded('private/key.md'), true);
  for (const name of ['note.md:stream', 'NUL.md', 'trailing.']) assert.throws(() => policy.assertAllowed(name));
  await fs.writeFile(path.join(vault, '中文 笔记.md'), '# 文本');
  const deepRelative = `${'nested'.repeat(16)}/${'目录'.repeat(48)}/${'deep'.repeat(24)}/long-note.md`;
  const deepFile = path.join(vault, ...deepRelative.split('/'));
  await fs.mkdir(path.dirname(deepFile), { recursive: true });
  await fs.writeFile(deepFile, '# Long path');
  assert.ok(deepFile.length > 260);
  await assertNoReparseTraversal(deepFile);
  assert.equal((await policy.existingFile(deepRelative)).relative, deepRelative);
  const inventories = new KnowledgeInventories({ root: vault, directory: path.join(directory, 'state') });
  await inventories.ready;
  const record = await inventories.create('local', 'conversation', { scope: 'markdown', startMs: null, endMs: null }, 'task');
  await inventories.scan(record);
  assert.equal(record.status, 'completed');
  assert.deepEqual(new Set(record.entries.map((entry) => entry.path)), new Set(['中文 笔记.md', deepRelative]));
  assert.equal(record.excluded.some((entry) => entry.path === 'junction'), true);
});

test('Windows Job Object kills the backend and admitted descendants after the desktop owner disappears', { ...windows, timeout: 15_000 }, async (t) => {
  const options = { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] };
  const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
  const backend = spawn(process.execPath, ['-e', `process.on('message', () => {
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    process.send({ pid: child.pid });
  });`], { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { owner.kill(); backend.kill(); });
  await Promise.all([once(owner, 'spawn'), once(backend, 'spawn')]);
  const helper = spawn(nativeHelperPath(), ['watch', String(owner.pid), String(backend.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => helper.kill());
  let output = '';
  await new Promise((resolve, reject) => {
    helper.on('error', reject);
    helper.on('exit', (code) => reject(new Error(`Native watchdog exited early: ${code}`)));
    helper.stdout.on('data', (chunk) => { output += chunk; if (output.includes('READY\n') || output.includes('READY\r\n')) resolve(); });
  });
  const descendantMessage = once(backend, 'message');
  backend.send({ type: 'start' });
  const [{ pid: descendant }] = await descendantMessage;
  t.after(() => { try { process.kill(descendant); } catch {} });
  process.kill(descendant, 0);
  const ended = once(backend, 'exit');
  owner.kill();
  await ended;
  // Windows Job Object termination can report code 0. Observe termination itself.
  assert.throws(() => process.kill(backend.pid, 0), { code: 'ESRCH' });
  let terminated = false;
  for (let attempt = 0; attempt < 20 && !terminated; attempt += 1) {
    try { process.kill(descendant, 0); await new Promise((resolve) => setTimeout(resolve, 25)); }
    catch (error) { if (error.code !== 'ESRCH') throw error; terminated = true; }
  }
  assert.equal(terminated, true, 'A descendant must not survive the desktop Job Object.');
});
