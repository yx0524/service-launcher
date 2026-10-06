import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { ElectronAPI } from './types';

/** 统一订阅封装：返回取消订阅函数，避免重复注册导致监听器泄漏。 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: ElectronAPI = {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getStatuses: () => ipcRenderer.invoke('get-statuses'),
  getMetrics: (hours) => ipcRenderer.invoke('get-metrics', hours),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  saveApp: (config) => ipcRenderer.invoke('save-app', config),
  deleteApp: (appId) => ipcRenderer.invoke('delete-app', appId),
  launchShortcut: (appId) => ipcRenderer.invoke('launch-shortcut', appId),
  saveGroup: (group) => ipcRenderer.invoke('save-group', group),
  deleteGroup: (groupId) => ipcRenderer.invoke('delete-group', groupId),
  reorderGroups: (groupIds) => ipcRenderer.invoke('reorder-groups', groupIds),
  installService: (appId) => ipcRenderer.invoke('install-service', appId),
  uninstallService: (appId) => ipcRenderer.invoke('uninstall-service', appId),
  openServiceLogs: (appId) => ipcRenderer.invoke('open-service-logs', appId),

  startApp: (appId) => ipcRenderer.invoke('start-app', appId),
  stopApp: (appId) => ipcRenderer.invoke('stop-app', appId),
  restartApp: (appId) => ipcRenderer.invoke('restart-app', appId),
  stopAll: () => ipcRenderer.invoke('stop-all'),
  restartFailed: () => ipcRenderer.invoke('restart-failed'),
  killPid: (pid) => ipcRenderer.invoke('kill-pid', pid),

  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openPath: (target) => ipcRenderer.invoke('open-path', target),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  saveTextFile: (content, defaultName) => ipcRenderer.invoke('save-text-file', content, defaultName),
  openLogsDir: () => ipcRenderer.invoke('open-logs-dir'),

  exportConfig: (options) => ipcRenderer.invoke('export-config', options),
  importConfig: () => ipcRenderer.invoke('import-config'),

  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  getLanAddress: () => ipcRenderer.invoke('get-lan-address'),

  checkAll: () => ipcRenderer.invoke('check-all'),
  checkPaths: () => ipcRenderer.invoke('check-paths'),
  replacePathPrefix: (from, to) => ipcRenderer.invoke('replace-path-prefix', from, to),
  listBackups: () => ipcRenderer.invoke('list-backups'),
  restoreBackup: (file) => ipcRenderer.invoke('restore-backup', file),
  exportDiagnostics: (logs) => ipcRenderer.invoke('export-diagnostics', logs),
  setZoomFactor: (factor) => {
    const clamped = Math.max(0.5, Math.min(2, Number(factor) || 1));
    webFrame.setZoomFactor(clamped);
  },
  getZoomFactor: () => webFrame.getZoomFactor(),
  rendererReady: () => ipcRenderer.send('renderer-ready'),
  quit: () => ipcRenderer.send('quit-app'),

  showAppContextMenu: (appId, isRunning) =>
    ipcRenderer.invoke('show-app-context-menu', appId, isRunning),

  onStatusChanged: (callback) => subscribe('status-changed', callback),
  onLog: (callback) => subscribe('log', callback),
  onConfigUpdated: (callback) => subscribe('config-updated', callback),
  onSettingsUpdated: (callback) => subscribe('settings-updated', callback),
  onContextMenuAction: (callback) => subscribe('context-menu-action', callback),
};

contextBridge.exposeInMainWorld('electronAPI', api);
