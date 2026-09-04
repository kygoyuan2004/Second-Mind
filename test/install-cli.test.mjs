import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  copyTreeForBackup,
  finalizeBackup,
  hostPathsOverlap,
  initializeInstance,
  installerInternals,
  InstallerError,
  isHostFilesystemRoot,
  loadSelectedInstance,
  normalizeHostPath,
  ownRuntimeTree,
  parseArguments,
  prepareBackup,
  prepareOperation,
  preflightInstaller,
  probeKnowledgeBasePath,
  probeWritablePath,
  quoteComposeEnv,
} from '../scripts/install.mjs';

const installerScript = path.resolve('scripts/install.mjs');
const strongPassword = 'correct horse battery staple';

async function runInstallerWithInput(arguments_, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installerScript, ...arguments_], {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Installer exited with ${code ?? signal}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

async function fixture(t, label = 'installer') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `second-mind-${label}-`));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'source checkout');
  const stateRoot = path.join(root, 'private config');
  const vault = path.join(root, '知识 Vault');
  await Promise.all([
    fsp.mkdir(repoRoot, { recursive: true }),
    fsp.mkdir(stateRoot, { recursive: true }),
    fsp.mkdir(path.join(vault, '.obsidian'), { recursive: true }),
  ]);
  return {
    root,
    repoRoot,
    stateRoot,
    vault,
    options: {
      repoRoot,
      stateRoot,
      hostOs: process.platform,
      hostRepoRoot: repoRoot,
      hostStateRoot: stateRoot,
      hostHome: root,
      runtimeUid: '1234',
      runtimeGid: '2345',
    },
  };
}

async function initializedFixture(t, label) {
  const setup = await fixture(t, label);
  const result = await initializeInstance({
    ...setup.options,
    nonInteractive: true,
    vault: setup.vault,
    adminPassword: strongPassword,
    port: '9123',
  });
  return { ...setup, result, instanceRoot: path.join(setup.stateRoot, result.instanceId) };
}

test('normalizes and safely quotes Windows paths with spaces and Unicode', () => {
  const absolute = normalizeHostPath('C:\\Users\\Zoë Team\\知识 库', {
    hostOs: 'win32',
    hostRepoRoot: 'C:\\work\\second-mind',
  });
  assert.equal(absolute, 'C:/Users/Zoë Team/知识 库');
  assert.equal(
    normalizeHostPath('.\\Vault Folder', {
      hostOs: 'win32',
      hostRepoRoot: 'D:\\Source Trees\\Second Mind',
    }),
    'D:/Source Trees/Second Mind/Vault Folder',
  );
  assert.equal(
    quoteComposeEnv("C:/Users/O'Brien/$Vault #1"),
    "'C:/Users/O\\'Brien/$Vault #1'",
  );
  assert.throws(() => quoteComposeEnv('line one\nline two'), InstallerError);
});

test('detects host path containment without confusing sibling paths', () => {
  assert.equal(hostPathsOverlap('/srv/second-mind', '/srv/second-mind/state', 'linux'), true);
  assert.equal(hostPathsOverlap('/', '/srv/second-mind', 'linux'), true);
  assert.equal(hostPathsOverlap('/srv/app', '/srv/application-data', 'linux'), false);
  assert.equal(hostPathsOverlap('C:\\Data\\Vault', 'c:\\data\\vault\\Notes', 'win32'), true);
  assert.equal(hostPathsOverlap('C:\\Data\\Vault', 'D:\\Data\\Vault', 'win32'), false);
});

test('recognizes POSIX, drive, and UNC filesystem roots', () => {
  assert.equal(isHostFilesystemRoot('/', 'linux'), true);
  assert.equal(isHostFilesystemRoot('/srv/vault', 'linux'), false);
  assert.equal(isHostFilesystemRoot('C:\\', 'win32'), true);
  assert.equal(isHostFilesystemRoot('c:/', 'win32'), true);
  assert.equal(isHostFilesystemRoot('C:\\Vault', 'win32'), false);
  assert.equal(isHostFilesystemRoot('\\\\server\\share\\', 'win32'), true);
  assert.equal(isHostFilesystemRoot('\\\\server\\share\\Vault', 'win32'), false);
});

test('parses public commands and rejects unknown or malformed options', () => {
  assert.deepEqual(parseArguments(['logs', '--tail', '20', '--no-follow']), {
    command: 'logs',
    options: { tail: '20', noFollow: true },
  });
  assert.deepEqual(parseArguments(['--non-interactive', '--port=9999']), {
    command: 'init',
    options: { nonInteractive: true, port: '9999' },
  });
  assert.deepEqual(parseArguments(['--non-interactive', '--admin-password-stdin']), {
    command: 'init',
    options: { nonInteractive: true, adminPasswordStdin: true },
  });
  assert.deepEqual(parseArguments(['internal-probe-vault', '--source', '/probe']), {
    command: 'internal-probe-vault',
    options: { source: '/probe' },
  });
  assert.deepEqual(parseArguments(['internal-preflight', '--operation', 'init', '--vault', '/vault']), {
    command: 'internal-preflight',
    options: { operation: 'init', vault: '/vault' },
  });
  assert.throws(() => parseArguments(['remove']), /Unsupported installer command/u);
  assert.throws(() => parseArguments(['status', '--tail']), /requires a value/u);
});

test('noninteractive init writes isolated state and never stores passwords in dotenv', async (t) => {
  const setup = await initializedFixture(t, 'state');
  const { result, instanceRoot } = setup;
  assert.match(result.instanceId, /^second-mind-[a-f0-9]{12}$/u);
  assert.equal(result.projectName, result.instanceId);
  assert.equal(result.dataVolume, `${result.instanceId}-data`);
  assert.equal(result.port, 9123);

  const dotenv = await fsp.readFile(path.join(instanceRoot, '.env'), 'utf8');
  const portableVault = normalizeHostPath(setup.vault, setup.options);
  assert.match(dotenv, /^COMPOSE_PROJECT_NAME=second-mind-[a-f0-9]{12}$/mu);
  assert.match(dotenv, /^SECOND_MIND_DATA_VOLUME=second-mind-[a-f0-9]{12}-data$/mu);
  assert.match(dotenv, /^SECOND_MIND_IMAGE=ghcr\.io\/kygoyuan2004\/second-mind:latest$/mu);
  assert.match(dotenv, /^VAULTMIND_UID=1234$/mu);
  assert.match(dotenv, /^VAULTMIND_GID=2345$/mu);
  assert.ok(dotenv.includes(`KNOWLEDGE_BASE_HOST_PATH=${quoteComposeEnv(portableVault)}`));
  assert.ok(dotenv.includes(`VAULT_HOST_PATH=${quoteComposeEnv(portableVault)}`));
  assert.equal(dotenv.includes(strongPassword), false);

  const adminSecret = await fsp.readFile(path.join(instanceRoot, 'secrets', 'admin_password'), 'utf8');
  const sessionSecret = await fsp.readFile(path.join(instanceRoot, 'secrets', 'session_secret'), 'utf8');
  assert.equal(adminSecret, strongPassword);
  assert.ok(sessionSecret.length >= 48);
  if (process.platform !== 'win32') {
    assert.equal((await fsp.stat(path.join(instanceRoot, '.env'))).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(path.join(instanceRoot, 'secrets', 'admin_password'))).mode & 0o777, 0o600);
  }

  const overlay = await fsp.readFile(path.join(instanceRoot, 'compose.instance.yaml'), 'utf8');
  assert.ok(overlay.includes(`name: "${result.dataVolume}"`));
  assert.ok(overlay.includes(`io.second-mind.instance: "${result.instanceId}"`));
  assert.equal((await fsp.readFile(path.join(setup.stateRoot, 'current'), 'utf8')).trim(), result.instanceId);
});

test('instances are unique and a plain init is safely reusable', async (t) => {
  const setup = await initializedFixture(t, 'instances');
  const reused = await initializeInstance(setup.options);
  assert.equal(reused.instanceId, setup.result.instanceId);
  assert.equal(reused.reused, true);

  const nonInteractiveReuse = await initializeInstance({
    ...setup.options,
    nonInteractive: true,
    vault: setup.vault,
    adminPassword: strongPassword,
  });
  assert.equal(nonInteractiveReuse.instanceId, setup.result.instanceId);
  await assert.rejects(
    initializeInstance({
      ...setup.options,
      nonInteractive: true,
      vault: setup.vault,
      adminPassword: 'a different strong password',
    }),
    (error) => error.code === 'INSTANCE_RECONFIGURE_REFUSED',
  );

  const movedPort = await initializeInstance({ ...setup.options, port: '9124' });
  assert.equal(movedPort.port, 9124);
  const dotenv = await fsp.readFile(path.join(setup.instanceRoot, '.env'), 'utf8');
  assert.match(dotenv, /^VAULTMIND_PORT=9124$/mu);

  const second = await initializeInstance({
    ...setup.options,
    newInstance: true,
    nonInteractive: true,
    vault: setup.vault,
    adminPassword: strongPassword,
    port: '9125',
  });
  assert.notEqual(second.instanceId, setup.result.instanceId);
  assert.notEqual(second.dataVolume, setup.result.dataVolume);
  assert.equal((await loadSelectedInstance(setup.options)).metadata.instanceId, second.instanceId);
});

test('init rejects unsafe layouts, weak credentials, and invalid ports', async (t) => {
  const setup = await fixture(t, 'validation');
  await assert.rejects(
    initializeInstance({
      ...setup.options,
      newInstance: true,
      nonInteractive: true,
      vault: path.parse(setup.vault).root,
      adminPassword: strongPassword,
    }),
    (error) => error.code === 'KNOWLEDGE_BASE_ROOT_FORBIDDEN',
  );
  await assert.rejects(
    initializeInstance({
      ...setup.options,
      newInstance: true,
      nonInteractive: true,
      vault: setup.vault,
      adminPassword: 'too short',
    }),
    (error) => error.code === 'PASSWORD_INVALID',
  );
  await assert.rejects(
    initializeInstance({
      ...setup.options,
      newInstance: true,
      nonInteractive: true,
      vault: setup.vault,
      adminPassword: '            ',
    }),
    (error) => error.code === 'PASSWORD_INVALID',
  );
  await assert.rejects(
    initializeInstance({
      ...setup.options,
      newInstance: true,
      nonInteractive: true,
      vault: setup.vault,
      adminPassword: strongPassword,
      port: '70000',
    }),
    (error) => error.code === 'PORT_INVALID',
  );
  await assert.rejects(
    initializeInstance({
      ...setup.options,
      stateRoot: path.join(setup.repoRoot, 'state'),
      hostStateRoot: path.join(setup.repoRoot, 'state'),
      newInstance: true,
      nonInteractive: true,
      vault: setup.vault,
      adminPassword: strongPassword,
    }),
    (error) => error.code === 'STATE_INSIDE_REPOSITORY',
  );
  await assert.rejects(
    initializeInstance({
      ...setup.options,
      newInstance: true,
      nonInteractive: true,
      vault: path.join(setup.stateRoot, 'vault'),
      adminPassword: strongPassword,
    }),
    (error) => error.code === 'STATE_VAULT_OVERLAP',
  );
});

test('state roots must be dedicated before permissions or files are changed', async (t) => {
  const setup = await fixture(t, 'dedicated-state');
  const unrelatedState = path.join(setup.root, 'unrelated existing directory');
  const sentinel = path.join(unrelatedState, 'keep.txt');
  await fsp.mkdir(unrelatedState);
  await fsp.writeFile(sentinel, 'untouched\n');
  await assert.rejects(
    initializeInstance({
      ...setup.options,
      stateRoot: unrelatedState,
      hostStateRoot: unrelatedState,
      newInstance: true,
      nonInteractive: true,
      vault: setup.vault,
      adminPassword: strongPassword,
    }),
    (error) => error.code === 'STATE_ROOT_NOT_DEDICATED',
  );
  assert.equal(await fsp.readFile(sentinel, 'utf8'), 'untouched\n');
  assert.deepEqual(await fsp.readdir(unrelatedState), ['keep.txt']);
});

test('installer-state markers reject symbolic and hard-linked files without touching their targets', async (t) => {
  const setup = await fixture(t, 'state-marker-links');
  const marker = path.join(setup.stateRoot, '.second-mind-installer-state');
  const external = path.join(setup.root, 'external-marker.txt');
  const markerContents = 'second-mind-installer-state-v1\n';
  await fsp.writeFile(external, markerContents, { mode: 0o600 });

  let symlinkCreated = false;
  try {
    await fsp.symlink(external, marker, 'file');
    symlinkCreated = true;
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.diagnostic('Skipping the symbolic marker assertion: file symlinks are not permitted.');
  }
  if (symlinkCreated) {
    await assert.rejects(
      preflightInstaller({ ...setup.options, operation: 'init', vault: setup.vault }),
      (error) => error.code === 'STATE_ROOT_INVALID',
    );
    assert.equal(await fsp.readFile(external, 'utf8'), markerContents);
    await fsp.unlink(marker);
  }

  await fsp.link(external, marker);
  await assert.rejects(
    preflightInstaller({ ...setup.options, operation: 'init', vault: setup.vault }),
    (error) => error.code === 'STATE_ROOT_INVALID',
  );
  assert.equal(await fsp.readFile(external, 'utf8'), markerContents);
  assert.equal((await fsp.lstat(external, { bigint: true })).nlink, 2n);
  await fsp.unlink(marker);

  await fsp.mkdir(marker);
  await assert.rejects(
    preflightInstaller({ ...setup.options, operation: 'init', vault: setup.vault }),
    (error) => error.code === 'STATE_ROOT_INVALID',
  );
  assert.equal(await fsp.readFile(external, 'utf8'), markerContents);
});

test('installer-state marker validation rejects a path swapped between lstat and open', async (t) => {
  const setup = await fixture(t, 'state-marker-race');
  const marker = path.join(setup.stateRoot, '.second-mind-installer-state');
  const displaced = path.join(setup.stateRoot, 'displaced-marker');
  const markerContents = 'second-mind-installer-state-v1\n';
  await fsp.writeFile(marker, markerContents, { mode: 0o600 });
  let replaced = false;
  const racingFileSystem = {
    lstat: (...arguments_) => fsp.lstat(...arguments_),
    async open(filename, flags, mode) {
      await fsp.rename(filename, displaced);
      await fsp.writeFile(filename, markerContents, { mode: 0o600, flag: 'wx' });
      replaced = true;
      return fsp.open(filename, flags, mode);
    },
  };

  await assert.rejects(
    installerInternals.readInstallerStateMarker(marker, racingFileSystem),
    (error) => error.code === 'STATE_ROOT_INVALID'
      && /changed while it was being opened/u.test(error.message),
  );
  assert.equal(replaced, true);
  assert.equal(await fsp.readFile(marker, 'utf8'), markerContents);
  assert.equal(await fsp.readFile(displaced, 'utf8'), markerContents);
});

test('installer-state marker validation rejects a path swapped after its handle opens', {
  skip: process.platform === 'win32',
}, async (t) => {
  const setup = await fixture(t, 'state-marker-post-open-race');
  const marker = path.join(setup.stateRoot, '.second-mind-installer-state');
  const displaced = path.join(setup.stateRoot, 'opened-marker');
  const markerContents = 'second-mind-installer-state-v1\n';
  await fsp.writeFile(marker, markerContents, { mode: 0o600 });
  let lstatCalls = 0;
  const racingFileSystem = {
    async lstat(filename, options) {
      lstatCalls += 1;
      if (lstatCalls === 2) {
        await fsp.rename(filename, displaced);
        await fsp.writeFile(filename, markerContents, { mode: 0o600, flag: 'wx' });
      }
      return fsp.lstat(filename, options);
    },
    open: (...arguments_) => fsp.open(...arguments_),
  };

  await assert.rejects(
    installerInternals.readInstallerStateMarker(marker, racingFileSystem),
    (error) => error.code === 'STATE_ROOT_INVALID'
      && /changed while it was being read/u.test(error.message),
  );
  assert.equal(lstatCalls, 2);
  assert.equal(await fsp.readFile(marker, 'utf8'), markerContents);
  assert.equal(await fsp.readFile(displaced, 'utf8'), markerContents);
});

test('read-only installer preflight resolves the Vault without creating state', async (t) => {
  const setup = await fixture(t, 'preflight-read-only');
  const needsVault = await preflightInstaller({ ...setup.options, operation: 'init' });
  assert.deepEqual(needsVault, { requiresVault: true, knowledgeBasePath: '' });
  assert.deepEqual(await fsp.readdir(setup.stateRoot), []);

  const ready = await preflightInstaller({
    ...setup.options,
    operation: 'init',
    vault: setup.vault,
  });
  assert.equal(ready.requiresVault, false);
  assert.equal(ready.knowledgeBasePath, normalizeHostPath(setup.vault, setup.options));
  assert.deepEqual(await fsp.readdir(setup.stateRoot), []);
});

test('preflight rejects state nested inside a Vault before writing a marker or secrets', async (t) => {
  const setup = await fixture(t, 'preflight-overlap');
  const unsafeState = path.join(setup.vault, 'installer-state');
  await fsp.mkdir(unsafeState);
  const initialMode = (await fsp.stat(unsafeState)).mode;
  await assert.rejects(
    preflightInstaller({
      ...setup.options,
      operation: 'init',
      stateRoot: unsafeState,
      hostStateRoot: unsafeState,
      vault: setup.vault,
    }),
    (error) => error.code === 'STATE_VAULT_OVERLAP',
  );
  assert.deepEqual(await fsp.readdir(unsafeState), []);
  assert.equal((await fsp.stat(unsafeState)).mode, initialMode);
  await assert.rejects(
    initializeInstance({
      ...setup.options,
      newInstance: true,
      nonInteractive: true,
      stateRoot: unsafeState,
      hostStateRoot: unsafeState,
      vault: setup.vault,
      adminPassword: strongPassword,
    }),
    (error) => error.code === 'STATE_VAULT_OVERLAP',
  );
  assert.deepEqual(await fsp.readdir(unsafeState), []);
  assert.equal((await fsp.stat(unsafeState)).mode, initialMode);
});

test('preflight reads an existing selection without changing installer files', async (t) => {
  const setup = await initializedFixture(t, 'preflight-existing');
  const currentFile = path.join(setup.stateRoot, 'current');
  const metadataFile = path.join(setup.instanceRoot, 'instance.json');
  const before = await Promise.all([
    fsp.readFile(currentFile, 'utf8'),
    fsp.readFile(metadataFile, 'utf8'),
    fsp.stat(currentFile),
    fsp.stat(metadataFile),
  ]);
  const result = await preflightInstaller({ ...setup.options, operation: 'status' });
  const after = await Promise.all([
    fsp.readFile(currentFile, 'utf8'),
    fsp.readFile(metadataFile, 'utf8'),
    fsp.stat(currentFile),
    fsp.stat(metadataFile),
  ]);
  assert.equal(result.knowledgeBasePath, normalizeHostPath(setup.vault, setup.options));
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
  assert.equal(after[2].mtimeMs, before[2].mtimeMs);
  assert.equal(after[3].mtimeMs, before[3].mtimeMs);

  await assert.rejects(
    prepareOperation('status', {
      ...setup.options,
      expectedVault: path.join(setup.root, 'different Vault'),
    }),
    (error) => error.code === 'INSTALLER_PREFLIGHT_CHANGED',
  );
  assert.equal((await fsp.stat(currentFile)).mtimeMs, before[2].mtimeMs);
});

test('resolved symlink aliases cannot overlap state or backup destinations', {
  skip: process.platform === 'win32',
}, async (t) => {
  const setup = await fixture(t, 'resolved-overlap');
  await fsp.rm(setup.vault, { recursive: true });
  await fsp.symlink(setup.stateRoot, setup.vault, 'dir');
  await assert.rejects(
    initializeInstance({
      ...setup.options,
      newInstance: true,
      nonInteractive: true,
      vault: setup.vault,
      adminPassword: strongPassword,
    }),
    (error) => error.code === 'STATE_VAULT_OVERLAP',
  );
  assert.deepEqual(await fsp.readdir(setup.stateRoot), []);

  const source = path.join(setup.root, 'copy source');
  const destinationAlias = path.join(setup.root, 'destination alias');
  await fsp.mkdir(source);
  await fsp.symlink(source, destinationAlias, 'dir');
  await assert.rejects(
    copyTreeForBackup(source, path.join(destinationAlias, 'recursive-copy')),
    (error) => error.code === 'BACKUP_RECURSION',
  );
});

test('operation preparation is deterministic and validates private state', async (t) => {
  const setup = await initializedFixture(t, 'operation');
  const operation = await prepareOperation('logs', {
    ...setup.options,
    tail: '432',
    noFollow: true,
  });
  assert.equal(operation.tail, 432);
  assert.equal(operation.follow, false);
  assert.equal(await fsp.readFile(path.join(setup.instanceRoot, 'operation', 'tail'), 'utf8'), '432\n');
  assert.equal(await fsp.readFile(path.join(setup.instanceRoot, 'operation', 'follow'), 'utf8'), 'false\n');

  await fsp.rm(path.join(setup.instanceRoot, 'secrets', 'session_secret'));
  await assert.rejects(
    prepareOperation('status', setup.options),
    (error) => error.code === 'INSTANCE_SECRET_MISSING',
  );
});

test('write probe leaves the knowledge base unchanged', async (t) => {
  const setup = await fixture(t, 'probe');
  await fsp.writeFile(path.join(setup.vault, 'keep.md'), '# keep\n');
  const before = (await fsp.readdir(setup.vault)).sort();
  const result = await probeWritablePath(setup.vault);
  const after = (await fsp.readdir(setup.vault)).sort();
  assert.equal(result.readable, true);
  assert.equal(result.writable, true);
  assert.deepEqual(after, before);
});

test('knowledge-base probe accepts a Vault or its immediate parent only', async (t) => {
  const setup = await fixture(t, 'vault-probe');
  const direct = await probeKnowledgeBasePath(setup.vault);
  assert.equal(direct.obsidianVault, true);

  const parent = path.join(setup.root, 'Vault parent');
  await fsp.mkdir(path.join(parent, 'Immediate Vault', '.obsidian'), { recursive: true });
  assert.equal((await probeKnowledgeBasePath(parent)).obsidianVault, true);

  const empty = path.join(setup.root, 'empty directory');
  const tooDeep = path.join(setup.root, 'too deep');
  await fsp.mkdir(empty);
  await fsp.mkdir(path.join(tooDeep, 'group', 'Nested Vault', '.obsidian'), { recursive: true });
  await assert.rejects(
    probeKnowledgeBasePath(empty),
    (error) => error.code === 'KNOWLEDGE_BASE_LAYOUT_INVALID',
  );
  await assert.rejects(
    probeKnowledgeBasePath(tooDeep),
    (error) => error.code === 'KNOWLEDGE_BASE_LAYOUT_INVALID',
  );
  assert.deepEqual(await fsp.readdir(empty), []);
});

test('knowledge-base probe does not follow a symlink presented as an immediate Vault child', {
  skip: process.platform === 'win32',
}, async (t) => {
  const setup = await fixture(t, 'vault-probe-link');
  const parent = path.join(setup.root, 'linked parent');
  const linkedMarkerVault = path.join(setup.root, 'linked marker Vault');
  await fsp.mkdir(parent);
  await fsp.mkdir(linkedMarkerVault);
  await fsp.symlink(setup.vault, path.join(parent, 'Linked Vault'), 'dir');
  await fsp.symlink(path.join(setup.vault, '.obsidian'), path.join(linkedMarkerVault, '.obsidian'), 'dir');
  await assert.rejects(
    probeKnowledgeBasePath(parent),
    (error) => error.code === 'KNOWLEDGE_BASE_LAYOUT_INVALID',
  );
  await assert.rejects(
    probeKnowledgeBasePath(linkedMarkerVault),
    (error) => error.code === 'KNOWLEDGE_BASE_LAYOUT_INVALID',
  );
});

test('backup copier preserves all Vault content and creates verifiable inventories', async (t) => {
  const setup = await initializedFixture(t, 'backup');
  const dataSource = path.join(setup.root, 'runtime source');
  const vaultSource = path.join(setup.root, 'vault source');
  await fsp.mkdir(path.join(dataSource, 'index'), { recursive: true });
  await fsp.mkdir(path.join(vaultSource, '.obsidian'), { recursive: true });
  await fsp.mkdir(path.join(vaultSource, '空目录'), { recursive: true });
  const binary = Buffer.from([0, 1, 2, 3, 254, 255]);
  await fsp.writeFile(path.join(dataSource, 'index', 'state.bin'), binary);
  await fsp.writeFile(path.join(vaultSource, '笔记 with spaces.md'), '# 永久保留\n');
  await fsp.writeFile(path.join(vaultSource, '.obsidian', 'workspace.json'), '{"ok":true}\n');
  const hasSymlink = process.platform !== 'win32';
  if (hasSymlink) await fsp.symlink('笔记 with spaces.md', path.join(vaultSource, 'latest-note'));

  const prepared = await prepareBackup({ ...setup.options, now: new Date('2026-09-05T01:02:03.004Z') });
  assert.match(prepared.backupName, /^2026-09-05T01-02-03-004Z-[a-f0-9]{6}$/u);
  const backupRoot = path.join(setup.instanceRoot, 'backups', prepared.backupName);
  const dataInventory = await copyTreeForBackup(dataSource, path.join(backupRoot, 'data'));
  const vaultInventory = await copyTreeForBackup(vaultSource, path.join(backupRoot, 'vault'));
  assert.equal(dataInventory.files, 1);
  assert.equal(vaultInventory.files, 2);
  assert.equal(vaultInventory.symlinks, hasSymlink ? 1 : 0);
  assert.deepEqual(await fsp.readFile(path.join(backupRoot, 'data', 'index', 'state.bin')), binary);
  assert.equal(
    await fsp.readFile(path.join(backupRoot, 'vault', '笔记 with spaces.md'), 'utf8'),
    '# 永久保留\n',
  );
  if (hasSymlink) {
    assert.equal(await fsp.readlink(path.join(backupRoot, 'vault', 'latest-note')), '笔记 with spaces.md');
  }
  assert.equal(await fsp.readFile(path.join(vaultSource, '笔记 with spaces.md'), 'utf8'), '# 永久保留\n');

  const expectedHash = createHash('sha256').update(binary).digest('hex');
  const dataRecord = dataInventory.entries.find((entry) => entry.path === 'index/state.bin');
  assert.equal(dataRecord.sha256, expectedHash);
  assert.equal(
    await fsp.readFile(path.join(backupRoot, 'configuration', 'secrets', 'admin_password'), 'utf8'),
    strongPassword,
  );
  const complete = await finalizeBackup(backupRoot);
  assert.equal(complete.status, 'complete');
  assert.equal(JSON.parse(await fsp.readFile(path.join(backupRoot, 'manifest.json'), 'utf8')).status, 'complete');
});

test('runtime ownership helper handles nested trees without following symlinks', {
  skip: process.platform === 'win32',
}, async (t) => {
  const setup = await fixture(t, 'ownership');
  const runtime = path.join(setup.root, 'runtime');
  const external = path.join(setup.root, 'external.txt');
  await fsp.mkdir(path.join(runtime, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(runtime, 'nested', 'item.json'), '{}\n');
  await fsp.writeFile(external, 'outside\n');
  await fsp.symlink(external, path.join(runtime, 'external-link'));
  const result = await ownRuntimeTree(runtime, {
    outputUid: String(process.getuid?.() ?? 0),
    outputGid: String(process.getgid?.() ?? 0),
  });
  assert.equal(result.uid, process.getuid?.() ?? 0);
  assert.equal(await fsp.readFile(external, 'utf8'), 'outside\n');
  assert.equal(path.basename(result.marker), '.second-mind-volume');
  assert.equal(await fsp.readFile(result.marker, 'utf8'), 'second-mind-runtime-volume-v1\n');
  assert.equal((await fsp.stat(runtime)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(result.marker)).mode & 0o777, 0o600);
  assert.deepEqual(await ownRuntimeTree(runtime, {
    outputUid: String(process.getuid?.() ?? 0),
    outputGid: String(process.getgid?.() ?? 0),
  }), result);
});

test('runtime ownership helper rejects symbolic and hard-linked volume markers', {
  skip: process.platform === 'win32',
}, async (t) => {
  const setup = await fixture(t, 'ownership-marker');
  const runtime = path.join(setup.root, 'runtime');
  const external = path.join(setup.root, 'external.txt');
  await fsp.mkdir(runtime);
  await fsp.writeFile(external, 'outside\n');
  await fsp.symlink(external, path.join(runtime, '.second-mind-volume'));
  await assert.rejects(
    () => ownRuntimeTree(runtime, {
      outputUid: String(process.getuid?.() ?? 0),
      outputGid: String(process.getgid?.() ?? 0),
    }),
    { code: 'RUNTIME_VOLUME_MARKER_INVALID' },
  );
  assert.equal(await fsp.readFile(external, 'utf8'), 'outside\n');
  await fsp.unlink(path.join(runtime, '.second-mind-volume'));
  await fsp.link(external, path.join(runtime, '.second-mind-volume'));
  await assert.rejects(
    () => ownRuntimeTree(runtime, {
      outputUid: String(process.getuid?.() ?? 0),
      outputGid: String(process.getgid?.() ?? 0),
    }),
    { code: 'RUNTIME_VOLUME_MARKER_INVALID' },
  );
  assert.equal(await fsp.readFile(external, 'utf8'), 'outside\n');
});

test('the executable CLI accepts noninteractive passwords only through standard input', async (t) => {
  const setup = await fixture(t, 'cli');
  const cleanEnvironment = { ...process.env };
  delete cleanEnvironment.SECOND_MIND_ADMIN_PASSWORD;
  const { stdout, stderr } = await runInstallerWithInput([
    'init',
    '--non-interactive',
    '--admin-password-stdin',
    '--json',
    '--vault', setup.vault,
    '--port', '9234',
    '--repo-root', setup.repoRoot,
    '--state-root', setup.stateRoot,
    '--host-os', process.platform,
    '--host-repo-root', setup.repoRoot,
    '--host-state-root', setup.stateRoot,
    '--runtime-uid', '1000',
    '--runtime-gid', '1000',
  ], `${strongPassword}\n`, { env: cleanEnvironment });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.port, 9234);
  const dotenv = await fsp.readFile(path.join(setup.stateRoot, result.instanceId, '.env'), 'utf8');
  assert.equal(dotenv.includes(strongPassword), false);
});

test('the executable preflight protocol reports a Vault without touching state', async (t) => {
  const setup = await fixture(t, 'preflight-cli');
  const { stdout, stderr } = await runInstallerWithInput([
    'internal-preflight',
    '--operation', 'init',
    '--vault', setup.vault,
    '--repo-root', setup.repoRoot,
    '--state-root', setup.stateRoot,
    '--host-os', process.platform,
    '--host-repo-root', setup.repoRoot,
    '--host-state-root', setup.stateRoot,
  ], 'not consumed');
  assert.equal(stderr, '');
  assert.equal(stdout, `VAULT_PATH=${normalizeHostPath(setup.vault, setup.options)}\n`);
  assert.deepEqual(await fsp.readdir(setup.stateRoot), []);
});

test('Windows PowerShell 5.1 compiles and invokes the native marker APIs', {
  skip: process.platform !== 'win32',
}, async () => {
  const powershell = await fsp.readFile(path.resolve('install.ps1'), 'utf8');
  const typeDefinition = /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/u.exec(powershell)?.[1];
  assert.ok(typeDefinition, 'the installer must contain an embedded native type definition');
  const markerFunctions = powershell.slice(
    powershell.indexOf('function Get-NativeFileInformation'),
    powershell.indexOf('function Assert-DedicatedStateDirectory'),
  );
  assert.match(markerFunctions, /function Read-ValidatedStateMarker/u);
  const smoke = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${typeDefinition}
'@
${markerFunctions}
$marker = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText(
        $marker,
        "second-mind-installer-state-v1\`n",
        [Text.UTF8Encoding]::new($false)
    )
    $value = Read-ValidatedStateMarker $marker
    if ($value -ne "second-mind-installer-state-v1\`n") {
        throw 'The validated marker content changed.'
    }
    Write-Output 'native marker smoke: OK'
} finally {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}
`;

  const result = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(smoke);
  });
  assert.equal(result.code, 0, result.stderr || `PowerShell exited via ${result.signal}`);
  assert.match(result.stdout, /native marker smoke: OK/u);
});

test('host wrappers keep secrets out of command arguments and require no host Node utilities', async () => {
  const [shell, powershell] = await Promise.all([
    fsp.readFile(path.resolve('install.sh'), 'utf8'),
    fsp.readFile(path.resolve('install.ps1'), 'utf8'),
  ]);
  for (const wrapper of [shell, powershell]) {
    assert.doesNotMatch(wrapper, /\bopenssl\b|\bchmod\b/u);
    assert.ok(wrapper.includes('SECOND_MIND_ADMIN_PASSWORD'));
    assert.match(
      wrapper,
      /node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5/u,
    );
    assert.ok(wrapper.includes('internal-probe-path'));
    assert.ok(wrapper.includes('internal-probe-vault'));
    assert.ok(wrapper.includes('internal-copy-tree'));
    assert.ok(wrapper.includes('--admin-password-stdin'));
    assert.ok(wrapper.includes('--expected-vault'));
  }
  assert.doesNotMatch(shell, /--env\s+SECOND_MIND_ADMIN_PASSWORD/u);
  assert.doesNotMatch(powershell, /'--env',\s*'SECOND_MIND_ADMIN_PASSWORD'/u);
  assert.ok(shell.includes('unset SECOND_MIND_ADMIN_PASSWORD'));
  assert.ok(shell.includes("printf '%s' \"$admin_password_input\""));
  assert.ok(powershell.includes('Remove-Item Env:SECOND_MIND_ADMIN_PASSWORD'));
  assert.ok(powershell.includes('$PasswordInput | & docker @InstallerDockerArgs'));
  assert.ok(powershell.includes('SetAccessRuleProtection($true, $false)'));
  assert.ok(powershell.includes('CreateFileW'));
  assert.ok(powershell.includes('GetFinalPathNameByHandleW'));
  assert.ok(powershell.includes('SecondMindInstallerV2.NativePath'));
  assert.equal(powershell.includes('SecondMindInstaller.NativePath'), false);
  assert.ok(powershell.includes('GetFileInformationByHandle'));
  assert.ok(powershell.includes('GetFileType'));
  assert.ok(powershell.includes('NumberOfLinks'));
  assert.ok(powershell.includes('FileIndexHigh'));
  assert.ok(powershell.includes('[uint32] 0x02000000'));
  assert.ok(powershell.includes('[uint32] 0x00200000'));
  assert.ok(powershell.includes('[uint32] 2147483648'));
  assert.ok(powershell.includes('Read-ValidatedStateMarker'));
  assert.doesNotMatch(powershell, /ReadAllText\(\$marker\)/u);
  assert.doesNotMatch(powershell, /ResolveLinkTarget/u);
  const markerValidation = powershell.slice(
    powershell.indexOf('function Read-ValidatedStateMarker'),
    powershell.indexOf('function Assert-DedicatedStateDirectory'),
  );
  const expectedIdentity = markerValidation.indexOf('$expected = Get-NativeFileInformation');
  const openedIdentity = markerValidation.indexOf('$opened = Get-NativeFileInformation');
  const linkedIdentity = markerValidation.indexOf('$linkedAfterRead = Get-NativeFileInformation');
  assert.ok(expectedIdentity >= 0 && expectedIdentity < openedIdentity);
  assert.ok(openedIdentity < linkedIdentity);
  assert.ok(markerValidation.includes('Open-NativeStateMarker $Marker -AllowMissing'));
  assert.equal(markerValidation.includes('Get-Item'), false);

  const shellKnowledgeProbe = shell.slice(
    shell.indexOf('probe_knowledge_base()'),
    shell.indexOf('probe_port()'),
  );
  const shellVolumeProbe = shell.slice(
    shell.indexOf('probe_volume()'),
    shell.indexOf('health_once()'),
  );
  assert.ok(shellKnowledgeProbe.includes('probe_knowledge_base_path'));
  assert.equal(shellKnowledgeProbe.includes('internal-probe-path'), false);
  assert.ok(shellVolumeProbe.includes('internal-probe-path'));
  assert.equal(shellVolumeProbe.includes('internal-probe-vault'), false);

  const powershellKnowledgeProbeStart = powershell.indexOf('function Test-KnowledgeBaseAccess');
  const powershellKnowledgeProbe = powershell.slice(
    powershellKnowledgeProbeStart,
    powershell.indexOf('function Write-Note', powershellKnowledgeProbeStart),
  );
  const powershellVolumeProbe = powershell.slice(
    powershell.indexOf('function Test-RuntimeVolume'),
    powershell.indexOf('$HealthScript'),
  );
  assert.ok(powershellKnowledgeProbe.includes('internal-probe-vault'));
  assert.equal(powershellKnowledgeProbe.includes('internal-probe-path'), false);
  assert.ok(powershellVolumeProbe.includes('internal-probe-path'));
  assert.equal(powershellVolumeProbe.includes('internal-probe-vault'), false);

  assert.ok(shell.indexOf('unset SECOND_MIND_ADMIN_PASSWORD') < shell.indexOf('command -v docker'));
  assert.ok(powershell.indexOf('Remove-Item Env:SECOND_MIND_ADMIN_PASSWORD') < powershell.indexOf('Add-Type'));
  assert.ok(powershell.indexOf('function Resolve-CanonicalDirectory') < powershell.indexOf('Protect-StateDirectory $StateRoot'));
  assert.ok(powershell.indexOf('$StateRoot = Resolve-CanonicalDirectory $StateRoot')
    < powershell.indexOf('Protect-StateDirectory $StateRoot'));

  const shellPreflight = shell.indexOf('preflight_result=$(run_installer_preflight)');
  const shellSeparation = shell.indexOf('host_paths_are_separate "$knowledge_base"');
  const shellMutation = shell.indexOf('installer_docker_arguments=(run --rm');
  assert.ok(shellPreflight >= 0 && shellPreflight < shellSeparation);
  assert.ok(shellSeparation < shellMutation);
  assert.ok(shell.includes('source=$state_root,target=/state,readonly'));

  const powershellPreflight = powershell.indexOf('$PreflightResult = Invoke-InstallerPreflight');
  const powershellSeparation = powershell.indexOf("if ($CommandName -eq 'init') {", powershellPreflight);
  const powershellProtection = powershell.indexOf('Protect-StateDirectory $StateRoot');
  const powershellMutation = powershell.indexOf('$InstallerDockerArgs =');
  assert.ok(powershellPreflight >= 0 && powershellPreflight < powershellSeparation);
  assert.ok(powershellSeparation < powershellProtection);
  assert.ok(powershellProtection < powershellMutation);
  assert.ok(powershell.includes('source=$StateRoot,target=/state,readonly'));

  const shellBackupCopyStart = shell.indexOf('copy_backup_component()');
  const shellBackupCopy = shell.slice(
    shellBackupCopyStart,
    shell.indexOf('case "$command_name" in', shellBackupCopyStart),
  );
  assert.equal(shellBackupCopy.match(/run_docker run --rm/gu)?.length, 1);
  assert.equal(powershellKnowledgeProbe.match(/Test-HostPathsAreSeparate/gu)?.length, 1);
});
