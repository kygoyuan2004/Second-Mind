import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { resolveDesktopResources, runtimeEnvironment, assertPackagedResources } from '../../desktop/resources.mjs';
import { readMediaModelStatus, prepareMediaModel } from '../../desktop/media-model.mjs';
import { spawnHidden, terminateProcessTree } from '../../platform/process-tree.mjs';

test('packaged interpreters and helpers are real resource paths and model cache is user-owned', () => {
  const resources = resolveDesktopResources({ appRoot: '/installed/resources/app.asar', resourcesPath: '/installed/resources', packaged: true });
  assert.equal(resources.appRoot, path.join('/installed/resources', 'backend'));
  for (const key of ['node', 'python', 'ffmpeg', 'platformHelper']) assert.equal(resources[key].includes('app.asar'), false);
  const env = runtimeEnvironment({ resources, stateRoot: '/user/SecondMind' });
  assert.equal(env.KNOWLEDGE_VIDEO_YTDLP_MODULE, '1');
  assert.equal(env.KNOWLEDGE_SPEECH_MODEL_DIR, path.join('/user/SecondMind', 'models', 'faster-whisper-small'));
  assert.equal(env.SECOND_MIND_PLATFORM_HELPER, resources.platformHelper);
  assert.throws(() => assertPackagedResources(resources), /缺少运行组件/);
});

test('reading model status before first use does not create files or start downloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'second-mind-model-'));
  try {
    assert.equal((await readMediaModelStatus(root)).state, 'not-downloaded');
    assert.deepEqual(await fs.readdir(root), []);
    await fs.mkdir(path.join(root, 'models'));
    await fs.writeFile(path.join(root, 'models', 'status.json'), JSON.stringify({ state: 'downloading', downloadedBytes: 100, totalBytes: 1000 }));
    assert.equal((await readMediaModelStatus(root)).downloadedBytes, 100);
    await fs.writeFile(path.join(root, 'models', 'status.json'), '{interrupted');
    assert.equal((await readMediaModelStatus(root)).state, 'not-downloaded');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('task cancellation stops the media process tree', { timeout: 15_000 }, async () => {
  const grandchild = 'setInterval(() => {}, 1000)';
  const source = `const { spawn } = require('node:child_process'); const p = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', windowsHide: true }); console.log(p.pid); setInterval(() => {}, 1000);`;
  const child = spawnHidden(process.execPath, ['-e', source], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let descendant;
  try {
    descendant = Number((await once(child.stdout, 'data'))[0].toString().trim());
    assert.ok(descendant > 0);
    const closed = once(child, 'close');
    await terminateProcessTree(child);
    await closed;
    let alive = true;
    for (let attempts = 0; attempts < 40; attempts++) {
      try {
        process.kill(descendant, 0);
        if (process.platform === 'linux' && (await fs.readFile(`/proc/${descendant}/stat`, 'utf8')).split(') ')[1].startsWith('Z')) { alive = false; break; }
      } catch { alive = false; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, 'descendant survives cancellation');
  } finally {
    await terminateProcessTree(child);
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
  }
});

test('a missing media interpreter reports a retryable state instead of remaining downloading', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'second-mind-model-start-'));
  try {
    const resources = resolveDesktopResources({ appRoot: root });
    resources.python = path.join(root, 'missing-python.exe');
    await assert.rejects(prepareMediaModel({ resources, stateRoot: root }), /运行组件/);
    assert.equal((await readMediaModelStatus(root)).state, 'error');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('release lock contains Windows wheels and pinned archives, with exact original media versions', async () => {
  const lock = JSON.parse(await fs.readFile(new URL('../../scripts/windows-runtime-lock.json', import.meta.url), 'utf8'));
  for (const item of [...lock.archives, ...lock.wheels]) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.equal(new URL(item.url).protocol, 'https:');
  }
  for (const name of ['faster-whisper', 'ctranslate2', 'av', 'huggingface_hub', 'yt-dlp', 'colorama']) {
    assert.ok(lock.wheels.some((wheel) => wheel.name.toLowerCase().replaceAll('_', '-') === name.replaceAll('_', '-')), name);
  }
  assert.ok(lock.wheels.every((wheel) => /(?:win_amd64|any)\.whl$/.test(wheel.filename)));
});
