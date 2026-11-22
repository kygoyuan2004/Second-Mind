const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('secondMindDesktop', Object.freeze({
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  chooseVault: () => ipcRenderer.invoke('desktop:choose-vault'),
  useLocal: () => ipcRenderer.invoke('desktop:use-local'),
  saveConnection: (connection) => ipcRenderer.invoke('desktop:save-connection', connection),
  connect: (id) => ipcRenderer.invoke('desktop:connect', id),
  removeConnection: (id) => ipcRenderer.invoke('desktop:remove-connection', id),
  showHome: () => ipcRenderer.invoke('desktop:show-home'),
  openVault: (id) => ipcRenderer.invoke('desktop:open-vault', id),
  removeVault: (id) => ipcRenderer.invoke('desktop:remove-vault', id),
  restartBackend: () => ipcRenderer.invoke('desktop:restart-backend'),
  getMediaStatus: () => ipcRenderer.invoke('desktop:media-status'),
  prepareMedia: () => ipcRenderer.invoke('desktop:prepare-media'),
  reloadPage: () => ipcRenderer.invoke('desktop:reload-page'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  onState: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('A state listener is required.');
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('desktop:state', handler);
    return () => ipcRenderer.removeListener('desktop:state', handler);
  },
}));
