import { create } from 'zustand';
import type {
  AppConfig,
  AppLogEntry,
  AppSettings,
  Group,
  ProcessStatus,
} from '../types';

export const DEFAULT_SETTINGS: AppSettings = {
  maxLogsPerApp: 2000,
  autoScrollLogs: true,
  autostartDelayMs: 1200,
  uiZoom: 1,
  logPersistenceEnabled: true,
  maxLogFileMB: 10,
  logRetentionDays: 7,
};

/** 日志刷新节流：后台服务刷屏时，每 120ms 合并一次，避免每条日志都触发一次全量拷贝和重渲染。 */
const LOG_FLUSH_MS = 120;

interface AppStore {
  apps: AppConfig[];
  groups: Group[];
  statuses: Record<string, Record<string, ProcessStatus>>;
  logs: Record<string, AppLogEntry[]>;
  settings: AppSettings;

  selectedAppId: string | null;
  selectedGroupId: string | null;
  logPanelOpen: boolean;
  searchQuery: string;
  sortBy: 'none' | 'name' | 'status';
  compactView: boolean;
  /** 当前页面：总览 还是 服务卡片。 */
  view: 'dashboard' | 'services';
  /** 局域网地址（有端口时用它在卡片上拼访问地址）。 */
  lanAddress: string | null;

  loadConfig: () => Promise<void>;
  loadSettings: () => Promise<void>;
  hydrateStatuses: () => Promise<void>;
  applyStatus: (status: ProcessStatus) => void;
  appendLog: (entry: AppLogEntry) => void;
  clearLogs: (appId: string) => void;

  setSettings: (settings: AppSettings) => void;
  setSelectedApp: (appId: string | null) => void;
  setSelectedGroup: (groupId: string | null) => void;
  toggleLogPanel: () => void;
  setSearchQuery: (query: string) => void;
  setSortBy: (sortBy: 'none' | 'name' | 'status') => void;
  toggleCompactView: () => void;
  setView: (view: 'dashboard' | 'services') => void;
  loadLanAddress: () => Promise<void>;
}

export const useAppStore = create<AppStore>((set) => {
  let logBuffer: AppLogEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let logSeq = 0;

  const flushLogs = () => {
    flushTimer = null;
    if (logBuffer.length === 0) return;
    const batch = logBuffer;
    logBuffer = [];

    set((state) => {
      const cap = Math.max(100, state.settings.maxLogsPerApp);
      const logs = { ...state.logs };

      const grouped = new Map<string, AppLogEntry[]>();
      for (const entry of batch) {
        const list = grouped.get(entry.appId);
        if (list) list.push(entry);
        else grouped.set(entry.appId, [entry]);
      }

      for (const [appId, entries] of grouped) {
        const merged = (logs[appId] || []).concat(entries);
        // 只在明显超限时裁剪，避免每条日志都复制整个数组
        logs[appId] = merged.length > cap * 1.5 ? merged.slice(-cap) : merged;
      }
      return { logs };
    });
  };

  return {
    apps: [],
    groups: [],
    statuses: {},
    logs: {},
    settings: DEFAULT_SETTINGS,
    selectedAppId: null,
    selectedGroupId: 'all',
    logPanelOpen: false,
    searchQuery: '',
    sortBy: 'none',
    // 服务一多，默认用紧凑视图，一屏能多看几行
    compactView: true,
    view: 'dashboard',
    lanAddress: null,

    loadConfig: async () => {
      const { apps, groups } = await window.electronAPI.getConfig();
      set((state) => {
        // 删掉的应用不再保留状态和日志
        const validIds = new Set(apps.map((a) => a.id));
        const statuses = Object.fromEntries(
          Object.entries(state.statuses).filter(([appId]) => validIds.has(appId))
        );
        const logs = Object.fromEntries(
          Object.entries(state.logs).filter(([appId]) => validIds.has(appId))
        );
        const selectedAppId =
          state.selectedAppId && validIds.has(state.selectedAppId) ? state.selectedAppId : null;
        return { apps, groups, statuses, logs, selectedAppId };
      });
    },

    loadSettings: async () => {
      const settings = await window.electronAPI.getSettings();
      set({ settings: { ...DEFAULT_SETTINGS, ...settings } });
    },

    hydrateStatuses: async () => {
      const list = await window.electronAPI.getStatuses();
      const statuses: Record<string, Record<string, ProcessStatus>> = {};
      for (const status of list) {
        if (!statuses[status.appId]) statuses[status.appId] = {};
        statuses[status.appId][status.processId] = status;
      }
      set({ statuses });
    },

    applyStatus: (status) => {
      set((state) => {
        const forApp = state.statuses[status.appId] || {};
        if (forApp[status.processId] === status) return state;

        return {
          statuses: {
            ...state.statuses,
            [status.appId]: { ...forApp, [status.processId]: status },
          },
        };
      });
    },

    appendLog: (entry) => {
      logSeq += 1;
      logBuffer.push({ ...entry, seq: logSeq });
      if (flushTimer === null) flushTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
    },

    clearLogs: (appId) => {
      logBuffer = logBuffer.filter((entry) => entry.appId !== appId);
      set((state) => ({ logs: { ...state.logs, [appId]: [] } }));
    },

    setSettings: (settings) => set({ settings }),
    setSelectedApp: (appId) => set({ selectedAppId: appId }),
    setSelectedGroup: (groupId) => set({ selectedGroupId: groupId }),
    toggleLogPanel: () => set((state) => ({ logPanelOpen: !state.logPanelOpen })),
    setSearchQuery: (query) => set({ searchQuery: query }),
    setSortBy: (sortBy) => set({ sortBy }),
    toggleCompactView: () => set((state) => ({ compactView: !state.compactView })),
    setView: (view) => set({ view }),
    loadLanAddress: async () => {
      const address = await window.electronAPI.getLanAddress();
      set({ lanAddress: address });
    },
  };
});
