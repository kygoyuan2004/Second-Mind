'use strict';
const api = window.secondMindDesktop;
const byId = (id) => document.getElementById(id);
let snapshot;
let listsFingerprint;
let mediaStatus;
let mediaPending = false;

function errorText(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

async function act(action) {
  try { return await action(); }
  catch (error) { byId('error-message').textContent = errorText(error); byId('error-message').hidden = false; }
}

function button(text, action, className = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.className = className;
  element.addEventListener('click', () => void act(action));
  return element;
}

function itemCopy(name, detail) {
  const copy = document.createElement('div');
  copy.className = 'item-copy';
  const title = document.createElement('strong');
  title.textContent = name;
  const subtitle = document.createElement('small');
  subtitle.textContent = detail;
  copy.append(title, subtitle);
  return copy;
}

function drawLists(preferences) {
  const fingerprint = JSON.stringify([preferences.vaults, preferences.connections]);
  if (fingerprint === listsFingerprint) return;
  listsFingerprint = fingerprint;
  byId('vault-list').replaceChildren(...preferences.vaults.map((vault) => {
    const row = document.createElement('li');
    const remove = button('移除', () => api.removeVault(vault.id), 'remove remove-vault');
    remove.title = '移除软件访问授权，保留文件夹和文件';
    row.append(itemCopy(vault.name, vault.path), button('打开文件夹', () => api.openVault(vault.id)), remove);
    return row;
  }));
  byId('connection-list').replaceChildren(...preferences.connections.map((connection) => {
    const row = document.createElement('li');
    row.append(itemCopy(connection.name, connection.url), button('连接', () => api.connect(connection.id)), button('移除', () => api.removeConnection(connection.id), 'remove'));
    return row;
  }));
}

function render(state) {
  snapshot = state;
  const prefs = state.preferences || { vaults: [], connections: [] };
  const connection = prefs.connections.find((item) => item.id === state.connectionId);
  byId('mode-label').textContent = state.mode === 'remote' ? `远程 · ${connection?.name || '服务器'}` : state.mode === 'local' ? '本机工作区' : '选择工作区';
  byId('connection-warning').hidden = state.mode !== 'remote' || !connection?.trustedHttp;
  byId('home').hidden = !state.home;
  const labels = { stopped: '本机后台未启动', starting: '本机后台启动中', ready: state.backend.busy ? '本机任务运行中' : '本机后台运行中', stopping: '本机后台停止中', failed: '本机后台异常' };
  const status = labels[state.backend.state] || '正在读取状态';
  byId('toolbar-status').textContent = state.operation || status;
  byId('runtime-state').textContent = state.backend.error?.message || status;
  byId('error-message').textContent = state.error || '';
  byId('error-message').hidden = !state.error;
  byId('operation-message').textContent = state.operation || '';
  byId('operation-message').hidden = !state.operation;
  byId('vault-empty').hidden = prefs.vaults.length > 0;
  byId('choose-vault-button').textContent = prefs.vaults.length ? '添加知识库文件夹' : '选择知识库文件夹';
  byId('version').textContent = `Second Mind ${state.version}`;
  drawLists(prefs);
  for (const element of document.querySelectorAll('button')) element.disabled = Boolean(state.operation);
  byId('use-local-button').disabled ||= prefs.vaults.length === 0;
  byId('choose-vault-button').disabled ||= state.backend.busy;
  for (const element of document.querySelectorAll('.remove-vault')) element.disabled ||= state.backend.busy;
  byId('restart-button').disabled ||= prefs.vaults.length === 0 || state.backend.busy || ['starting', 'stopping'].includes(state.backend.state);
  byId('reload-button').disabled ||= !state.mode;
  renderMedia();
}

function renderMedia() {
  const ready = snapshot?.backend?.state === 'ready';
  const labels = { 'not-downloaded': '语音模型尚未下载。', downloading: '正在下载 small 语音模型…', ready: 'small 语音模型已就绪，可录音和转写视频。', error: '语音模型下载失败，可以重试。' };
  const downloading = mediaStatus?.state === 'downloading';
  const progress = byId('media-progress');
  progress.hidden = !ready || !downloading;
  let text = ready ? labels[mediaStatus?.state] || '正在读取语音组件状态…' : '进入本机工作区后可下载语音模型。';
  if (ready && mediaStatus?.message) text += ` ${mediaStatus.message}`;
  if (downloading && mediaStatus?.totalBytes > 0) {
    const percentage = Math.min(100, Math.round((mediaStatus.downloadedBytes / mediaStatus.totalBytes) * 100));
    progress.value = percentage;
    text += ` ${percentage}%`;
  } else progress.removeAttribute('value');
  byId('media-state').textContent = text;
  byId('prepare-media-button').disabled = !ready || downloading || mediaStatus?.state === 'ready' || mediaPending || Boolean(snapshot?.operation);
  byId('prepare-media-button').textContent = mediaStatus?.state === 'error' ? '重试下载' : mediaStatus?.state === 'ready' ? '模型已就绪' : '下载语音模型';
}

async function refreshMedia() {
  if (mediaPending || snapshot?.backend?.state !== 'ready' || !snapshot.home) return;
  mediaPending = true;
  try { mediaStatus = await api.getMediaStatus(); }
  catch (error) { mediaStatus = { state: 'error', message: errorText(error) }; }
  finally { mediaPending = false; renderMedia(); }
}

byId('home-button').addEventListener('click', () => void act(() => api.showHome()));
byId('connections-button').addEventListener('click', () => void act(() => api.showHome()));
byId('choose-vault-button').addEventListener('click', () => void act(() => api.chooseVault()));
byId('use-local-button').addEventListener('click', () => void act(() => api.useLocal()));
byId('restart-button').addEventListener('click', () => void act(() => api.restartBackend()));
byId('prepare-media-button').addEventListener('click', () => void act(async () => {
  mediaPending = true;
  renderMedia();
  try { mediaStatus = await api.prepareMedia(); }
  finally { mediaPending = false; renderMedia(); }
}));
byId('reload-button').addEventListener('click', () => void act(() => api.reloadPage()));
byId('quit-button').addEventListener('click', () => void act(() => api.quit()));
byId('connection-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (snapshot?.operation) return;
  void act(async () => {
    const connection = await api.saveConnection({ name: byId('connection-name').value, url: byId('connection-url').value, trustedHttp: byId('trusted-http').checked });
    await api.connect(connection.id);
    byId('connection-form').reset();
  });
});

api.onState(render);
void act(async () => render(await api.getState()));
setInterval(() => void refreshMedia(), 1500);
