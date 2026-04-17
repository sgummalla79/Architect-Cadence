import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // State
  getState: () => ipcRenderer.invoke('state:get'),
  setActive: (isActive: boolean) => ipcRenderer.invoke('state:set-active', isActive),
  setTime: (time: string) => ipcRenderer.invoke('state:set-time', time),

  // Actions
  runNow: () => ipcRenderer.invoke('action:run-now'),
  signIn: () => ipcRenderer.invoke('action:sign-in'),
  resetConnection: () => ipcRenderer.invoke('action:reset-connection'),
  testConnection: () => ipcRenderer.invoke('action:test-connection'),
  editConfig: () => ipcRenderer.invoke('action:edit-config'),
  validateConfig: () => ipcRenderer.invoke('action:validate-config'),
  clearLogs: () => ipcRenderer.invoke('action:clear-logs'),

  // Subscriptions
  onStateChanged: (cb: (state: any) => void) =>
    ipcRenderer.on('state:changed', (_e, s) => cb(s)),
  onTrayRunNow: (cb: () => void) =>
    ipcRenderer.on('tray:run-now', () => cb()),
  onLogAppend: (cb: (entry: { ts: string; level: 'info' | 'success' | 'error'; message: string }) => void) =>
    ipcRenderer.on('log:append', (_e, entry) => cb(entry)),
};

contextBridge.exposeInMainWorld('cadence', api);

export type CadenceApi = typeof api;