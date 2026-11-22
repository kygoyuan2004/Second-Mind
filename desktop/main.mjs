import { app, BrowserWindow, WebContentsView, Menu, Tray, nativeImage, ipcMain, dialog, session, shell, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BackendController } from './backend-controller.mjs';
import { Preferences, authorizeVault } from './preferences.mjs';
import { connectionPartition, makeConnection } from './connections.mjs';
import { authenticatedHeaders, sameOrigin, allowedFrameUrl, canOpenExternal, isTrustedShellSender, validateRemoteUrl } from './security.mjs';
import { protectPrivateDirectory, setNativeHelperPath } from '../platform/private-storage.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopRoot = path.join(appRoot, 'desktop');
const shellPath = path.join(desktopRoot, 'ui', 'index.html');
const shellUrl = pathToFileURL(shellPath).href;
const toolbarHeight = 64;
const stateRoot = !app.isPackaged && process.env.SECOND_MIND_DESKTOP_STATE_ROOT
  ? path.resolve(process.env.SECOND_MIND_DESKTOP_STATE_ROOT)
  : path.join(process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local') : app.getPath('appData'), 'SecondMind');
if (app.isPackaged) setNativeHelperPath(path.join(process.resourcesPath, 'backend', 'platform', 'native', 'SecondMind.Platform.exe'));
await protectPrivateDirectory(stateRoot);
app.setPath('userData', stateRoot);
app.setAppUserModelId('io.secondmind.desktop');
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let window;
let tray;
let backend;
let preferences;
let prefs;
let activeView = null;
let activeMode = null;
let activeConnectionId = null;
let operation = null;
let errorMessage = '';
let quitting = false;
let localAuth = {};
const views = new Map();
const failedViews = new Set();
const permissionGrants = new Set();

function state() {
  return {
    preferences: prefs,
    mode: activeMode,
    connectionId: activeConnectionId,
    home: !activeView,
    backend: backend?.status() || { state: 'stopped', busy: false },
    operation,
    error: errorMessage,
    version: app.getVersion(),
  };
}

function publish() {
  if (quitting) return;
  if (window && !window.isDestroyed()) window.webContents.send('desktop:state', state());
  const connection = prefs?.connections.find((item) => item.id === activeConnectionId);
  if (window && !window.isDestroyed()) window.setTitle(activeMode === 'remote' ? `Second Mind — 远程 · ${connection?.name || '服务器'}` : activeMode === 'local' ? 'Second Mind — 本机' : 'Second Mind');
  tray?.setToolTip(`Second Mind · 本机后台${backend?.status().state === 'ready' ? '运行中' : '未就绪'}`);
}

async function runOperation(name, action) {
  if (operation) throw new Error('正在完成上一项操作，请稍候。');
  operation = name;
  errorMessage = '';
  publish();
  try { return await action(); }
  catch (error) { errorMessage = error.message || '操作未完成。'; throw error; }
  finally { operation = null; publish(); }
}

function layoutView() {
  if (!activeView || !window || window.isDestroyed()) return;
  const { width, height } = window.getContentBounds();
  activeView.setBounds({ x: 0, y: toolbarHeight, width, height: Math.max(0, height - toolbarHeight) });
}

function reveal(view, mode, connectionId = null) {
  if (activeView && activeView !== view) window.contentView.removeChildView(activeView);
  if (activeView !== view) window.contentView.addChildView(view);
  activeView = view;
  activeMode = mode;
  activeConnectionId = connectionId;
  layoutView();
  publish();
}

function showHome() {
  if (activeView) window.contentView.removeChildView(activeView);
  activeView = null;
  publish();
}

function isControlledContents(contents) {
  return contents && [...views.values()].some((view) => view.webContents === contents && !contents.isDestroyed());
}

function allowedOrigin(contents, url) {
  const descriptor = [...views.entries()].find(([, view]) => view.webContents === contents)?.[0];
  const origin = descriptor === 'local' ? localAuth.origin : prefs.connections.find((item) => item.id === descriptor)?.url;
  return origin && sameOrigin(url, origin);
}

function configureSession(browserSession, isLocal = false) {
  if (isLocal) {
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: authenticatedHeaders(details, localAuth) });
    });
  }
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    if (!isControlledContents(contents) || !allowedOrigin(contents, requestingOrigin)) return false;
    return permission === 'media' || permission === 'clipboard-sanitized-write';
  });
  browserSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const origin = details.requestingUrl || contents?.getURL();
    if (!isControlledContents(contents) || !allowedOrigin(contents, origin) || details.isMainFrame === false) return callback(false);
    if (permission === 'clipboard-sanitized-write') return callback(true);
    if (permission !== 'media' || !details.mediaTypes?.length || details.mediaTypes.some((type) => type !== 'audio')) return callback(false);
    const key = `${contents.id}:${new URL(origin).origin}`;
    if (permissionGrants.has(key)) return callback(true);
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'question', title: '麦克风权限', message: '允许此工作区使用麦克风录音？',
        detail: new URL(origin).origin, buttons: ['允许录音', '取消'], defaultId: 1, cancelId: 1, noLink: true,
      });
      if (response === 0 && !contents.isDestroyed() && allowedOrigin(contents, origin)) permissionGrants.add(key);
      callback(permissionGrants.has(key));
    } catch { callback(false); }
  });
  browserSession.on('will-download', async (_event, item, contents) => {
    if (!isControlledContents(contents)) { item.cancel(); return; }
    item.pause();
    try {
      const name = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const result = await dialog.showSaveDialog(window, { title: '保存文件', defaultPath: path.join(app.getPath('downloads'), name) });
      if (result.canceled || !result.filePath) item.cancel();
      else { item.setSavePath(result.filePath); item.resume(); }
    } catch { item.cancel(); }
  });
}

function createView(key, browserSession, expectedUrl) {
  const view = new WebContentsView({ webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } });
  views.set(key, view);
  view.setBackgroundColor('#f5f5f7');
  const contents = view.webContents;
  const navigate = (event, url) => {
    const expected = key === 'local' ? localAuth.origin : expectedUrl;
    if (!sameOrigin(url, expected)) {
      event.preventDefault();
      if (canOpenExternal(url)) void shell.openExternal(url).catch(() => {});
    }
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', (event, url) => { if (!sameOrigin(url, key === 'local' ? localAuth.origin : expectedUrl)) event.preventDefault(); });
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !allowedFrameUrl(event.url, key === 'local' ? localAuth.origin : expectedUrl)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (canOpenExternal(url)) void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') {
      failedViews.add(key);
      errorMessage = '工作区页面已停止运行，请使用“刷新页面”恢复。';
      if (activeView === view) showHome();
      publish();
    }
  });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    failedViews.add(key);
    errorMessage = `工作区加载失败（${code}）：${description}。请检查地址、网络或服务器证书后重试。`;
    if (activeView === view) showHome();
    publish();
  });
  return view;
}

async function useLocal() {
  if (!prefs.vaults.length) throw new Error('请先选择本机知识库文件夹。');
  const ready = await backend.start(prefs.vaults);
  let view = views.get('local');
  const browserSession = session.fromPartition('persist:second-mind-local');
  if (!view) {
    configureSession(browserSession, true);
    view = createView('local', browserSession, ready.origin);
  }
  const previousOrigin = localAuth.origin;
  localAuth = { origin: ready.origin, token: ready.token, webContentsId: view.webContents.id };
  if (previousOrigin && previousOrigin !== ready.origin) await browserSession.clearStorageData({ storages: ['cookies'] });
  if (ready.cookie) await browserSession.cookies.set({ ...ready.cookie, url: ready.origin, httpOnly: true, secure: false });
  prefs = await preferences.save({ ...prefs, mode: 'local' });
  reveal(view, 'local');
  if (!sameOrigin(view.webContents.getURL(), ready.origin) || failedViews.has('local') || view.webContents.isCrashed()) {
    failedViews.delete('local');
    await view.webContents.loadURL(`${ready.origin}/`);
  }
}

async function connect(id) {
  const connection = prefs.connections.find((item) => item.id === id);
  if (!connection) throw new Error('未找到该服务器连接。');
  await validateRemoteUrl(connection.url, connection.trustedHttp);
  let view = views.get(id);
  if (!view) {
    const browserSession = session.fromPartition(connectionPartition(id));
    configureSession(browserSession);
    view = createView(id, browserSession, connection.url);
  }
  prefs = await preferences.save({ ...prefs, mode: 'remote', connectionId: id });
  reveal(view, 'remote', id);
  if (!view.webContents.getURL() || view.webContents.getURL() === 'about:blank' || failedViews.has(id) || view.webContents.isCrashed()) {
    failedViews.delete(id);
    await view.webContents.loadURL(connection.url);
  }
}

function requireIdle() {
  if (backend.status().busy) throw new Error('本机仍有任务运行。请等待问答、清单、向量构建和媒体任务结束后再修改目录或重启。');
}

function registerIpc() {
  const handle = (channel, action) => ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedShellSender(event, window.webContents, shellUrl)) throw new Error('此页面没有桌面操作权限。');
    return action(...args);
  });
  handle('desktop:get-state', () => state());
  handle('desktop:show-home', showHome);
  handle('desktop:use-local', () => runOperation('正在启动本机工作区', useLocal));
  handle('desktop:choose-vault', () => runOperation('选择知识库', async () => {
    requireIdle();
    const result = await dialog.showOpenDialog(window, { title: '选择本机知识库文件夹', properties: ['openDirectory', 'dontAddToRecent'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const vault = await authorizeVault(result.filePaths[0], prefs.vaults, { stateRoot });
    if (prefs.vaults.some((item) => item.id === vault.id)) return vault;
    requireIdle();
    const next = { ...prefs, vaults: [...prefs.vaults, vault] };
    if (backend.status().state === 'ready') {
      await backend.restart(next.vaults);
      prefs = await preferences.save(next);
      if (activeMode === 'local') await useLocal();
    } else prefs = await preferences.save(next);
    return vault;
  }));
  handle('desktop:remove-vault', (id) => runOperation('移除知识库授权', async () => {
    requireIdle();
    if (!prefs.vaults.some((item) => item.id === id)) throw new Error('未找到该知识库。');
    const next = { ...prefs, vaults: prefs.vaults.filter((item) => item.id !== id) };
    if (backend.status().state === 'ready') {
      if (next.vaults.length) await backend.restart(next.vaults);
      else {
        if (!(await backend.isIdle(true))) throw new Error('本机任务仍在运行，请完成后再移除知识库。');
        await backend.stop();
      }
    }
    prefs = await preferences.save(next);
    if (!next.vaults.length) {
      if (activeMode === 'local') { showHome(); activeMode = null; }
      const view = views.get('local');
      if (view) { view.webContents.close(); views.delete('local'); }
      localAuth = {};
      await session.fromPartition('persist:second-mind-local').clearStorageData();
    } else if (activeMode === 'local') await useLocal();
  }));
  handle('desktop:save-connection', (input) => runOperation('保存服务器连接', async () => {
    const connection = await makeConnection(input, prefs.connections);
    prefs = await preferences.save({ ...prefs, connections: [...prefs.connections.filter((item) => item.id !== connection.id), connection] });
    return connection;
  }));
  handle('desktop:connect', (id) => runOperation('正在连接服务器', () => connect(id)));
  handle('desktop:remove-connection', (id) => runOperation('移除服务器连接', async () => {
    if (id === activeConnectionId) { showHome(); activeMode = null; activeConnectionId = null; }
    const view = views.get(id);
    if (view) { view.webContents.close(); views.delete(id); }
    await session.fromPartition(connectionPartition(id)).clearStorageData();
    prefs = await preferences.save({ ...prefs, connections: prefs.connections.filter((item) => item.id !== id) });
  }));
  handle('desktop:open-vault', (id) => runOperation('打开知识库文件夹', async () => {
    const vault = prefs.vaults.find((item) => item.id === id);
    if (!vault) throw new Error('此文件夹未获得授权。');
    const verified = await authorizeVault(vault.path, prefs.vaults, { stateRoot });
    if (verified.id !== vault.id) throw new Error('知识库路径已改变，请重新选择文件夹。');
    const error = await shell.openPath(vault.path);
    if (error) throw new Error(error);
  }));
  handle('desktop:restart-backend', () => runOperation('正在重启本机后台', async () => {
    requireIdle();
    await backend.restart(prefs.vaults);
    if (activeMode === 'local') await useLocal();
  }));
  handle('desktop:media-status', () => backend.mediaStatus());
  handle('desktop:prepare-media', () => backend.prepareMedia());
  handle('desktop:reload-page', () => {
    errorMessage = '';
    if (activeView) activeView.webContents.reload();
    else if (activeMode === 'remote' && activeConnectionId) void runOperation('正在重连服务器', async () => {
      const view = views.get(activeConnectionId);
      if (view) view.webContents.close();
      views.delete(activeConnectionId);
      await connect(activeConnectionId);
    }).catch(() => {});
    else if (activeMode === 'local') void runOperation('正在恢复本机工作区', useLocal).catch(() => {});
    publish();
  });
  handle('desktop:quit', () => { app.quit(); });
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Second Mind', submenu: [{ label: '工作区与连接', click: showHome }, { type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: () => app.quit() }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '查看', submenu: [{ label: '刷新工作区', accelerator: 'CmdOrCtrl+R', click: () => activeView?.webContents.reload() }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
}

async function createTray() {
  const iconPath = path.join(appRoot, 'build', 'icon.png');
  let icon;
  try { await fs.access(iconPath); icon = nativeImage.createFromPath(iconPath); } catch { /* Source checkout fallback. */ }
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHUlEQVQ4T2NkYPj/n4ECwESJ5lEDRg0YNWAwGQAAfM8CHlc+rqIAAAAASUVORK5CYII=');
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Second Mind', click: () => { window.show(); window.focus(); } }, { label: '工作区与连接', click: () => { showHome(); window.show(); } }, { type: 'separator' }, { label: '退出并停止本机任务', click: () => app.quit() }]));
  tray.on('double-click', () => { window.show(); window.focus(); });
}

async function initialize() {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  preferences = new Preferences(stateRoot);
  prefs = await preferences.load();
  const codec = {
    encrypt: async (value) => {
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统安全存储不可用，无法保存凭据。请启用系统密钥环后重试。');
      return safeStorage.encryptString(Buffer.from(value).toString('base64'));
    },
    decrypt: async (value) => Buffer.from(safeStorage.decryptString(Buffer.from(value)), 'base64'),
  };
  backend = new BackendController({ stateRoot, appRoot, resourcesPath: process.resourcesPath, packaged: app.isPackaged, codec });
  backend.on('state', () => {
    if (backend.status().state === 'failed') {
      errorMessage = backend.status().error?.message || '本机后台已停止，请重启后台。';
      if (activeMode === 'local') showHome();
    }
    publish();
  });
  window = new BrowserWindow({ width: 1320, height: 920, minWidth: 850, minHeight: 620, title: 'Second Mind', backgroundColor: '#f5f5f7', show: false, webPreferences: { preload: path.join(desktopRoot, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged, partition: 'second-mind-shell' } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== shellUrl) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('resize', layoutView);
  window.on('close', (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
  registerIpc();
  createMenu();
  await createTray();
  await window.loadFile(shellPath);
  window.show();
  publish();
  if (prefs.mode === 'local') await runOperation('正在恢复本机工作区', useLocal).catch(() => {});
  else if (prefs.mode === 'remote') await runOperation('正在恢复服务器连接', () => connect(prefs.connectionId)).catch(() => {});
}

app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.on('activate', () => { window?.show(); });
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  const deadline = setTimeout(() => app.exit(1), 25_000);
  deadline.unref();
  void (async () => {
    for (const view of views.values()) {
      try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* Continue stopping the backend if a renderer is already gone. */ }
    }
    let exitCode = 0;
    try { await backend?.stop(); } catch { exitCode = 1; }
    finally { clearTimeout(deadline); tray?.destroy(); app.exit(exitCode); }
  })();
});
if (singleInstance) app.whenReady().then(initialize).catch((error) => { dialog.showErrorBox('Second Mind 启动失败', error.message); app.exit(1); });
