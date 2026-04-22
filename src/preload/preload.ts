import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // State
  getState: () => ipcRenderer.invoke('state:get'),
  setActive: (isActive: boolean) => ipcRenderer.invoke('state:set-active', isActive),
  setTime: (time: string) => ipcRenderer.invoke('state:set-time', time),
  setLaunchAtStartup: (enabled: boolean) =>
    ipcRenderer.invoke('state:set-launch-at-startup', enabled),

  // Actions
  runNow: () => ipcRenderer.invoke('action:run-now'),
  signIn: () => ipcRenderer.invoke('action:sign-in'),
  resetConnection: () => ipcRenderer.invoke('action:reset-connection'),
  testConnection: () => ipcRenderer.invoke('action:test-connection'),

  // Config (in-app editor)
  configRead: () => ipcRenderer.invoke('config:read'),
  configValidate: (text: string) => ipcRenderer.invoke('config:validate', text),
  configSave: (text: string) => ipcRenderer.invoke('config:save', text),

  // Logs
  getLogs: (window: 'last-run' | '3d' | '7d' | '15d' | '30d') =>
    ipcRenderer.invoke('logs:get', window),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),

  // Engagements tab
  fetchEngagements: () => ipcRenderer.invoke('engagements:fetch'),
  callAction: (recordId: string, actionType: 'customer' | 'internal', duration: string) =>
    ipcRenderer.invoke('engagements:call-action', { recordId, actionType, duration }),
  endCall: (recordId: string) =>
    ipcRenderer.invoke('engagements:end-call', { recordId }),
  clearStaleTimers: (scheduledIds: string[]) =>
    ipcRenderer.invoke('engagements:clear-stale-timers', { scheduledIds }),
  workingAction: (recordId: string, currentStatus: string) =>
    ipcRenderer.invoke('engagements:working-action', { recordId, currentStatus }),
  openRecord: (recordId: string) =>
    ipcRenderer.invoke('engagements:open-record', { recordId }),

  // Paths (About tab)
  getPaths: () => ipcRenderer.invoke('paths:get'),

  // Subscriptions
  onStateChanged: (cb: (state: any) => void) =>
    ipcRenderer.on('state:changed', (_e, s) => cb(s)),
  onTrayRunNow: (cb: () => void) =>
    ipcRenderer.on('tray:run-now', () => cb()),
  onLogAppend: (cb: (entry: { ts: string; level: 'info' | 'success' | 'error'; message: string }) => void) =>
    ipcRenderer.on('log:append', (_e, entry) => cb(entry)),
  onAutoEndCall: (cb: (data: { recordId: string; newStatus: string }) => void) =>
    ipcRenderer.on('engagements:auto-end-call', (_e, data) => cb(data)),
  onEngagementsRefresh: (cb: () => void) =>
    ipcRenderer.on('engagements:refresh', () => cb()),
};

contextBridge.exposeInMainWorld('companion', api);

export type CompanionApi = typeof api;