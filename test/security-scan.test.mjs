import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scannerSource = fileURLToPath(new URL('../scripts/scan-secrets.mjs', import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

async function fixtureRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'second-mind-security-scan-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(scannerSource, path.join(root, 'scripts', 'scan-secrets.mjs'));
  const initialized = run('git', ['init', '--quiet'], { cwd: root });
  assert.equal(initialized.status, 0, initialized.stderr);

  return {
    root,
    async write(relative, content) {
      const filename = path.join(root, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, content);
    },
    track(...relativePaths) {
      const added = run('git', ['add', '--', ...relativePaths], { cwd: root });
      assert.equal(added.status, 0, added.stderr);
    },
  };
}

function scan(root, privateTerms = '') {
  return run(process.execPath, ['scripts/scan-secrets.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      SECOND_MIND_PRIVATE_SCAN_TERMS: privateTerms,
      VAULTMIND_PRIVATE_SCAN_TERMS: '',
    },
  });
}

function expectBlocked(result) {
  assert.equal(result.status, 1, `scanner unexpectedly passed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /^Potential publication blockers:/);
}

test('publication scanner reads tracked and untracked source files without printing token values', async (t) => {
  const repository = await fixtureRepository(t);
  const trackedToken = ['sk', 'T'.repeat(24)].join('-');
  const untrackedToken = ['ghp', 'U'.repeat(24)].join('_');
  await repository.write('src/tracked.mjs', `export const value = ${JSON.stringify(trackedToken)};\n`);
  await repository.write('src/untracked.mjs', `export const value = ${JSON.stringify(untrackedToken)};\n`);
  repository.track('scripts/scan-secrets.mjs', 'src/tracked.mjs');

  const result = scan(repository.root);
  expectBlocked(result);
  assert.match(result.stderr, /src\/tracked\.mjs:1: OpenAI-style secret/);
  assert.match(result.stderr, /src\/untracked\.mjs:1: GitHub token/);
  assert.equal(result.stderr.includes(trackedToken), false);
  assert.equal(result.stderr.includes(untrackedToken), false);
});

test('publication scanner blocks private runtime filenames', async (t) => {
  const repository = await fixtureRepository(t);
  await repository.write('.env', 'SAFE_FIXTURE=true\n');
  await repository.write('nested/credentials.json', '{}\n');

  const result = scan(repository.root);
  expectBlocked(result);
  assert.match(result.stderr, /\.env: forbidden private\/runtime path/);
  assert.match(result.stderr, /nested\/credentials\.json: forbidden private\/runtime path/);
});

test('publication scanner rejects wildcard Docker context re-includes', async (t) => {
  const repository = await fixtureRepository(t);
  await repository.write('.dockerignore', '**\n!src/\n!src/**\n');
  repository.track('scripts/scan-secrets.mjs', '.dockerignore');

  const result = scan(repository.root);
  expectBlocked(result);
  assert.match(result.stderr, /\.dockerignore:3: wildcard build-context re-include/);
});

test('publication scanner detects UTF-8 denylist terms and redacts the matched text', async (t) => {
  const repository = await fixtureRepository(t);
  const privateTerm = '秘密客户甲';
  await repository.write('notes/private.md', `# ${privateTerm}\n`);

  const result = scan(repository.root, privateTerm);
  expectBlocked(result);
  assert.match(result.stderr, /notes\/private\.md:1: operator-supplied private term/);
  assert.equal(result.stderr.includes(privateTerm), false);
});

test('publication scanner detects credentials and absolute home paths without echoing either value', async (t) => {
  const repository = await fixtureRepository(t);
  const accessKey = ['AKIA', 'A'.repeat(16)].join('');
  const homePath = `/${['home', 'private-user', 'notes', 'source.md'].join('/')}`;
  await repository.write('config/example.txt', `${accessKey}\n${homePath}\n`);

  const result = scan(repository.root);
  expectBlocked(result);
  assert.match(result.stderr, /config\/example\.txt:1: AWS access key/);
  assert.match(result.stderr, /config\/example\.txt:2: absolute user-home path/);
  assert.equal(result.stderr.includes(accessKey), false);
  assert.equal(result.stderr.includes(homePath), false);
});

function pngChunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

test('publication scanner blocks embedded PNG text metadata', async (t) => {
  const repository = await fixtureRepository(t);
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('tEXt', Buffer.from('Comment\0publication-fixture', 'latin1')),
    pngChunk('IEND'),
  ]);
  await repository.write('public/screenshot.png', png);

  const result = scan(repository.root);
  expectBlocked(result);
  assert.match(result.stderr, /public\/screenshot\.png: embedded PNG metadata \(tEXt\)/);
  assert.equal(result.stderr.includes('publication-fixture'), false);
});
