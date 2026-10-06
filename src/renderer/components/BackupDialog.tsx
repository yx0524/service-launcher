import { useCallback, useEffect, useState } from 'react';
import { History, RotateCcw, X } from 'lucide-react';
import type { BackupEntry } from '../types';

interface BackupDialogProps {
  onClose: () => void;
}

/** 配置备份列表 + 一键恢复（每次导入/路径替换/恢复前都会自动备份）。 */
export default function BackupDialog({ onClose }: BackupDialogProps) {
  const [backups, setBackups] = useState<BackupEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBackups(await window.electronAPI.listBackups());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (entry: BackupEntry) => {
    if (
      !confirm(
        `恢复 ${new Date(entry.savedAt).toLocaleString()} 的配置？\n` +
          `包含 ${entry.apps} 个服务、${entry.groups} 个分组。\n` +
          '当前配置会先自动备份一份。'
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const result = await window.electronAPI.restoreBackup(entry.file);
      if (result.success) {
        alert('已恢复');
        onClose();
      } else {
        alert(result.error || '恢复失败');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg w-[min(560px,94vw)] max-h-[80vh] flex flex-col border border-gray-700">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <History size={18} className="text-blue-400" />
            <h2 className="text-lg font-semibold text-white">恢复配置备份</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-2">
          {backups === null && <p className="text-sm text-gray-400 text-center py-6">正在读取…</p>}
          {backups?.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-6">还没有备份（导入配置、路径替换、恢复操作前会自动生成）</p>
          )}
          {backups?.map((entry) => (
            <div key={entry.file} className="flex items-center justify-between gap-3 bg-gray-900/50 border border-gray-700 rounded px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm text-white">{new Date(entry.savedAt).toLocaleString()}</div>
                <div className="text-xs text-gray-400 truncate">
                  {entry.apps} 个服务 · {entry.groups} 个分组 · {entry.file}
                </div>
              </div>
              <button
                onClick={() => void restore(entry)}
                disabled={busy}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded text-xs flex items-center gap-1 flex-shrink-0"
              >
                <RotateCcw size={13} />
                恢复
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end p-4 border-t border-gray-700">
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
