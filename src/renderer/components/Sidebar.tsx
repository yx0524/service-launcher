import { useEffect, useState } from 'react';
import {
  Download,
  Folder,
  History,
  LayoutDashboard,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  Settings,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Upload,
  Wrench,
  FileArchive,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { Group } from '../types';

interface SidebarProps {
  onAddGroup: () => void;
  onEditGroup: (group: Group) => void;
  onOpenSettings: () => void;
  onOpenHealth: () => void;
  onOpenPathRepair: () => void;
  onOpenBackups: () => void;
  onExportDiagnostics: () => void | Promise<void>;
}

export default function Sidebar({
  onAddGroup,
  onEditGroup,
  onOpenSettings,
  onOpenHealth,
  onOpenPathRepair,
  onOpenBackups,
  onExportDiagnostics,
}: SidebarProps) {
  const apps = useAppStore((s) => s.apps);
  const groups = useAppStore((s) => s.groups);
  const statuses = useAppStore((s) => s.statuses);
  const selectedGroupId = useAppStore((s) => s.selectedGroupId);
  const setSelectedGroup = useAppStore((s) => s.setSelectedGroup);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [elevated, setElevated] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  useEffect(() => {
    void window.electronAPI.getAutoLaunch().then(setAutoLaunch);
    void window.electronAPI.isElevated().then(setElevated);
  }, []);

  const runningInGroup = (groupId: string) =>
    apps.filter((app) => {
      if (app.groupId !== groupId) return false;
      const list = Object.values(statuses[app.id] || {});
      return list.some((s) => s.state === 'running' || s.state === 'starting');
    }).length;

  const handleDeleteGroup = async (group: Group) => {
    const count = apps.filter((a) => a.groupId === group.id).length;
    const message =
      count > 0
        ? `删除分组「${group.name}」？组内 ${count} 个服务会移到第一个分组，不会被删除。`
        : `删除分组「${group.name}」？`;
    if (!confirm(message)) return;
    await window.electronAPI.deleteGroup(group.id);
    if (selectedGroupId === group.id) setSelectedGroup('all');
  };

  const menuItem =
    'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white text-left';

  /** 拖拽结束：把被拖的分组插到目标位置并存下来。 */
  const handleDrop = async (targetId: string) => {
    const source = dragId;
    setDragId(null);
    setOverId(null);
    if (!source || source === targetId) return;
    const ids = groups.map((g) => g.id);
    const from = ids.indexOf(source);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    await window.electronAPI.reorderGroups(ids);
  };

  return (
    <div className="relative w-56 bg-gray-800 border-r border-gray-700 flex flex-col min-h-0 flex-shrink-0">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-base font-bold text-white truncate flex items-center gap-2">
          进程启动器
          {elevated ? (
            <span
              className="text-[11px] font-normal px-1.5 py-0.5 rounded bg-emerald-600/25 text-emerald-300 flex items-center gap-1 flex-shrink-0"
              title="以管理员身份运行，启停 Windows 服务不会再弹 UAC"
            >
              <ShieldCheck size={11} /> 管理员
            </span>
          ) : null}
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-1">
        <button
          onClick={() => setView('dashboard')}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
            view === 'dashboard' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700'
          }`}
        >
          <LayoutDashboard size={16} className="flex-shrink-0" />
          总览
        </button>

        <button
          onClick={() => {
            setView('services');
            setSelectedGroup('all');
          }}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors ${
            view === 'services' && selectedGroupId === 'all'
              ? 'bg-blue-600 text-white'
              : 'text-gray-300 hover:bg-gray-700'
          }`}
        >
          <span className="flex items-center gap-2 text-sm truncate">
            <Folder size={16} className="flex-shrink-0" />
            所有服务
          </span>
          <span className="text-xs flex-shrink-0">{apps.length}</span>
        </button>

        <div className="pt-3 pb-1 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-400 uppercase">分组</span>
          <button onClick={onAddGroup} className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white" title="添加分组">
            <Plus size={15} />
          </button>
        </div>

        {groups.map((group) => {
          const appCount = apps.filter((a) => a.groupId === group.id).length;
          const running = runningInGroup(group.id);
          const isDragging = dragId === group.id;
          const isOver = overId === group.id && dragId !== null && dragId !== group.id;
          return (
            <div
              key={group.id}
              draggable
              onDragStart={() => setDragId(group.id)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverId(group.id);
              }}
              onDragLeave={() => setOverId((current) => (current === group.id ? null : current))}
              onDrop={() => void handleDrop(group.id)}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              title="按住拖动可以调整分组顺序"
              className={`group flex items-center rounded-lg cursor-grab active:cursor-grabbing transition-all ${
                isDragging ? 'opacity-40' : ''
              } ${isOver ? 'ring-1 ring-blue-400' : ''} ${
                selectedGroupId === group.id ? 'bg-blue-600' : 'hover:bg-gray-700'
              }`}
            >
              <button
                onClick={() => {
                  setView('services');
                  setSelectedGroup(group.id);
                }}
                className={`flex-1 flex items-center justify-between px-3 py-2 min-w-0 ${
                  view === 'services' && selectedGroupId === group.id ? 'text-white' : 'text-gray-300'
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: group.color }} />
                  <span className="text-sm truncate">{group.name}</span>
                </span>
                <span className="text-xs flex-shrink-0 ml-1">
                  {running > 0 ? (
                    <span className="text-green-400">
                      {running}/{appCount}
                    </span>
                  ) : (
                    appCount
                  )}
                </span>
              </button>
              <div className="hidden group-hover:flex items-center pr-1 gap-0.5">
                <button
                  onClick={() => onEditGroup(group)}
                  className="p-1 rounded text-gray-300 hover:text-white hover:bg-black/20"
                  title="编辑分组"
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={() => void handleDeleteGroup(group)}
                  className="p-1 rounded text-gray-300 hover:text-red-300 hover:bg-black/20"
                  title="删除分组"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-3 border-t border-gray-700 space-y-2 flex-shrink-0">
        <button
          onClick={async () => {
            const next = !autoLaunch;
            const result = await window.electronAPI.setAutoLaunch(next);
            if (result.success) setAutoLaunch(next);
            else alert(result.error || '设置开机自启失败');
          }}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors text-sm ${
            autoLaunch
              ? 'bg-blue-600/90 text-white'
              : 'bg-gray-700/50 text-gray-300 hover:bg-gray-700'
          }`}
          title="Windows 登录后自动打开启动器"
        >
          <span className="flex items-center gap-2">
            <Power size={15} />
            开机自启
          </span>
          <span className={`w-8 h-4 rounded-full relative transition-colors ${autoLaunch ? 'bg-blue-400' : 'bg-gray-500'}`}>
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${
                autoLaunch ? 'left-4' : 'left-0.5'
              }`}
            />
          </span>
        </button>

        <div className="flex gap-2">
          <button
            onClick={onOpenSettings}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-700 text-sm"
          >
            <Settings size={15} />
            设置
          </button>
          <button
            onClick={() => setMenuOpen((open) => !open)}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm ${
              menuOpen ? 'bg-gray-700 text-white' : 'bg-gray-700/50 text-gray-300 hover:bg-gray-700'
            }`}
          >
            <MoreHorizontal size={15} />
            更多
          </button>
        </div>
      </div>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
          <div className="absolute bottom-16 left-3 w-48 z-40 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 overflow-hidden">
            <button
              className={menuItem}
              onClick={() => {
                setMenuOpen(false);
                onOpenHealth();
              }}
            >
              <Stethoscope size={14} /> 环境体检
            </button>
            <button
              className={menuItem}
              onClick={() => {
                setMenuOpen(false);
                onOpenPathRepair();
              }}
            >
              <Wrench size={14} /> 路径体检
            </button>
            <button
              className={`${menuItem} ${elevated ? 'opacity-50 cursor-default hover:bg-transparent' : ''}`}
              disabled={elevated}
              onClick={async () => {
                setMenuOpen(false);
                if (elevated) return;
                if (
                  !confirm(
                    '以管理员身份重启启动器？\n\n· Windows 会弹一次 UAC，请点「是」\n· 会先停掉本启动器拉起的服务，再以管理员身份重新启动\n· 提权后启停 Windows 服务就不再弹授权框了'
                  )
                ) {
                  return;
                }
                const result = await window.electronAPI.restartAsAdmin();
                if (!result.success) alert(`以管理员身份重启失败：${result.error || '未知错误'}`);
              }}
              title={elevated ? '当前已经是管理员身份运行' : '重新以管理员身份启动（启停服务不再弹 UAC）'}
            >
              <ShieldCheck size={14} /> {elevated ? '已是管理员权限' : '以管理员身份重启'}
            </button>
            <div className="my-1 border-t border-gray-700" />
            <button
              className={menuItem}
              onClick={async () => {
                setMenuOpen(false);
                try {
                  const file = await window.electronAPI.exportConfig();
                  if (file) alert(`已导出到：\n${file}`);
                } catch (error) {
                  alert(`导出失败：${error instanceof Error ? error.message : String(error)}`);
                }
              }}
            >
              <Download size={14} /> 导出配置
            </button>
            <button
              className={menuItem}
              onClick={async () => {
                setMenuOpen(false);
                if (!confirm('导入会覆盖当前所有服务配置（会先自动备份一份），继续吗？')) return;
                const result = await window.electronAPI.importConfig();
                if (result.success) {
                  alert(`导入成功：${result.imported?.apps ?? 0} 个服务、${result.imported?.groups ?? 0} 个分组`);
                } else {
                  alert(`导入失败：${result.error || '未知错误'}`);
                }
              }}
            >
              <Upload size={14} /> 导入配置
            </button>
            <button
              className={menuItem}
              onClick={() => {
                setMenuOpen(false);
                onOpenBackups();
              }}
            >
              <History size={14} /> 恢复备份
            </button>
            <button
              className={menuItem}
              onClick={() => {
                setMenuOpen(false);
                void onExportDiagnostics();
              }}
            >
              <FileArchive size={14} /> 导出诊断包
            </button>
          </div>
        </>
      )}
    </div>
  );
}
