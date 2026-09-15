#!/usr/bin/env node
// Explicit integration gate: isolated public fixtures, real Docker, no model requests.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'second-mind-install-'));
const state = path.join(root, '私有 config');
const vault = path.join(root, '演示 Vault');
const restoredVault = path.join(root, '恢复 Vault');
const password = `synthetic-${randomBytes(24).toString('hex')}`;
const webKey = `synthetic-web-${randomBytes(24).toString('hex')}`;
const image = process.env.SECOND_MIND_TEST_IMAGE || 'second-mind:ci';
const env = { ...process.env, SECOND_MIND_CONFIG_HOME: state, SECOND_MIND_IMAGE: image };
const instances = [];
await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
await fs.mkdir(restoredVault);
await fs.writeFile(path.join(vault, '公开 note.md'), '# Public demo\n\nThe plan is unfinished.\n');
async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return String(value);
}
async function command(file, args, extra = {}) {
  try { return await exec(file, args, { cwd: repo, env, timeout: 600_000, maxBuffer: 20 * 1024 * 1024, ...extra }); }
  catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`.replaceAll(password, '[synthetic password]').replaceAll(webKey, '[synthetic key]');
    throw new Error(`Integration command failed: ${file} ${args[0] || ''}\n${output}`);
  }
}
async function installer(...args) {
  process.stdout.write(`Installer gate: ${args[0]}\n`);
  const file = process.platform === 'win32' ? 'pwsh' : 'bash';
  const prefix = process.platform === 'win32' ? ['-NoProfile', '-File', path.join(repo, 'install.ps1')] : [path.join(repo, 'install.sh')];
  return command(file, [...prefix, ...args], { env: { ...env, ...(args[0] === 'init' ? { SECOND_MIND_ADMIN_PASSWORD: password } : {}) } });
}
async function current() {
  const id = (await fs.readFile(path.join(state, 'current'), 'utf8')).trim();
  const metadata = JSON.parse(await fs.readFile(path.join(state, id, 'instance.json'), 'utf8'));
  if (!instances.some((v) => v.instanceId === id)) instances.push(metadata);
  return metadata;
}
async function client(instance) {
  const base = `http://127.0.0.1:${instance.port}`;
  const headers = { origin: base, 'content-type': 'application/json', 'x-vaultmind-request': '1' };
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password }) });
  assert.equal(login.status, 200, 'Restored administrator credentials must work');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return async (endpoint, options = {}) => {
    const response = await fetch(`${base}${endpoint}`, { ...options, headers: { ...headers, cookie }, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.ok, true, `${endpoint}: ${response.status} ${response.ok ? '' : (await response.clone().text()).replaceAll(password, '[synthetic password]').replaceAll(webKey, '[synthetic key]')}`);
    return response.json();
  };
}
async function container(instance) {
  return (await command('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${instance.projectName}`])).stdout.trim();
}
try {
  await installer('init', '--non-interactive', '--vault', vault, '--port', await port());
  const source = await current();
  let call = await client(source);
  assert.equal((await call('/api/knowledge/status')).executor, 'claude-agent-sdk');
  const config = await call('/api/admin/runtime-config');
  const saved = await call('/api/admin/runtime-config', { method: 'PUT', body: JSON.stringify({
    expectedRevision: config.revision, adminPassword: password,
    branding: { appName: 'Installer demo workspace', vaultLabel: '公开演示资料' },
  }) });
  assert.equal(saved.branding.appName, 'Installer demo workspace');
  assert.equal(JSON.stringify(saved).includes(webKey), false);
  await command('docker', ['exec', await container(source), 'node', '-e', "require('fs').writeFileSync('/app/data/installer-demo-session.json',JSON.stringify({conversation:'synthetic session',draft:'synthetic pending draft'}))"]);
  await installer('restart');
  call = await client(source);
  assert.equal((await call('/api/admin/runtime-config')).branding.appName, 'Installer demo workspace');
  await installer('status');
  await installer('logs', '--no-follow', '--tail', '20');
  await installer('update');
  call = await client(source);
  assert.equal((await call('/api/admin/runtime-config')).branding.appName, 'Installer demo workspace');
  await installer('backup');
  const backups = (await fs.readdir(path.join(state, source.instanceId, 'backups'))).sort();
  await installer('restore', '--instance', source.instanceId, '--backup', backups.at(-1), '--vault', restoredVault, '--port', await port(), '--non-interactive');
  const recovered = await current();
  assert.notEqual(source.instanceId, recovered.instanceId);
  call = await client(recovered);
  assert.equal((await call('/api/admin/runtime-config')).branding.appName, 'Installer demo workspace');
  assert.deepEqual(await fs.readFile(path.join(restoredVault, '公开 note.md')), await fs.readFile(path.join(vault, '公开 note.md')));
  const data = await command('docker', ['exec', await container(recovered), 'node', '-e', "const a=JSON.parse(require('fs').readFileSync('/app/data/installer-demo-session.json'));if(a.conversation!=='synthetic session'||a.draft!=='synthetic pending draft')process.exit(1)"]);
  assert.equal(data.stderr, '');
  await installer('uninstall');
  await command('docker', ['volume', 'inspect', recovered.dataVolume]);
  await installer('restart');
  await client(recovered);
  await client(source);
  console.log(`Installer Docker gate passed: ${process.platform}/${process.arch}; install, persisted credentials/settings, restart, update, backup, independent restore, uninstall, restart; Unicode/spaces paths.`);
} finally {
  // Also collect a partially initialized instance when a gate assertion fails.
  for (const name of await fs.readdir(state).catch(() => [])) {
    if (!/^second-mind-[a-z0-9-]+$/u.test(name)) continue;
    const metadata = await fs.readFile(path.join(state, name, 'instance.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (metadata && !instances.some((v) => v.instanceId === name)) instances.push(metadata);
  }
  for (const instance of instances.reverse()) {
    await installer('uninstall', '--instance', instance.instanceId).catch(() => {});
    // These UUID-named volumes contain only this gate's disposable synthetic data.
    await command('docker', ['volume', 'rm', instance.dataVolume]).catch(() => {});
  }
  await fs.rm(root, { recursive: true, force: true });
}
