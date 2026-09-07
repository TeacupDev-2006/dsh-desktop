'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsh', {
  // splash
  splashSetStatus: (cb) => ipcRenderer.on('splash:status', (_e, text) => cb(text)),
  // welcome
  welcomeInit: () => ipcRenderer.invoke('welcome:init'),
  welcomeBrowse: () => ipcRenderer.invoke('welcome:browse'),
  welcomeSubmit: (data) => ipcRenderer.invoke('welcome:submit', data),
  // error
  errorInit: () => ipcRenderer.invoke('error:init'),
  errorRestart: () => ipcRenderer.invoke('error:restart'),
  errorOpenLogs: () => ipcRenderer.invoke('error:open-logs'),
});
