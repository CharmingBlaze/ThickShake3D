const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  openFile: (opts) => ipcRenderer.invoke('open-file', opts),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  setTitle: (t) => ipcRenderer.invoke('set-title', t),
  confirmClose: () => ipcRenderer.invoke('confirm-close'),
  onRequestClose: (fn) => ipcRenderer.on('request-close', () => fn()),
  autosaveWrite: (text) => ipcRenderer.invoke('autosave-write', text),
  autosaveRead: () => ipcRenderer.invoke('autosave-read'),
  autosaveClear: () => ipcRenderer.invoke('autosave-clear'),
  toggleDevtools: () => ipcRenderer.invoke('toggle-devtools'),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
});
