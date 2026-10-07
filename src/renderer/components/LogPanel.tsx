import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, FolderOpen, Layers, Search, Trash2, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { AppLogEntry } from '../types';

const EMPTY_LOGS: AppLogEntry[] = [];
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;

const stripAnsi = (text: string) => text.replace(ANSI_RE, '');

type FilterType = 'all' | 'stdout' | 'stderr' | 'system';
type Scope = 'current' | 'all';

/** 全局视图每个服务最多取尾部这么多条再合并，避免服务一多就卡。 */
const PER_APP_TAIL = 400;
const MERGED_LIMIT = 2000;

export default function LogPanel() {
  const selectedAppId = useAppStore((s) => s.selectedAppId);
  const apps = useAppStore((s) => s.apps);
  const logsByApp = useAppStore((s) => s.logs);
  const autoScrollSetting = useAppStore((s) => s.settings.autoScrollLogs);
  const toggleLogPanel = useAppStore((s) => s.toggleLogPanel);
  const clearLogs = useAppStore((s) => s.clearLogs);
  const prependLogs = useAppStore((s) => s.prependLogs);

  const scrollRef = useRef<HTMLDivElement>(null);
  const previousCountRef = useRef(0);
  const [scope, setScope] = useState<Scope>('current');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [autoScroll, setAutoScroll] = useState(autoScrollSetting);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const [hint, setHint] = useState<string | null>(null);

  const app = apps.find((a) => a.id === selectedAppId);

  const logs = useMemo(() => {
    if (scope === 'all') {
      const merged: AppLogEntry[] = [];
      for (const entries of Object.values(logsByApp)) {
        if (entries.length <= PER_APP_TAIL) merged.push(...entries);
        else merged.push(...entries.slice(-PER_APP_TAIL));
      }
      merged.sort((a, b) => a.timestamp - b.timestamp || (a.seq ?? 0) - (b.seq ?? 0));
      return merged.length > MERGED_LIMIT ? merged.slice(-MERGED_LIMIT) : merged;
    }
    return selectedAppId ? logsByApp[selectedAppId] ?? EMPTY_LOGS : EMPTY_LOGS;
  }, [scope, logsByApp, selectedAppId]);

  const nameOf = (appId: string) => apps.find((a) => a.id === appId)?.name ?? appId;

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  };

  useEffect(() => setAutoScroll(autoScrollSetting), [autoScrollSetting]);

  // 内存里没有日志时，把落盘的历史读回来（启动器重启过、或服务不是启动器拉起的）
  useEffect(() => {
    if (!selectedAppId) return;
    if ((logsByApp[selectedAppId] ?? EMPTY_LOGS).length > 0) return;
    let cancelled = false;
    void window.electronAPI.readAppLogs(selectedAppId).then((entries) => {
      if (!cancelled) prependLogs(selectedAppId, entries);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedAppId, logsByApp, prependLogs]);

  useEffect(() => {
    previousCountRef.current = 0;
    setUnread(0);
    setAtBottom(true);
  }, [selectedAppId, scope]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      setAtBottom(bottom);
      if (bottom) setUnread(0);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [selectedAppId, scope]);

  useEffect(() => {
    const previous = previousCountRef.current;
    const next = logs.length;
    previousCountRef.current = next;
    if (next <= previous) return;
    if (autoScroll && atBottom) scrollToBottom('auto');
    else setUnread((count) => count + (next - previous));
  }, [logs.length, autoScroll, atBottom]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter((log) => {
      if (filter !== 'all' && log.type !== filter) return false;
      if (!needle) return true;
      return (
        stripAnsi(log.content).toLowerCase().includes(needle) ||
        log.processName.toLowerCase().includes(needle) ||
        nameOf(log.appId).toLowerCase().includes(needle)
      );
    });
  }, [logs, query, filter, apps]);

  const formatLine = (log: AppLogEntry) =>
    `[${new Date(log.timestamp).toLocaleTimeString()}] [${log.type}] [${nameOf(log.appId)} / ${log.processName}] ${stripAnsi(log.content).trimEnd()}`;

  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setHint(message);
      setTimeout(() => setHint(null), 1500);
    } catch {
      alert('复制失败');
    }
  };

  const title = scope === 'all' ? '所有服务' : app?.name ?? '日志';
  const canShow = scope === 'all' || Boolean(app);

  return (
    <div className="w-96 bg-gray-800 border-l border-gray-700 flex flex-col flex-shrink-0 min-h-0">
      <div className="h-14 border-b border-gray-700 flex items-center justify-between px-4 flex-shrink-0">
        <h2 className="text-sm font-semibold text-white">日志</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setScope((s) => (s === 'all' ? 'current' : 'all'))}
            className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
              scope === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            title={scope === 'all' ? '只看当前服务' : '合并显示所有服务的日志'}
          >
            <Layers size={13} />
            全部
          </button>
          <button onClick={toggleLogPanel} className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white">
            <X size={16} />
          </button>
        </div>
      </div>

      {!canShow && (
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">选择一个服务查看日志</div>
      )}

      {canShow && (
        <>
          <div className="p-3 border-b border-gray-700 space-y-2 flex-shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white truncate">{title}</h3>
                <p className="text-xs text-gray-400">
                  {visible.length} / {logs.length} 条
                  {hint ? <span className="text-green-400 ml-2">{hint}</span> : null}
                </p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {unread > 0 && (
                  <button
                    onClick={() => {
                      scrollToBottom('smooth');
                      setUnread(0);
                    }}
                    className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-xs text-white"
                  >
                    最新 {unread}
                  </button>
                )}
                <button
                  onClick={() => void copy(visible.map(formatLine).join('\n'), '已复制筛选日志')}
                  className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
                  title="复制筛选结果"
                >
                  <Copy size={15} />
                </button>
                <button
                  onClick={async () => {
                    const file = await window.electronAPI.saveTextFile(
                      visible.map(formatLine).join('\n'),
                      `${title}-日志-${new Date().toISOString().slice(0, 10)}.txt`
                    );
                    if (file) alert(`已导出到：\n${file}`);
                  }}
                  className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
                  title="导出日志"
                >
                  <Download size={15} />
                </button>
                <button
                  onClick={async () => {
                    const result = await window.electronAPI.openLogsDir();
                    if (!result.success) alert(result.error || '打开日志目录失败');
                  }}
                  className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
                  title="打开日志目录（落盘的日志在这里）"
                >
                  <FolderOpen size={15} />
                </button>
                {scope === 'current' && app && (
                  <button
                    onClick={() => {
                      if (confirm('清空该服务的日志显示？')) clearLogs(app.id);
                    }}
                    className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
                    title="清空"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>

            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索日志..."
                className="w-full pl-8 pr-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-xs placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {(['all', 'stdout', 'stderr', 'system'] as FilterType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => setFilter(type)}
                    className={`px-2 py-0.5 text-xs rounded ${
                      filter === type ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {type === 'all' ? '全部' : type === 'stdout' ? '输出' : type === 'stderr' ? '错误' : '系统'}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setAutoScroll((v) => !v)}
                className={`px-2 py-0.5 text-xs rounded ${
                  autoScroll ? 'bg-gray-700 text-gray-200' : 'bg-gray-900 text-gray-400'
                }`}
              >
                自动滚动 {autoScroll ? '开' : '关'}
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
            {visible.length === 0 && (
              <div className="text-center text-gray-500 text-sm py-8 space-y-1">
                <p>{logs.length === 0 ? '暂无日志' : '没有匹配的日志'}</p>
                {logs.length === 0 && (
                  <p className="text-xs text-gray-600 leading-relaxed">
                    启动器只能抓到「自己拉起来的」进程的输出。
                    <br />
                    外部启动的服务、以及 Windows 服务托管的进程抓不到 —— 那两种请用右键菜单里的
                    「打开服务日志」，或点上面的文件夹图标看落盘日志目录。
                  </p>
                )}
              </div>
            )}
            {visible.map((log) => (
              <div key={log.seq ?? `${log.timestamp}-${log.appId}-${log.processId}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-gray-500 text-xs">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  {scope === 'all' && <span className="text-xs text-blue-300">{nameOf(log.appId)}</span>}
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      log.type === 'stdout'
                        ? 'bg-blue-900 text-blue-300'
                        : log.type === 'stderr'
                        ? 'bg-red-900 text-red-300'
                        : 'bg-gray-700 text-gray-300'
                    }`}
                  >
                    {log.processName}
                  </span>
                </div>
                <pre
                  className={`mt-0.5 whitespace-pre-wrap break-words font-mono text-xs ${
                    log.type === 'stderr'
                      ? 'text-red-400'
                      : log.type === 'system'
                      ? 'text-yellow-400'
                      : 'text-gray-300'
                  }`}
                >
                  {stripAnsi(log.content)}
                </pre>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
