import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BackendController, backendEnvironment } from '../desktop/backend-controller.mjs';
import { resolveDesktopResources } from '../desktop/resources.mjs';
import { authorizeVault } from '../desktop/preferences.mjs';

function testCodec() {
  const key = crypto.randomBytes(32);
  return {
    encrypt(data) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(data) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
    },
  };
}

test('desktop backend excludes host provider credentials and user configuration', () => {
  const resources = resolveDesktopResources({ appRoot: process.cwd() });
  const environment = backendEnvironment({ PATH: '/test/bin', ANTHROPIC_API_KEY: 'secret-fixture',
    NODE_OPTIONS: '--require injected', CLAUDE_CONFIG_DIR: '/host/claude', LLM_API_KEY_FILE: '/host/key',
    VAULT_PATH: '/host/vault' }, { resources, stateRoot: path.resolve('synthetic-state') });
  for (const key of ['ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'LLM_API_KEY_FILE', 'VAULT_PATH']) assert.equal(environment[key], undefined);
  assert.equal(environment.HOME, path.resolve('synthetic-state'));
  assert.match(environment.VAULTMIND_ENV_FILE, /desktop-no-env$/);
});

test('independent desktop process: protected session, offline Vault, encrypted config and restart', { timeout: 60_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secondmind-desktop-'));
  const vault = path.join(root, '中文 Vault');
  const stateRoot = path.join(root, 'state');
  await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(vault, 'Evidence.md'), '# Evidence\n\n桌面 desktopfixture 公开资料。');
  const backend = new BackendController({ appRoot: process.cwd(), stateRoot, packaged: false, codec: testCodec() });
  t.after(async () => { await backend.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const grants = [{ id: 'local-first', name: '演示库', path: vault }];
  const connection = await backend.start(grants);
  const call = (route, options = {}) => fetch(`${connection.origin}${route}`, {
    ...options, headers: { 'X-SecondMind-Desktop-Token': connection.token, 'x-vaultmind-request': '1',
      origin: connection.origin, 'content-type': 'application/json', ...options.headers },
  });
  assert.equal((await fetch(`${connection.origin}/api/session`)).status, 401);
  assert.equal((await fetch(`${connection.origin}/api/session`, { headers: { cookie: `${connection.cookie.name}=${connection.cookie.value}` } })).status, 401);
  assert.equal((await call('/api/session', { headers: { origin: 'https://untrusted.example' } })).status, 403);
  const session = await (await call('/api/session')).json();
  assert.equal(session.authMode, 'desktop'); assert.equal(session.authenticated, true);
  assert.equal(session.authRequired, false);
  const status = await (await call('/api/knowledge/status?knowledgeBaseId=local-first')).json();
  assert.equal(status.llm.configured, false);
  assert.equal(status.executor, 'claude-agent-sdk');
  const config = await (await call('/api/admin/provider-config')).json();
  const saved = await call('/api/admin/provider-config', { method: 'PUT', body: JSON.stringify({
    schemaVersion: 1, expectedRevision: config.revision,
    branding: { appName: 'Desktop fixture workspace', vaultLabel: '本机测试' },
  }) });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  const bytes = await fs.readFile(path.join(stateRoot, 'data', 'runtime', 'runtime-config.json'));
  assert.ok(bytes.subarray(0, 7).equals(Buffer.from('SMENC1\n')));
  assert.ok(!bytes.includes(Buffer.from('Desktop fixture workspace')));
  assert.equal(await backend.isIdle(), true);
  assert.equal((await backend.mediaStatus()).state, 'not-downloaded');
  const next = await backend.restart(grants);
  assert.notEqual(next.token, connection.token);
  const response = await fetch(`${next.origin}/api/knowledge/status?knowledgeBaseId=local-first`, { headers: { 'X-SecondMind-Desktop-Token': next.token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).appName, 'Desktop fixture workspace');
  assert.equal((await fetch(`${next.origin}/api/session`, { headers: { 'X-SecondMind-Desktop-Token': connection.token } })).status, 401);
  await backend.stop();
  assert.equal(backend.status().state, 'stopped');
});

test('native picker grants survive add/remove and do not change surviving library state', { timeout: 60_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secondmind-grants-'));
  const firstPath = path.join(root, '第一库'), secondPath = path.join(root, '第二库');
  for (const directory of [firstPath, secondPath]) await fs.mkdir(path.join(directory, '.obsidian'), { recursive: true });
  const first = await authorizeVault(firstPath), second = await authorizeVault(secondPath);
  const backend = new BackendController({ appRoot: process.cwd(), stateRoot: path.join(root, 'state'), codec: testCodec() });
  t.after(async () => { await backend.stop(); await fs.rm(root, { recursive: true, force: true }); });
  let connection = await backend.start([first]);
  connection = await backend.restart([first, second]);
  let bases = await (await fetch(`${connection.origin}/api/admin/knowledge-bases`, { headers: { 'X-SecondMind-Desktop-Token': connection.token } })).json();
  assert.deepEqual(bases.knowledgeBases.map((item) => item.knowledgeBaseId).sort(), [first.id, second.id].sort());
  connection = await backend.restart([second]);
  bases = await (await fetch(`${connection.origin}/api/admin/knowledge-bases`, { headers: { 'X-SecondMind-Desktop-Token': connection.token } })).json();
  assert.deepEqual(bases.knowledgeBases.map((item) => item.knowledgeBaseId), [second.id]);
  assert.equal(bases.knowledgeBases[0].default, true);
  const ledger = JSON.parse(await fs.readFile(path.join(root, 'state', 'data', 'runtime', 'knowledge-bases.json.bindings'), 'utf8'));
  assert.ok(ledger.bindings.some((item) => item.knowledgeBaseId === first.id));
  assert.ok(ledger.bindings.some((item) => item.knowledgeBaseId === second.id));
});

test('missing executable and quit during startup settle without leaving the controller stuck', { timeout: 15_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secondmind-start-failure-'));
  const vault = path.join(root, 'vault');
  await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
  const grant = await authorizeVault(vault);
  const backend = new BackendController({ appRoot: process.cwd(), stateRoot: path.join(root, 'state'), codec: testCodec() });
  t.after(async () => { await backend.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const executable = backend.resources.node;
  backend.resources.node = path.join(root, 'missing-node-executable');
  await assert.rejects(backend.start([grant]), { code: 'BACKEND_EXECUTABLE_MISSING' });
  await backend.stop();
  assert.equal(backend.status().state, 'stopped');
  backend.resources.node = executable;
  const starting = backend.start([grant]);
  const rejected = assert.rejects(starting);
  await backend.stop();
  await rejected;
  assert.equal(backend.status().state, 'stopped');
  await backend.start([grant]);
  assert.equal(backend.status().state, 'ready');
});
