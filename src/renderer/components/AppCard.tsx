import { useEffect, useState } from 'react';
import { Circle, Clock, Copy, Edit, ExternalLink, Play, RefreshCw, RotateCw, Server, Square, Trash2, Zap } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { formatMemory, formatUptime } from '../format';
import type { AppConfig, ProcessStatus, SimpleResult } from '../types';

interface AppCardProps {
  app: AppConfig;
  compact: boolean;
  onEdit: () => void;
}

const stateText: Record<ProcessStatus['state'], string> = {
  running: '运行中',
  starting: '启动中',
  stopped: '已停止',
  error: '错误',
};

const stateColor: Record<ProcessStatus['state'], string> = {
  running: 'text-green-400',
  starting: 'text-yellow-400',
  stopped: 'text-gray-500',
  error: 'text-red-400',
};

export default function AppCard({ app, compact, onEdit }: AppCardProps) {
  const appStatuses = useAppStore((s) => s.statuses[app.id]);
  const groups = useAppStore((s) => s.groups);
  const lanAddress = useAppStore((s) => s.lanAddress);
  const selected = useAppStore((s) => s.selectedAppId === app.id);
  const setSelectedApp = useAppStore((s) => s.setSelectedApp);
  const [, tick] = useState(0);

  const group = groups.find((g) => g.id === app.groupId);
  const entries: ProcessStatus[] = app.processes.map(
    (proc) =>
      appStatuses?.[proc.id] ?? {
        appId: app.id,
        processId: proc.id,
        state: 'stopped',
        ports: [],
        restartCount: 0,
      }
  );

  const hasError = entries.some((s) => s.state === 'error');
  const isRunning = entries.some((s) => s.state === 'running');
  const isStarting = entries.some((s) => s.state === 'starting');
  const isActive = isRunning || isStarting || hasError;

  // 运行中每秒刷新一次运行时长
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  const run = async (action: () => Promise<SimpleResult>) => {
    const result = await action();
    if (!result?.success) alert(result?.error || '操作失败');
  };

  const startedAt = entries
    .map((s) => s.startedAt)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b)[0];
  const restartCount = entries.reduce((sum, s) => sum + (s.restartCount || 0), 0);
  const errorEntries = entries.filter((s) => s.state === 'error');
  const serviceManaged = app.processes[0]?.service;

  /** 注册 / 取消 Windows 服务托管（会弹一次 UAC）。 */
  const toggleService = async () => {
    if (serviceManaged) {
      if (
        !confirm(
          `取消「${app.name}」的服务托管？\n\n· 会停止并注销 Windows 服务\n· 程序文件和日志都保留\n· 以后想常驻可以再点这个按钮注册回来`
        )
      )
        return;
      const result = await window.electronAPI.uninstallService(app.id);
      if (!result.success) alert(result.error || '取消失败');
      return;
    }
    if (
      !confirm(
        `把「${app.name}」注册成 Windows 服务？\n\n` +
          '· 开机自动启动，不需要登录 Windows\n' +
          '· 崩溃自动重启（10s → 30s → 60s）\n' +
          '· 会弹一次管理员授权（UAC），请点“是”\n' +
          '· 注册后别再手工启动它，避免两边抢单实例锁'
      )
    )
      return;
    const result = await window.electronAPI.installService(app.id);
    if (!result.success) alert(result.error || '注册失败');
  };

  /* ---------- 快捷方式：只管打开，不跟踪状态 ---------- */
  if (app.kind === 'shortcut') {
    return (
      <div
        onClick={() => setSelectedApp(app.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          void window.electronAPI.showAppContextMenu(app.id, false);
        }}
        className={`bg-gray-800 rounded-lg transition-colors cursor-pointer relative overflow-hidden ${
          compact ? 'p-3' : 'p-4'
        } ${selected ? 'border-2 border-blue-500' : 'border border-gray-700 hover:border-gray-600'}`}
      >
        {group && (
          <div className="absolute top-0 left-0 w-1 h-full" style={{ backgroundColor: group.color }} />
        )}
        <div className="ml-2">
          <div className="flex items-center gap-2 mb-1 min-w-0">
            <h3 className="text-sm font-semibold text-white truncate">{app.name}</h3>
            {group && (
              <span
                className="text-xs px-1.5 py-0.5 rounded whitespace-nowrap"
                style={{ backgroundColor: `${group.color}20`, color: group.color }}
              >
                {group.name}
              </span>
            )}
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 whitespace-nowrap">
              快捷方式
            </span>
          </div>
          {app.description && (
            <p className="text-xs text-gray-400 mb-2 truncate" title={app.description}>
              {app.description}
            </p>
          )}
          <p className="text-xs text-gray-500 font-mono truncate" title={app.processes[0]?.command}>
            {app.processes[0]?.command}
          </p>
        </div>
        <div className="flex items-center gap-1.5 ml-2 mt-3">
          <button
            onClick={async (e) => {
              e.stopPropagation();
              const result = await window.electronAPI.launchShortcut(app.id);
              if (!result.success) alert(result.error || '打开失败');
            }}
            className="px-3 py-1.5 rounded-md border border-blue-700/50 bg-blue-600/15 text-blue-300 hover:bg-blue-600/25 hover:text-blue-200 flex items-center gap-1.5 text-xs transition-colors"
            title="打开"
          >
            <ExternalLink size={14} />
            打开
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-gray-700 transition-colors"
            title="编辑"
          >
            <Edit size={15} />
          </button>
          <button
            onClick={async (e) => {
              e.stopPropagation();
              if (!confirm(`确定删除「${app.name}」吗？`)) return;
              await window.electronAPI.deleteApp(app.id);
            }}
            className="p-1.5 rounded-md text-gray-500 hover:text-red-300 hover:bg-gray-700 transition-colors"
            title="删除"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    );
  }

  const statusLabel = hasError ? '错误' : isRunning ? '运行中' : isStarting ? '启动中' : '已停止';
  const statusClass = hasError
    ? 'text-red-400'
    : isRunning
    ? 'text-green-400'
    : isStarting
    ? 'text-yellow-400'
    : 'text-gray-500';

  return (
    <div
      onClick={() => setSelectedApp(app.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        void window.electronAPI.showAppContextMenu(app.id, isRunning || isStarting);
      }}
      className={`bg-gray-800 rounded-lg transition-colors cursor-pointer relative overflow-hidden ${
        compact ? 'p-3' : 'p-4'
      } ${selected ? 'border-2 border-blue-500' : 'border border-gray-700 hover:border-gray-600'}`}
    >
      {group && (
        <div className="absolute top-0 left-0 w-1 h-full" style={{ backgroundColor: group.color }} />
      )}

      <div className="ml-2">
        <div className="flex items-center gap-2 mb-1 min-w-0">
          <h3 className="text-sm font-semibold text-white truncate">{app.name}</h3>
          {group && (
            <span
              className="text-xs px-1.5 py-0.5 rounded whitespace-nowrap"
              style={{ backgroundColor: `${group.color}20`, color: group.color }}
            >
              {group.name}
            </span>
          )}
          {entries.some((s) => s.external) && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 whitespace-nowrap">
              外部启动
            </span>
          )}
          {entries.some((s) => s.serviceName) && (
            <span
              className="text-xs px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-200 whitespace-nowrap"
              title={`由 Windows 服务托管：${entries.find((s) => s.serviceName)?.serviceName}（开机自启、崩溃自恢复）`}
            >
              Windows 服务
            </span>
          )}
        </div>

        {app.description && (
          <p className="text-xs text-gray-400 mb-1 truncate" title={app.description}>
            {app.description}
          </p>
        )}

        <div className="flex items-center gap-2 mb-2">
          <Circle className={`${statusClass} fill-current`} size={8} />
          <span className={`text-xs ${statusClass}`}>{statusLabel}</span>
          {isRunning && startedAt && (
            <span className="flex items-center gap-1 text-xs text-gray-400" title="运行时长">
              <Clock size={11} />
              {formatUptime(startedAt)}
            </span>
          )}
          {restartCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-gray-400" title="重启次数">
              <RefreshCw size={11} />
              {restartCount}
            </span>
          )}
        </div>

        <div className={compact ? 'space-y-0.5' : 'space-y-1'}>
          {app.processes.map((proc, index) => {
            const status = entries[index];
            const isExternal = status.external === true;
            return (
              <div key={proc.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-gray-300 truncate flex items-center gap-1.5" title={`${proc.command}`}>
                  <span className="truncate">{proc.name}</span>
                  {proc.port ? <span className="text-gray-500">:{proc.port}</span> : null}
                  {status.state === 'running' && status.cpuPercent !== undefined ? (
                    <span
                      className="text-gray-500 whitespace-nowrap"
                      title="CPU 以单核为 100%；内存为整棵进程树的工作集"
                    >
                      CPU {status.cpuPercent}%
                    </span>
                  ) : null}
                  {status.state === 'running' && status.memoryMB !== undefined ? (
                    <span className="text-gray-500 whitespace-nowrap">{formatMemory(status.memoryMB)}</span>
                  ) : null}
                </span>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {status.ports.map((port) => (
                    <span key={port} className="flex items-center gap-0.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void window.electronAPI.openUrl(`http://localhost:${port}`);
                        }}
                        className="text-blue-400 hover:text-blue-300 hover:underline"
                        title={`打开 http://localhost:${port}`}
                      >
                        :{port}
                      </button>
                      {lanAddress && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            const url = `http://${lanAddress}:${port}`;
                            try {
                              await navigator.clipboard.writeText(url);
                            } catch {
                              /* 剪贴板不可用就算了 */
                            }
                          }}
                          className="text-gray-500 hover:text-gray-300"
                          title={`复制局域网地址 http://${lanAddress}:${port}`}
                        >
                          <Copy size={11} />
                        </button>
                      )}
                    </span>
                  ))}
                  <span className={stateColor[status.state]}>
                    {stateText[status.state]}
                    {isExternal ? '·外部' : ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {hasError && (
          <div className="mt-2 space-y-2">
            {errorEntries.slice(0, 2).map((status) => {
              if (status.preflightIssues && status.preflightIssues.length > 0) {
                return (
                  <div
                    key={status.processId}
                    className="rounded bg-red-950/40 border border-red-900/60 px-2 py-1 space-y-0.5 text-xs"
                  >
                    <div className="text-red-200 font-medium">启动前预检未通过</div>
                    {status.preflightIssues.map((issue, index) => (
                      <div key={index} className="text-red-300">
                        · {issue}
                      </div>
                    ))}
                  </div>
                );
              }
              const parts = [
                status.errorHint,
                status.conflictPort ? `端口 ${status.conflictPort}` : '',
                status.conflictPid ? `占用 PID ${status.conflictPid}` : '',
              ].filter(Boolean);
              return (
                <div key={status.processId} className="flex items-center gap-2 text-xs">
                  <span
                    className="text-red-300 truncate flex-1"
                    title={status.stderrTail || parts.join(' · ')}
                  >
                    {parts.join(' · ') || '启动失败'}
                  </span>
                  {status.conflictPid ? (
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`结束占用端口 ${status.conflictPort} 的进程 PID ${status.conflictPid}？`)) return;
                        const result = await window.electronAPI.killPid(status.conflictPid as number);
                        if (!result.success) alert(result.error || '结束进程失败');
                      }}
                      className="px-1.5 py-0.5 rounded bg-red-900/50 hover:bg-red-900 text-red-200 flex-shrink-0"
                      title="结束占用端口的进程"
                    >
                      释放端口
                    </button>
                  ) : null}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      const text = `${app.name} / ${status.processId}\n${parts.join(' · ')}\n\n${status.stderrTail || ''}`;
                      await navigator.clipboard.writeText(text).catch(() => undefined);
                    }}
                    className="px-1.5 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 flex-shrink-0"
                    title="复制错误信息"
                  >
                    复制
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 ml-2 mt-3">
        {!isActive && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void run(() => window.electronAPI.startApp(app.id));
            }}
            className="px-3 py-1.5 rounded-md border border-green-700/50 bg-green-600/15 text-green-300 hover:bg-green-600/25 hover:text-green-200 flex items-center gap-1.5 text-xs transition-colors"
            title="启动"
          >
            <Play size={14} />
            启动
          </button>
        )}

        {(isRunning || isStarting) && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void run(() => window.electronAPI.stopApp(app.id));
              }}
              className="px-3 py-1.5 rounded-md border border-red-800/50 bg-red-600/15 text-red-300 hover:bg-red-600/25 hover:text-red-200 flex items-center gap-1.5 text-xs transition-colors"
              title="停止"
            >
              <Square size={14} />
              停止
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void run(() => window.electronAPI.restartApp(app.id));
              }}
              className="p-1.5 rounded-md text-gray-400 hover:text-blue-300 hover:bg-gray-700 transition-colors"
              title="重启"
            >
              <RotateCw size={15} />
            </button>
          </>
        )}

        {hasError && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void run(() => window.electronAPI.restartApp(app.id));
            }}
            className="px-3 py-1.5 rounded-md border border-orange-700/50 bg-orange-600/15 text-orange-300 hover:bg-orange-600/25 hover:text-orange-200 flex items-center gap-1.5 text-xs transition-colors"
            title="重新启动"
          >
            <Zap size={14} />
            重试
          </button>
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            void toggleService();
          }}
          className={`p-1.5 rounded-md transition-colors ${
            serviceManaged
              ? 'text-blue-300 hover:text-blue-200 hover:bg-gray-700'
              : 'text-gray-500 hover:text-blue-300 hover:bg-gray-700'
          }`}
          title={
            serviceManaged
              ? `已由 Windows 服务托管：${serviceManaged}（点此取消托管）`
              : '注册为 Windows 服务（开机自启、崩溃自恢复，不用开启动器）'
          }
        >
          <Server size={15} />
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-gray-700 transition-colors"
          title="编辑"
        >
          <Edit size={15} />
        </button>

        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (!confirm(`确定删除「${app.name}」吗？`)) return;
            await window.electronAPI.deleteApp(app.id);
          }}
          className="p-1.5 rounded-md text-gray-500 hover:text-red-300 hover:bg-gray-700 transition-colors"
          title="删除"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
