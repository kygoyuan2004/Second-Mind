import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sameOrigin, allowedFrameUrl, authenticatedHeaders, validateRemoteUrl, canOpenExternal, isTrustedShellSender } from '../desktop/security.mjs';
import { makeConnection, connectionPartition } from '../desktop/connections.mjs';
import { Preferences, authorizeVault, sanitizePreferences } from '../desktop/preferences.mjs';

test('desktop credentials only reach the exact local origin and controlled page', () => {
  const auth = { origin: 'http://127.0.0.1:3456', token: 'private-token', webContentsId: 12 };
  const request = { url: 'http://127.0.0.1:3456/api/session', webContentsId: 12, requestHeaders: { Cookie: 'vaultmind_session=private', Accept: 'application/json' } };
  assert.equal(authenticatedHeaders(request, auth)['X-SecondMind-Desktop-Token'], 'private-token');
  for (const url of ['http://127.0.0.1:3457/api/session', 'https://127.0.0.1:3456/', 'http://127.0.0.1.evil.example:3456/', 'http://127.0.0.1:3456@evil.example/', 'file:///etc/passwd']) {
    const headers = authenticatedHeaders({ ...request, url, requestHeaders: { ...request.requestHeaders, 'x-secondmind-desktop-token': 'spoof' } }, auth);
    assert.equal(headers['X-SecondMind-Desktop-Token'], undefined);
    assert.equal(headers['x-secondmind-desktop-token'], undefined);
    assert.equal(headers.Cookie, undefined);
    assert.equal(headers.Accept, 'application/json');
  }
  assert.equal(authenticatedHeaders({ ...request, webContentsId: 13 }, auth).Cookie, undefined);
  assert.equal(authenticatedHeaders({ ...request, frame: { parent: {}, url: 'https://foreign.example/' } }, auth).Cookie, undefined);
  assert.equal(sameOrigin('http://127.0.0.1:3456/api/tasks', auth.origin), true);
  assert.equal(allowedFrameUrl('blob:http://127.0.0.1:3456/document-id', auth.origin), true);
  assert.equal(allowedFrameUrl('blob:https://foreign.example/document-id', auth.origin), false);
  assert.equal(authenticatedHeaders({ ...request, url: 'blob:http://127.0.0.1:3456/document-id' }, auth)['X-SecondMind-Desktop-Token'], undefined);
});

test('server connections require HTTPS or explicitly trusted private LAN HTTP', async () => {
  assert.equal(await validateRemoteUrl('https://example.org'), 'https://example.org/');
  await assert.rejects(validateRemoteUrl('http://192.168.1.9:3000'), /勾选/);
  assert.equal(await validateRemoteUrl('http://192.168.1.9:3000', true), 'http://192.168.1.9:3000/');
  assert.equal(await validateRemoteUrl('http://[::1]:3000', true), 'http://[::1]:3000/');
  await assert.rejects(validateRemoteUrl('http://8.8.8.8', true), /公网/);
  await assert.rejects(validateRemoteUrl('http://host.local', true, async () => [{ address: '192.168.1.2' }, { address: '8.8.8.8' }]), /公网/);
  assert.equal(await validateRemoteUrl('http://host.local', true, async () => [{ address: '10.0.0.2' }]), 'http://host.local/');
  for (const url of ['file:///a', 'javascript:alert(1)', 'https://user:pass@example.org', 'https://example.org/?token=secret', 'https://example.org/#token']) {
    await assert.rejects(validateRemoteUrl(url, true));
  }
});

test('each connection has a stable, distinct browser partition', async () => {
  const first = await makeConnection({ url: 'https://first.example.org', name: '工作' });
  const second = await makeConnection({ url: 'https://second.example.org' });
  const updated = await makeConnection({ url: 'https://first.example.org', name: '工作 2' }, [first]);
  assert.equal(updated.id, first.id);
  assert.notEqual(connectionPartition(first.id), connectionPartition(second.id));
  assert.notEqual(connectionPartition(first.id), 'persist:second-mind-local');
  assert.match(connectionPartition('../../escape'), /^persist:remote-[a-f0-9]{32}$/);
});

test('only the trusted shell main frame can invoke desktop actions', () => {
  const mainFrame = { url: 'file:///application/desktop/ui/index.html' };
  const contents = { mainFrame };
  assert.equal(isTrustedShellSender({ sender: contents, senderFrame: mainFrame }, contents, mainFrame.url), true);
  assert.equal(isTrustedShellSender({ sender: {}, senderFrame: mainFrame }, contents, mainFrame.url), false);
  assert.equal(isTrustedShellSender({ sender: contents, senderFrame: { url: mainFrame.url } }, contents, mainFrame.url), false);
  assert.equal(isTrustedShellSender({ sender: contents, senderFrame: mainFrame }, contents, 'file:///other'), false);
  assert.equal(canOpenExternal('https://example.org/page'), true);
  assert.equal(canOpenExternal('file:///C:/Windows/System32/cmd.exe'), false);
  assert.equal(canOpenExternal('secondmind:run'), false);
});

test('desktop preferences persist independent vaults and connections without secrets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secondmind-preferences-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, '中文 知识库');
  await fs.mkdir(path.join(vaultPath, '.obsidian'), { recursive: true });
  const store = new Preferences(path.join(root, 'state'));
  const initial = await store.load();
  assert.equal(initial.mode, null);
  const vault = await authorizeVault(vaultPath);
  assert.ok(vault.id.length <= 32, 'grant identifiers fit the registry mount ID contract');
  assert.equal((await authorizeVault(vaultPath, [vault])).id, vault.id);
  const connection = await makeConnection({ url: 'https://example.org', name: '家庭' });
  await store.save({ ...initial, mode: 'local', vaults: [vault], connections: [connection], token: 'DO_NOT_SAVE', password: 'DO_NOT_SAVE' });
  const restored = await new Preferences(path.join(root, 'state')).load();
  assert.equal(restored.mode, 'local');
  assert.deepEqual(restored.vaults, [vault]);
  const serialized = await fs.readFile(store.file, 'utf8');
  assert.equal(serialized.includes('DO_NOT_SAVE'), false);
  assert.deepEqual(sanitizePreferences({ mode: 'remote', connectionId: 'missing', connections: [{ id: 'bad', url: 'javascript:evil' }] }).connections, []);
  await fs.writeFile(store.file, '{broken');
  await assert.rejects(new Preferences(path.join(root, 'state')).load(), /无法读取/);
});

test('native directory authorization refuses whole volumes and directory links', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secondmind-vault-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const link = path.join(root, 'link');
  const actual = path.join(root, 'actual');
  await fs.mkdir(path.join(actual, '.obsidian'), { recursive: true });
  await fs.symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(authorizeVault(link), /目录链接/);
  await fs.mkdir(path.join(actual, 'nested', '.obsidian'), { recursive: true });
  await assert.rejects(authorizeVault(path.join(link, 'nested')), /目录链接/);
  const parentGrant = await authorizeVault(actual);
  await assert.rejects(authorizeVault(path.join(actual, 'nested'), [parentGrant]), /互相包含/);
  await assert.rejects(authorizeVault(actual, [], { stateRoot: path.join(actual, 'state') }), /私有数据/);
  await assert.rejects(authorizeVault(path.parse(root).root), /整块磁盘/);
});
