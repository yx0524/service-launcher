import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, TriangleAlert, X } from 'lucide-react';
import type { AppCheckResult } from '../types';

interface HealthCheckDialogProps {
  onClose: () => void;
}

/** 环境体检：只跑启动前检查，不启动任何服务。 */
export default function HealthCheckDialog({ onClose }: HealthCheckDialogProps) {
  const [results, setResults] = useState<AppCheckResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      setResults(await window.electronAPI.checkAll());
    } catch (error) {
      alert(`体检失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const problemCount = (results ?? []).filter((r) => r.issues.length > 0).length;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg w-[min(720px,94vw)] max-h-[88vh] flex flex-col border border-gray-700">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-white">环境体检</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              只做启动前检查（目录、解释器、依赖、端口占用），不启动任何服务
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-2">
          {results === null && <p className="text-center text-gray-400 py-8">正在检查…</p>}

          {results !== null && results.length === 0 && (
            <p className="text-center text-gray-400 py-8">还没有配置任何常驻服务</p>
          )}

          {results?.map((item) => (
            <div
              key={`${item.appId}-${item.processName}`}
              className={`rounded border px-3 py-2 ${
                item.issues.length > 0
                  ? 'border-amber-700/60 bg-amber-950/20'
                  : 'border-gray-700 bg-gray-900/40'
              }`}
            >
              <div className="flex items-center gap-2">
                {item.issues.length > 0 ? (
                  <TriangleAlert size={15} className="text-amber-400 flex-shrink-0" />
                ) : (
                  <CheckCircle2 size={15} className="text-green-500 flex-shrink-0" />
                )}
                <span className="text-sm text-white">{item.appName}</span>
                <span className="text-xs text-gray-500">{item.processName}</span>
              </div>
              {item.issues.map((issue, index) => (
                <div key={index} className="mt-1 ml-6 text-xs text-amber-200">
                  · {issue.message}
                  {issue.fix ? <span className="text-amber-300/70"> · → {issue.fix}</span> : null}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 p-4 border-t border-gray-700">
          <span className="text-xs text-gray-400">
            {results === null
              ? ''
              : problemCount > 0
              ? `${problemCount} 个服务有问题`
              : '全部通过'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void run()}
              disabled={busy}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-60 text-white rounded flex items-center gap-1.5 text-sm"
            >
              <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
              重新检查
            </button>
            <button onClick={onClose} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm">
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
