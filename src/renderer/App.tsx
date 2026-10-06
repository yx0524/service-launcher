import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from './store/useAppStore';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import AppCard from './components/AppCard';
import LogPanel from './components/LogPanel';
import AppDialog from './components/AppDialog';
import GroupDialog from './components/GroupDialog';
import SettingsDialog from './components/SettingsDialog';
import HealthCheckDialog from './components/HealthCheckDialog';
import PathRepairDialog from './components/PathRepairDialog';
import BackupDialog from './components/BackupDialog';
import Dashboard from './components/Dashboard';
import type { AppConfig, Group } from './types';

const clampZoom = (value: number) => Math.max(0.5, Math.min(2, Math.round(value * 10) / 10));

function App() {
  const apps = useAppStore((s) => s.apps);
  const groups = useAppStore((s) => s.groups);
  const statuses = useAppStore((s) => s.statuses);
  const settings = useAppStore((s) => s.settings);
  const selectedAppId = useAppStore((s) => s.selectedAppId);
  const selectedGroupId = useAppStore((s) => s.selectedGroupId);
  const logPanelOpen = useAppStore((s) => s.logPanelOpen);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const sortBy = useAppStore((s) => s.sortBy);
  const compactView = useAppStore((s) => s.compactView);
  const view = useAppStore((s) => s.view);

  const loadConfig = useAppStore((s) => s.loadConfig);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const hydrateStatuses = useAppStore((s) => s.hydrateStatuses);
  const applyStatus = useAppStore((s) => s.applyStatus);
  const appendLog = useAppStore((s) => s.appendLog);
  const setSelectedApp = useAppStore((s) => s.setSelectedApp);
  const toggleLogPanel = useAppStore((s) => s.toggleLogPanel);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);

  const [appDialogOpen, setAppDialogOpen] = useState(false);
  const [editingAppId, setEditingAppId] = useState<string | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [healthDialogOpen, setHealthDialogOpen] = useState(false);
  const [pathDialogOpen, setPathDialogOpen] = useState(false);
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const zoomRef = useRef(1);
  const zoomPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyZoom = useCallback(
    (value: number, persist: boolean) => {
      const zoom = clampZoom(value);
      zoomRef.current = zoom;
      window.electronAPI.setZoomFactor(zoom);
      if (!persist) return;
      if (zoomPersistTimer.current) clearTimeout(zoomPersistTimer.current);
      zoomPersistTimer.current = setTimeout(() => {
        const current = useAppStore.getState().settings;
        void window.electronAPI.saveSettings({ ...current, uiZoom: zoom });
      }, 600);
    },
    []
  );

  /* 订阅主进程事件 + 首次水合状态 */
  useEffect(() => {
    void loadConfig();
    void loadSettings();
    void hydrateStatuses();
    void useAppStore.getState().loadLanAddress();

    const offStatus = window.electronAPI.onStatusChanged(applyStatus);
    const offLog = window.electronAPI.onLog(appendLog);
    const offConfig = window.electronAPI.onConfigUpdated(() => {
      void useAppStore.getState().loadConfig();
    });
    const offSettings = window.electronAPI.onSettingsUpdated(() => {
      void useAppStore.getState().loadSettings();
    });

    // 通知主进程「界面已就绪」，自动启动在这之后才开始，状态事件不会丢
    window.electronAPI.rendererReady();

    return () => {
      offStatus();
      offLog();
      offConfig();
      offSettings();
    };
  }, [loadConfig, loadSettings, hydrateStatuses, applyStatus, appendLog]);

  /* 应用持久化的默认缩放 */
  useEffect(() => {
    applyZoom(settings.uiZoom || 1, false);
  }, [settings.uiZoom, applyZoom]);

  const openEditDialog = useCallback((appId: string | null) => {
    setEditingAppId(appId);
    setAppDialogOpen(true);
  }, []);

  const duplicateApp = useCallback(async (app: AppConfig) => {
    const copy: AppConfig = {
      ...app,
      id: crypto.randomUUID(),
      name: `${app.name} 副本`,
      processes: app.processes.map((p) => ({ ...p, id: crypto.randomUUID() })),
    };
    await window.electronAPI.saveApp(copy);
  }, []);

  const removeApp = useCallback(async (app: AppConfig) => {
    if (!confirm(`确定删除「${app.name}」吗？正在运行的进程会先被停止。`)) return;
    await window.electronAPI.deleteApp(app.id);
  }, []);

  const handleMenuAction = useCallback(
    async (action: string, appId: string) => {
      const app = useAppStore.getState().apps.find((a) => a.id === appId);
      switch (action) {
        case 'start':
          await window.electronAPI.startApp(appId);
          break;
        case 'stop':
          await window.electronAPI.stopApp(appId);
          break;
        case 'restart':
          await window.electronAPI.restartApp(appId);
          break;
        case 'edit':
          openEditDialog(appId);
          break;
        case 'duplicate':
          if (app) await duplicateApp(app);
          break;
        case 'delete':
          if (app) await removeApp(app);
          break;
        case 'viewLogs':
          setSelectedApp(appId);
          if (!useAppStore.getState().logPanelOpen) toggleLogPanel();
          break;
        case 'installService': {
          if (!app) break;
          if (
            !confirm(
              `把「${app.name}」注册成 Windows 服务？\n\n` +
                '· 开机自动启动，不需要登录 Windows\n' +
                '· 崩溃自动重启（10s → 30s → 60s）\n' +
                '· 会弹一次管理员授权（UAC），请点“是”'
            )
          )
            break;
          const result = await window.electronAPI.installService(appId);
          if (!result.success) alert(result.error || '注册失败');
          break;
        }
        case 'uninstallService': {
          if (!app) break;
          if (!confirm(`取消「${app.name}」的服务托管？会停止并注销 Windows 服务（程序文件保留）。`)) break;
          const result = await window.electronAPI.uninstallService(appId);
          if (!result.success) alert(result.error || '取消失败');
          break;
        }
        case 'openServiceLogs': {
          const result = await window.electronAPI.openServiceLogs(appId);
          if (!result.success) alert(result.error || '打开失败');
          break;
        }
      }
    },
    [openEditDialog, duplicateApp, removeApp, setSelectedApp, toggleLogPanel]
  );

  useEffect(() => {
    const off = window.electronAPI.onContextMenuAction(({ action, appId }) => {
      void handleMenuAction(action, appId);
    });
    return off;
  }, [handleMenuAction]);

  useKeyboardShortcuts({
    onRestart: () => {
      if (selectedAppId) void window.electronAPI.restartApp(selectedAppId);
    },
    onStartStop: () => {
      if (!selectedAppId) return;
      const appStatuses = useAppStore.getState().statuses[selectedAppId] || {};
      const active = Object.values(appStatuses).some(
        (s) => s.state === 'running' || s.state === 'starting' || s.state === 'error'
      );
      if (active) void window.electronAPI.stopApp(selectedAppId);
      else void window.electronAPI.startApp(selectedAppId);
    },
    onToggleLogs: toggleLogPanel,
    onFocusSearch: () => searchInputRef.current?.focus(),
    onEscape: () => {
      if (useAppStore.getState().searchQuery) setSearchQuery('');
      else setSelectedApp(null);
    },
    onZoomIn: () => applyZoom(zoomRef.current + 0.1, true),
    onZoomOut: () => applyZoom(zoomRef.current - 0.1, true),
    onZoomReset: () => applyZoom(useAppStore.getState().settings.uiZoom || 1, false),
    onQuit: () => {
      const active = Object.values(useAppStore.getState().statuses).some((forApp) =>
        Object.values(forApp).some((s) => s.state === 'running' || s.state === 'starting')
      );
      if (!active || confirm('退出会先停止「由启动器启动的」服务；手工启动的不受影响。确定退出？')) {
        window.electronAPI.quit();
      }
    },
  });

  const visibleApps = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = apps.filter((app) => {
      if (selectedGroupId && selectedGroupId !== 'all' && app.groupId !== selectedGroupId) return false;
      if (!query) return true;
      if (app.name.toLowerCase().includes(query)) return true;
      if (app.description?.toLowerCase().includes(query)) return true;
      const group = groups.find((g) => g.id === app.groupId);
      if (group?.name.toLowerCase().includes(query)) return true;
      return app.processes.some(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.command.toLowerCase().includes(query) ||
          (p.match || '').toLowerCase().includes(query)
      );
    });

    if (sortBy === 'name') return [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    if (sortBy === 'status') {
      const priority = (appId: string) => {
        const list = Object.values(statuses[appId] || {});
        if (list.some((s) => s.state === 'error')) return 0;
        if (list.some((s) => s.state === 'running')) return 1;
        if (list.some((s) => s.state === 'starting')) return 2;
        return 3;
      };
      return [...filtered].sort((a, b) => priority(a.id) - priority(b.id));
    }
    return filtered;
  }, [apps, groups, searchQuery, selectedGroupId, sortBy, statuses]);

  const gridClass = compactView
    ? logPanelOpen
      ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
      : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
    : logPanelOpen
    ? 'grid-cols-1 lg:grid-cols-2'
    : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3';

  return (
    <div className="flex h-screen bg-gray-900 overflow-hidden">
      <Sidebar
        onAddGroup={() => {
          setEditingGroup(null);
          setGroupDialogOpen(true);
        }}
        onEditGroup={(group) => {
          setEditingGroup(group);
          setGroupDialogOpen(true);
        }}
        onOpenSettings={() => setSettingsDialogOpen(true)}
        onOpenHealth={() => setHealthDialogOpen(true)}
        onOpenPathRepair={() => setPathDialogOpen(true)}
        onOpenBackups={() => setBackupDialogOpen(true)}
        onExportDiagnostics={async () => {
          const { logs, apps } = useAppStore.getState();
          const nameOf = (appId: string) => apps.find((a) => a.id === appId)?.name ?? appId;
          const lines: string[] = [];
          for (const [appId, entries] of Object.entries(logs)) {
            for (const entry of entries) {
              lines.push(
                `[${new Date(entry.timestamp).toLocaleString()}] [${entry.type}] [${nameOf(appId)} / ${entry.processName}] ${entry.content.trimEnd()}`
              );
            }
          }
          try {
            const file = await window.electronAPI.exportDiagnostics(lines.join('\n'));
            if (file) alert(`诊断包已导出：\n${file}`);
          } catch (error) {
            alert(`导出失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <Toolbar
          ref={searchInputRef}
          onAddApp={() => openEditDialog(null)}
        />

        {view === 'dashboard' ? (
          <Dashboard />
        ) : (
        <div className="flex-1 overflow-auto p-3 lg:p-4">
          <div className={`grid gap-3 ${gridClass}`}>
            {visibleApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                compact={compactView}
                onEdit={() => openEditDialog(app.id)}
              />
            ))}
          </div>

          {visibleApps.length === 0 && (
            <div className="flex items-center justify-center h-64 text-gray-500">
              <div className="text-center">
                <p className="text-xl mb-2">{apps.length === 0 ? '还没有配置任何服务' : '没有匹配的服务'}</p>
                <p className="text-sm">
                  {apps.length === 0 ? '点右上角「+」添加第一个服务' : '换个关键词或切换分组试试'}
                </p>
              </div>
            </div>
          )}
        </div>
        )}
      </div>

      {logPanelOpen && <LogPanel />}

      {appDialogOpen && (
        <AppDialog appId={editingAppId} onClose={() => setAppDialogOpen(false)} />
      )}

      {groupDialogOpen && (
        <GroupDialog group={editingGroup} onClose={() => setGroupDialogOpen(false)} />
      )}

      {settingsDialogOpen && (
        <SettingsDialog
          onClose={() => setSettingsDialogOpen(false)}
          onZoomPreview={(zoom) => applyZoom(zoom, false)}
        />
      )}

      {healthDialogOpen && <HealthCheckDialog onClose={() => setHealthDialogOpen(false)} />}
      {pathDialogOpen && <PathRepairDialog onClose={() => setPathDialogOpen(false)} />}
      {backupDialogOpen && <BackupDialog onClose={() => setBackupDialogOpen(false)} />}
    </div>
  );
}

export default App;
