// Explicit GUI integration suite: node --test test/desktop-shell.electron.mjs
// Linux needs DISPLAY (for example Xvfb); Windows exercises native DPAPI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { expect } from '@playwright/test';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const packagedExecutable = process.env.SECOND_MIND_PACKAGED_EXECUTABLE;
const useSystemKeyring = process.platform === 'linux' && process.env.SECOND_MIND_TEST_SYSTEM_KEYRING === '1';

async function mockServer(t, title) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><script>document.cookie='remote=${title}; path=/';</script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, requests, close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); } };
}

test('Electron shell runs the real local backend, isolates remote connections, and preserves background execution', { timeout: 120_000 }, async (t) => {
  const build = path.join(appRoot, 'build');
  await fs.mkdir(build, { recursive: true });
  await fs.rm(path.join(build, 'desktop-local-smoke.png'), { force: true });
  const fixture = await fs.mkdtemp(path.join(build, 'electron-smoke-'));
  let application;
  let first;
  let second;
  t.after(async () => {
    if (application) await application.close().catch(() => {});
    await first?.close();
    await second?.close();
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const vault = path.join(fixture, '中文 知识库');
  await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(vault, '测试笔记.md'), '# 桌面测试\n\n这是关键词检索与文件路径测试。\n');
  first = await mockServer(t, 'Server A');
  second = await mockServer(t, 'Server B');
  const env = { ...process.env, SECOND_MIND_DESKTOP_STATE_ROOT: path.join(fixture, 'state') };
  if (packagedExecutable) {
    env.LOCALAPPDATA = path.join(fixture, 'local-app-data');
    env.XDG_CONFIG_HOME = path.join(fixture, 'desktop-config');
    env.XDG_CACHE_HOME = path.join(fixture, 'desktop-cache');
  }
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    ...(packagedExecutable ? { executablePath: path.resolve(packagedExecutable) } : {}),
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', ...(useSystemKeyring ? ['--password-store=gnome-libsecret'] : [])] : []), ...(packagedExecutable ? [] : [appRoot])],
    env,
    timeout: 30_000,
  });
  const page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  assert.equal(await page.locator('h1').textContent(), '你的知识，随时继续。');
  assert.equal(await page.locator('#use-local-button').isDisabled(), true);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await application.evaluate(async ({ dialog, safeStorage }, { selectedPath, useSystemKeyring }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    if (useSystemKeyring) {
      if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend() !== 'gnome_libsecret') {
        throw new Error('The isolated Secret Service keyring is unavailable');
      }
    } else if (process.platform !== 'win32') {
      // Test-only, ephemeral encryption avoids reading/writing a developer's
      // system keyring. Production main has no injection or plaintext fallback.
      const crypto = process.getBuiltinModule('node:crypto');
      const key = crypto.randomBytes(32);
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.getSelectedStorageBackend = () => 'test-memory';
      safeStorage.encryptString = (value) => {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      };
      safeStorage.decryptString = (value) => {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
        decipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
      };
    }
  }, { selectedPath: vault, useSystemKeyring });
  await page.locator('#choose-vault-button').click();
  await page.waitForFunction(() => document.querySelector('#use-local-button').disabled === false);
  const grant = await page.evaluate(() => window.secondMindDesktop.getState()).then((state) => state.preferences.vaults[0]);
  assert.equal(grant.path, vault);
  await page.locator('#use-local-button').click();
  await expect.poll(async () => { const state = await page.evaluate(() => window.secondMindDesktop.getState()); return state.backend.state === 'ready' && state.mode === 'local' && !state.operation; }, { timeout: 60_000 }).toBe(true).catch(async (error) => {
    throw new Error(`Local workspace did not open: ${JSON.stringify(await page.evaluate(() => window.secondMindDesktop.getState()))}`, { cause: error });
  });
  const localState = await page.evaluate(() => window.secondMindDesktop.getState());
  assert.equal(localState.mode, 'local');
  assert.equal(localState.home, false);
  assert.equal(JSON.stringify(localState).includes('token'), false);
  const localPage = application.windows().find((candidate) => candidate !== page && candidate.url().startsWith(localState.backend.origin));
  assert.ok(localPage, 'local business page is attached');
  await localPage.waitForLoadState('domcontentloaded');
  const session = await localPage.evaluate(async () => (await fetch('/api/session')).json());
  assert.equal(session.authenticated, true);
  assert.equal(await localPage.evaluate(() => typeof window.secondMindDesktop), 'undefined');
  assert.equal(await localPage.evaluate(() => document.cookie.includes('vaultmind_session')), false);
  await localPage.evaluate(async () => { await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => {}))); });
  await localPage.screenshot({ path: path.join(build, 'desktop-local-content-smoke.png'), animations: 'disabled' });
  const composite = await application.evaluate(async ({ desktopCapturer }) => {
    const isolatedDisplay = process.platform === 'linux';
    const sources = await desktopCapturer.getSources({ types: [isolatedDisplay ? 'screen' : 'window'], thumbnailSize: { width: 1440, height: 1000 } });
    const source = isolatedDisplay ? sources[0] : sources.find((item) => item.name.startsWith('Second Mind'));
    if (!source || source.thumbnail.isEmpty()) return null;
    return source.thumbnail.toPNG().toString('base64');
  }).catch(() => null);
  if (composite) await fs.writeFile(path.join(build, 'desktop-local-smoke.png'), Buffer.from(composite, 'base64'));
  else t.diagnostic('Native composed-window screenshot unavailable in this desktop session; per-view screenshots were recorded. This does not verify visible interactive desktop presentation.');
  const unauthenticated = await fetch(`${localState.backend.origin}/api/session`);
  assert.equal(unauthenticated.status, 401);

  const selectedKnowledgeBase = await localPage.locator('#knowledge-base-select').inputValue();
  assert.ok(selectedKnowledgeBase && selectedKnowledgeBase !== 'default', 'desktop generated registry ID is selected');
  const adminLink = localPage.locator('.knowledge-drive-back');
  await expect(adminLink).toHaveAttribute('href', `/admin-config.html?knowledgeBaseId=${encodeURIComponent(selectedKnowledgeBase)}`);
  await adminLink.click();
  await localPage.waitForURL(/\/admin-config\.html\?knowledgeBaseId=/);
  assert.equal(new URL(localPage.url()).searchParams.get('knowledgeBaseId'), selectedKnowledgeBase);
  await expect(localPage.locator('.confirmation-card')).toBeHidden();
  await localPage.goto(`${localState.backend.origin}/`);
  const pdfFrameUrl = await localPage.evaluate(() => {
    const blob = new Blob(['%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF'], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const frame = document.createElement('iframe');
    frame.id = 'desktop-pdf-smoke';
    frame.src = url;
    document.body.append(frame);
    return url;
  });
  await expect.poll(() => localPage.frames().some((frame) => frame.url() === pdfFrameUrl), { timeout: 10_000 }).toBe(true);

  await page.evaluate(() => window.secondMindDesktop.showHome());
  const a = await page.evaluate((url) => window.secondMindDesktop.saveConnection({ name: '测试服务器 A', url, trustedHttp: true }), first.url);
  await page.evaluate((id) => window.secondMindDesktop.connect(id), a.id);
  const remoteA = application.windows().find((candidate) => candidate.url() === first.url);
  assert.ok(remoteA);
  assert.equal(await remoteA.evaluate(() => typeof window.secondMindDesktop), 'undefined');
  assert.equal((await page.evaluate(() => window.secondMindDesktop.getState())).backend.state, 'ready');
  assert.ok(first.requests.length > 0);
  assert.ok(first.requests.every(({ headers }) => !headers['x-secondmind-desktop-token'] && !String(headers.cookie).includes('vaultmind_session')));
  assert.equal(await page.locator('#connection-warning').isVisible(), true);

  await page.evaluate(() => window.secondMindDesktop.showHome());
  const b = await page.evaluate((url) => window.secondMindDesktop.saveConnection({ name: '测试服务器 B', url, trustedHttp: true }), second.url);
  await page.evaluate((id) => window.secondMindDesktop.connect(id), b.id);
  assert.ok(second.requests.every(({ headers }) => !String(headers.cookie).includes('remote=Server A')));
  await page.evaluate(() => window.secondMindDesktop.showHome());
  await page.locator('#use-local-button').click();
  await expect.poll(async () => (await page.evaluate(() => window.secondMindDesktop.getState())).mode).toBe('local');
  assert.equal((await page.evaluate(() => window.secondMindDesktop.getState())).backend.origin, localState.backend.origin);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  assert.equal((await page.evaluate(() => window.secondMindDesktop.getState())).backend.state, 'ready');
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.secondMindDesktop.showHome());
  await page.screenshot({ path: path.join(build, 'desktop-connections-smoke.png') });

  const anotherVault = path.join(fixture, '第二个 Vault');
  await fs.mkdir(path.join(anotherVault, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(anotherVault, '独立笔记.md'), '# 第二个知识库\n');
  await application.evaluate(({ dialog }, selectedPath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] }); }, anotherVault);
  const anotherGrant = await page.evaluate(() => window.secondMindDesktop.chooseVault());
  assert.equal((await page.evaluate(() => window.secondMindDesktop.getState())).preferences.vaults.length, 2);
  await page.evaluate((id) => window.secondMindDesktop.removeVault(id), grant.id);
  const remainingState = await page.evaluate(() => window.secondMindDesktop.getState());
  assert.deepEqual(remainingState.preferences.vaults.map((item) => item.id), [anotherGrant.id]);
  assert.equal(remainingState.backend.state, 'ready');
  await fs.access(path.join(vault, '测试笔记.md'));
  await page.evaluate((id) => window.secondMindDesktop.removeVault(id), anotherGrant.id);
  const stoppedState = await page.evaluate(() => window.secondMindDesktop.getState());
  assert.equal(stoppedState.backend.state, 'stopped');
  assert.equal(stoppedState.preferences.vaults.length, 0);
  assert.equal(stoppedState.home, true);
  await fs.access(path.join(anotherVault, '独立笔记.md'));
});
