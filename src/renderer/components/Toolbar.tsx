import { forwardRef, useState } from 'react';
import {
  ArrowUpDown,
  HelpCircle,
  LayoutGrid,
  List,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Power,
  RotateCw,
  Search,
  Square,
  X,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp';

interface ToolbarProps {
  onAddApp: () => void;
}

/** 次要工具按钮：默认不带底色，hover 才亮，避免工具栏变成一排灰块。 */
const iconButton = 'p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors';
/** 带文字的主操作按钮 */
const labelButton = 'px-3 py-2 rounded-lg text-sm flex items-center gap-1.5 transition-colors whitespace-nowrap';

const Toolbar = forwardRef<HTMLInputElement, ToolbarProps>(({ onAddApp }, ref) => {
  const apps = useAppStore((s) => s.apps);
  const statuses = useAppStore((s) => s.statuses);
  const settings = useAppStore((s) => s.settings);
  const selectedGroupId = useAppStore((s) => s.selectedGroupId);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const sortBy = useAppStore((s) => s.sortBy);
  const setSortBy = useAppStore((s) => s.setSortBy);
  const logPanelOpen = useAppStore((s) => s.logPanelOpen);
  const toggleLogPanel = useAppStore((s) => s.toggleLogPanel);
  const compactView = useAppStore((s) => s.compactView);
  const toggleCompactView = useAppStore((s) => s.toggleCompactView);

  const [showHelp, setShowHelp] = useState(false);
  const [busy, setBusy] = useState(false);

  const groupApps = apps.filter(
    (app) => !selectedGroupId || selectedGroupId === 'all' || app.groupId === selectedGroupId
  );

  const isActive = (appId: string) =>
    Object.values(statuses[appId] || {}).some(
      (s) => s.state === 'running' || s.state === 'starting' || s.state === 'error'
    );

  const failedCount = apps.filter((app) =>
    Object.values(statuses[app.id] || {}).some((s) => s.state === 'error')
  ).length;

  const handleStartAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (const app of groupApps) {
        if (!isActive(app.id)) await window.electronAPI.startApp(app.id);
        if (settings.autostartDelayMs > 0) {
          await new Promise((r) => setTimeout(r, settings.autostartDelayMs));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const handleStopAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (const app of groupApps) {
        if (isActive(app.id)) await window.electronAPI.stopApp(app.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const anyRunning = groupApps.some((app) => isActive(app.id));
  const anyRunningGlobally = apps.some((app) => isActive(app.id));

  return (
    <>
      <div className="h-14 bg-gray-800 border-b border-gray-700 flex items-center justify-between gap-3 px-4 flex-shrink-0">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
            <input
              ref={ref}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索服务、命令或端口..."
              className="w-full pl-8 pr-8 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                title="清除搜索"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <ArrowUpDown size={16} className="text-gray-400" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'none' | 'name' | 'status')}
              className="px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none"
            >
              <option value="none">默认排序</option>
              <option value="name">按名称</option>
              <option value="status">按状态</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {groupApps.length > 0 && (
            <>
              <button
                onClick={handleStartAll}
                disabled={busy}
                className={`${labelButton} bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white`}
                title={`按顺序启动当前分组的 ${groupApps.length} 个服务（等前一个就绪再启下一个）`}
              >
                <Play size={16} />
                启动
              </button>
              {anyRunning && (
                <button
                  onClick={handleStopAll}
                  disabled={busy}
                  className={`${labelButton} bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white`}
                  title="停止当前分组正在运行的服务"
                >
                  <Square size={16} />
                  停止
                </button>
              )}
            </>
          )}

          {anyRunningGlobally && (
            <button
              onClick={async () => {
                if (!confirm('停止所有正在运行的托管服务？')) return;
                setBusy(true);
                try {
                  const result = await window.electronAPI.stopAll();
                  if (!result.success) alert(result.error || '停止失败');
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className={`${labelButton} bg-gray-700/60 hover:bg-gray-700 disabled:opacity-50 text-gray-200`}
              title="停止所有分组里正在运行的服务"
            >
              <Power size={16} />
              全部停止
            </button>
          )}

          {failedCount > 0 && (
            <button
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await window.electronAPI.restartFailed();
                  if (!result.success) alert(result.error || '重启失败');
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className={`${labelButton} bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white`}
              title={`重新拉起 ${failedCount} 个异常服务`}
            >
              <RotateCw size={16} />
              重启异常
            </button>
          )}

          <div className="w-px h-6 bg-gray-700 mx-1" />

          <button onClick={toggleCompactView} className={iconButton} title={compactView ? '切换普通视图' : '切换紧凑视图'}>
            {compactView ? <LayoutGrid size={17} /> : <List size={17} />}
          </button>

          <button onClick={toggleLogPanel} className={iconButton} title={logPanelOpen ? '隐藏日志' : '显示日志'}>
            {logPanelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>

          <button onClick={() => setShowHelp(true)} className={iconButton} title="键盘快捷键">
            <HelpCircle size={17} />
          </button>

          <button
            onClick={onAddApp}
            className={`${labelButton} bg-blue-600 hover:bg-blue-700 text-white`}
            title="添加服务"
          >
            <Plus size={16} />
            添加
          </button>
        </div>
      </div>

      {showHelp && <KeyboardShortcutsHelp onClose={() => setShowHelp(false)} />}
    </>
  );
});

Toolbar.displayName = 'Toolbar';

export default Toolbar;
