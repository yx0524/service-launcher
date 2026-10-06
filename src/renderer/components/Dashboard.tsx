import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Activity, CircleAlert, CircleStop, HardDrive, Layers } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { formatCpu, formatMemory, formatUptime } from '../format';
import type { AppConfig, MetricsSeries, ProcessStatus } from '../types';

interface Row {
  app: AppConfig;
  processId: string;
  processName: string;
  status: ProcessStatus;
  ports: number[];
}

type SortKey = 'auto' | 'name' | 'state' | 'cpu' | 'mem' | 'uptime';

const RANGES = [
  { hours: 1, label: '1 小时' },
  { hours: 6, label: '6 小时' },
  { hours: 24, label: '1 天' },
  { hours: 168, label: '7 天' },
];

const stateText: Record<ProcessStatus['state'], string> = {
  running: '运行中',
  starting: '启动中',
  stopped: '已停止',
  error: '错误',
};

const stateClass: Record<ProcessStatus['state'], string> = {
  running: 'text-green-400',
  starting: 'text-yellow-400',
  stopped: 'text-gray-500',
  error: 'text-red-400',
};

/** 迷你趋势图：手写 SVG，不引图表库。 */
function Sparkline({ values, color = '#60a5fa' }: { values: number[]; color?: string }) {
  const width = 76;
  const height = 20;
  if (values.length < 2) return <span className="text-xs text-gray-600">采样中…</span>;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const points = values
    .map((value, index) => {
      const x = 1 + (index / (values.length - 1)) * (width - 2);
      const y = height - 2 - ((value - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round" />
    </svg>
  );
}

function StatCard({
  icon,
  label,
  value,
  tone = 'text-gray-100',
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-2xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

/** 总览页：汇总 + 每个服务的状态/端口/运行时长/CPU/内存 + 长期内存曲线。 */
export default function Dashboard() {
  const apps = useAppStore((s) => s.apps);
  const groups = useAppStore((s) => s.groups);
  const statuses = useAppStore((s) => s.statuses);
  const logPanelOpen = useAppStore((s) => s.logPanelOpen);
  const toggleLogPanel = useAppStore((s) => s.toggleLogPanel);
  const setSelectedApp = useAppStore((s) => s.setSelectedApp);

  const [rangeHours, setRangeHours] = useState(1);
  const [metrics, setMetrics] = useState<MetricsSeries | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('auto');
  const [sortAsc, setSortAsc] = useState(false);
  const [, forceTick] = useState(0);

  const loadMetrics = useCallback(async () => {
    try {
      setMetrics(await window.electronAPI.getMetrics(rangeHours));
    } catch {
      /* 读不到就暂时不画曲线 */
    }
  }, [rangeHours]);

  useEffect(() => {
    void loadMetrics();
    const timer = setInterval(() => void loadMetrics(), 60000);
    return () => clearInterval(timer);
  }, [loadMetrics]);

  // 运行时长定时刷新（5 秒足够，「43秒」这种精度不需要每秒重渲染整张表）
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    for (const app of apps) {
      if (app.kind === 'shortcut') continue;
      for (const proc of app.processes) {
        const status: ProcessStatus =
          statuses[app.id]?.[proc.id] ?? {
            appId: app.id,
            processId: proc.id,
            state: 'stopped',
            ports: [],
            restartCount: 0,
          };
        list.push({
          app,
          processId: proc.id,
          processName: proc.name,
          status,
          ports: status.ports.length > 0 ? status.ports : proc.port ? [proc.port] : [],
        });
      }
    }

    const stateOrder = (state: ProcessStatus['state']) =>
      state === 'error' ? 0 : state === 'running' ? 1 : state === 'starting' ? 2 : 3;
    const growth = (key: string) => {
      const series = metrics?.series[key];
      if (!series || series.length < 2) return 0;
      return series[series.length - 1][1] - series[0][1];
    };
    const dir = sortAsc ? 1 : -1;

    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.app.name.localeCompare(b.app.name, 'zh-CN') * dir;
        case 'state':
          return (stateOrder(a.status.state) - stateOrder(b.status.state)) * dir;
        case 'cpu':
          return ((a.status.cpuPercent ?? -1) - (b.status.cpuPercent ?? -1)) * dir;
        case 'mem':
          return ((a.status.memoryMB ?? -1) - (b.status.memoryMB ?? -1)) * dir;
        case 'uptime':
          return ((a.status.startedAt ?? 0) - (b.status.startedAt ?? 0)) * dir;
        default: {
          const diff = stateOrder(a.status.state) - stateOrder(b.status.state);
          if (diff !== 0) return diff;
          // 内存涨得多的排前面，方便揪慢涨
          const ga = growth(`${a.app.id}::${a.processId}`);
          const gb = growth(`${b.app.id}::${b.processId}`);
          if (Math.abs(ga - gb) > 5) return gb - ga;
          return (b.status.memoryMB ?? 0) - (a.status.memoryMB ?? 0);
        }
      }
    });
  }, [apps, statuses, metrics, sortKey, sortAsc]);

  const running = rows.filter((r) => r.status.state === 'running');
  const failed = rows.filter((r) => r.status.state === 'error');
  const starting = rows.filter((r) => r.status.state === 'starting');
  const totalMem = running.reduce((sum, r) => sum + (r.status.memoryMB ?? 0), 0);
  const totalCpu = running.reduce((sum, r) => sum + (r.status.cpuPercent ?? 0), 0);

  const header = (label: string, key: SortKey, align: 'left' | 'right' = 'left') => (
    <th className={`font-medium px-3 py-2 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        onClick={() => {
          if (sortKey === key) setSortAsc((asc) => !asc);
          else {
            setSortKey(key);
            setSortAsc(false);
          }
        }}
        className={`inline-flex items-center gap-1 hover:text-gray-200 ${
          sortKey === key ? 'text-gray-200' : 'text-gray-400'
        }`}
        title="点击排序"
      >
        {label}
        {sortKey === key ? <span className="text-[10px]">{sortAsc ? '▲' : '▼'}</span> : null}
      </button>
    </th>
  );

  return (
    <div className="flex-1 overflow-auto p-3 lg:p-4 space-y-3">
      <div className="flex gap-3">
        <StatCard icon={<Activity size={14} />} label="运行中" value={`${running.length}`} tone="text-green-400" />
        <StatCard
          icon={<CircleAlert size={14} />}
          label="异常"
          value={`${failed.length}`}
          tone={failed.length > 0 ? 'text-red-400' : 'text-gray-100'}
        />
        <StatCard
          icon={<CircleStop size={14} />}
          label="已停止"
          value={`${rows.length - running.length - failed.length - starting.length}`}
          tone="text-gray-400"
        />
        <StatCard
          icon={<HardDrive size={14} />}
          label="总内存占用"
          value={formatMemory(totalMem)}
          tone="text-blue-300"
        />
        <StatCard icon={<Layers size={14} />} label="总 CPU" value={formatCpu(totalCpu)} tone="text-blue-300" />
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
          <span className="text-gray-300">服务状态</span>
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500 mr-1">内存曲线窗口</span>
            {RANGES.map((range) => (
              <button
                key={range.hours}
                onClick={() => setRangeHours(range.hours)}
                className={`px-2 py-0.5 rounded text-xs ${
                  rangeHours === range.hours
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-400 border-b border-gray-700">
              {header('服务', 'name')}
              {header('状态', 'state')}
              <th className="text-left font-medium px-3 py-2 text-gray-400 whitespace-nowrap">端口</th>
              {header('运行时长', 'uptime')}
              {header('CPU', 'cpu', 'right')}
              {header('内存', 'mem', 'right')}
              <th className="text-left font-medium px-3 py-2 text-gray-400 whitespace-nowrap">内存曲线</th>
              <th className="text-right font-medium px-3 py-2 text-gray-400 w-24 whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const group = groups.find((g) => g.id === row.app.groupId);
              const memory = row.status.memoryMB;
              const series = metrics?.series[`${row.app.id}::${row.processId}`] ?? [];
              const values = series.map((point) => point[1]);
              const up = row.status.state === 'running';
              return (
                <tr
                  key={`${row.app.id}-${row.processId}`}
                  onClick={() => {
                    setSelectedApp(row.app.id);
                    if (!logPanelOpen) toggleLogPanel();
                  }}
                  className="border-b border-gray-800 last:border-0 hover:bg-gray-700/30 cursor-pointer"
                  title="点击查看这个服务的日志"
                >
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: group?.color ?? '#64748b' }}
                      />
                      <span className="text-gray-100 truncate">{row.app.name}</span>
                      {group && <span className="text-xs text-gray-500 truncate">{group.name}</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={stateClass[row.status.state]}>{stateText[row.status.state]}</span>
                    {row.status.external ? <span className="text-xs text-gray-500 ml-1">·外部</span> : null}
                    {row.status.serviceName ? (
                      <span className="text-xs text-blue-300 ml-1" title={`Windows 服务：${row.status.serviceName}`}>
                        ·服务托管
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-gray-300 whitespace-nowrap">
                    {row.ports.length > 0 ? (
                      <span className="flex items-center gap-1.5">
                        {row.ports.map((port) => (
                          <button
                            key={port}
                            onClick={(e) => {
                              e.stopPropagation();
                              void window.electronAPI.openUrl(`http://localhost:${port}`);
                            }}
                            className="text-blue-400 hover:text-blue-300 hover:underline"
                            title={`打开 http://localhost:${port}`}
                          >
                            :{port}
                          </button>
                        ))}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-300 whitespace-nowrap">
                    {up ? formatUptime(row.status.startedAt) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-300 whitespace-nowrap">
                    {formatCpu(row.status.cpuPercent)}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-300 whitespace-nowrap">{formatMemory(memory)}</td>
                  <td className="px-3 py-2">
                    {up ? (
                      <Sparkline values={values} color={(memory ?? 0) > 800 ? '#f87171' : '#60a5fa'} />
                    ) : (
                      <span className="text-xs text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {up || row.status.state === 'starting' ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void window.electronAPI.stopApp(row.app.id);
                        }}
                        className="px-2 py-1 rounded border border-red-800/50 bg-red-600/15 text-red-300 hover:bg-red-600/25 text-xs"
                        title="停止"
                      >
                        停止
                      </button>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void window.electronAPI.startApp(row.app.id);
                        }}
                        className="px-2 py-1 rounded border border-green-700/50 bg-green-600/15 text-green-300 hover:bg-green-600/25 text-xs"
                        title="启动"
                      >
                        启动
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>

        {rows.length === 0 && <p className="text-center text-gray-500 py-10 text-sm">还没有配置任何常驻服务</p>}
      </div>

      <p className="text-xs text-gray-500">
        内存曲线由启动器每分钟采样一次并落盘（保留 7 天），关掉启动器再打开也能看到历史；点某一行可以查看它的日志。
      </p>
    </div>
  );
}
