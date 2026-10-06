import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Wrench, X } from 'lucide-react';
import type { PathIssue } from '../types';
import { commonDirPrefix } from '../../configRules';

interface PathRepairDialogProps {
  onClose: () => void;
}

/** 路径体检 + 批量替换前缀：换机器/改目录名之后一次全修好。 */
export default function PathRepairDialog({ onClose }: PathRepairDialogProps) {
  const [issues, setIssues] = useState<PathIssue[] | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    const found = await window.electronAPI.checkPaths();
    setIssues(found);
    setFrom(commonDirPrefix(found.map((item) => item.workingDir)));
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const apply = async () => {
    if (!from.trim()) return alert('请填写要替换的旧路径前缀');
    if (!to.trim()) return alert('请填写新路径前缀');
    if (!confirm(`把所有服务里以\n${from}\n开头的路径改成\n${to}\n（改动前会自动备份配置）`)) return;
    setBusy(true);
    try {
      const { changed } = await window.electronAPI.replacePathPrefix(from.trim(), to.trim());
      alert(changed > 0 ? `已更新 ${changed} 个服务` : '没有服务匹配这个前缀');
      await run();
    } catch (error) {
      alert(`替换失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg w-[min(680px,94vw)] max-h-[88vh] flex flex-col border border-gray-700">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-white">路径体检</h2>
            <p className="text-xs text-gray-400 mt-0.5">找出工作目录不存在的服务，支持批量替换路径前缀</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
          <div>
            <div className="text-sm text-gray-300 mb-2">
              检查结果
              {issues !== null && (
                <span className={issues.length > 0 ? 'text-amber-300 ml-2' : 'text-green-400 ml-2'}>
                  {issues.length > 0 ? `${issues.length} 个服务路径失效` : '全部正常'}
                </span>
              )}
            </div>
            {issues === null && <p className="text-xs text-gray-400">正在检查…</p>}
            {issues?.length === 0 && (
              <p className="text-xs text-green-400 flex items-center gap-1.5">
                <CheckCircle2 size={14} /> 所有服务的工作目录都存在
              </p>
            )}
            <div className="space-y-1">
              {issues?.map((item) => (
                <div key={item.appId} className="text-xs bg-gray-900/50 border border-gray-700 rounded px-3 py-2">
                  <span className="text-white">{item.appName}</span>
                  <div className="text-gray-400 mt-0.5 font-mono break-all">{item.workingDir}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">旧前缀</label>
              <input className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="E:\000.曾欢\00000.工艺" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">新前缀</label>
              <input className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} placeholder="E:\00000.工艺" />
            </div>
          </div>
          <p className="text-xs text-gray-500">
            工作目录和启动命令里出现这个前缀的地方都会替换；改动前会自动备份一份配置。
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-700">
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">
            关闭
          </button>
          <button
            onClick={() => void apply()}
            disabled={busy || (issues?.length ?? 0) === 0}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded text-sm flex items-center gap-1.5"
          >
            <Wrench size={14} />
            批量替换
          </button>
        </div>
      </div>
    </div>
  );
}
