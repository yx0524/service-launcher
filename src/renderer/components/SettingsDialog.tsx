import { useEffect, useState } from 'react';
import { ZoomIn, ZoomOut, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { AppSettings } from '../types';

interface SettingsDialogProps {
  onClose: () => void;
  /** 预览缩放（不落盘，保存时才写入设置）。 */
  onZoomPreview: (zoom: number) => void;
}

const inputClass =
  'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

export default function SettingsDialog({ onClose, onZoomPreview }: SettingsDialogProps) {
  const stored = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const [draft, setDraft] = useState<AppSettings>(stored);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.getSettings().then((settings) => {
      if (!cancelled) setDraft(settings);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (values: Partial<AppSettings>) => setDraft((prev) => ({ ...prev, ...values }));

  const previewZoom = (value: number) => {
    const zoom = Math.max(0.5, Math.min(2, Math.round(value * 10) / 10));
    patch({ uiZoom: zoom });
    onZoomPreview(zoom);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await window.electronAPI.saveSettings(draft);
      setSettings(saved);
      onZoomPreview(saved.uiZoom);
      onClose();
    } catch (error) {
      alert(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg w-[min(520px,92vw)] max-h-[88vh] flex flex-col border border-gray-700">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">设置</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-5 space-y-5">
          <div className="flex items-center justify-between gap-3 p-3 bg-gray-900/50 border border-gray-700 rounded">
            <span className="text-sm text-gray-300">界面缩放</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => previewZoom(draft.uiZoom - 0.1)}
                className="p-1.5 hover:bg-gray-700 rounded text-gray-300"
                title="缩小"
              >
                <ZoomOut size={16} />
              </button>
              <span className="text-sm text-gray-100 w-14 text-center tabular-nums">
                {Math.round(draft.uiZoom * 100)}%
              </span>
              <button
                onClick={() => previewZoom(draft.uiZoom + 0.1)}
                className="p-1.5 hover:bg-gray-700 rounded text-gray-300"
                title="放大"
              >
                <ZoomIn size={16} />
              </button>
              <button
                onClick={() => previewZoom(1)}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-white"
              >
                100%
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-1.5">每个服务最多保留日志条数</label>
            <input
              type="number"
              min={100}
              max={20000}
              className={inputClass}
              value={draft.maxLogsPerApp}
              onChange={(e) => patch({ maxLogsPerApp: Number(e.target.value) || 100 })}
            />
            <p className="text-xs text-gray-500 mt-1">越小越省内存，默认 2000 条</p>
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-1.5">批量启动间隔（毫秒）</label>
            <input
              type="number"
              min={0}
              max={60000}
              className={inputClass}
              value={draft.autostartDelayMs}
              onChange={(e) => patch({ autostartDelayMs: Number(e.target.value) || 0 })}
            />
            <p className="text-xs text-gray-500 mt-1">「启动全部」和开机自启时，服务之间的等待时间</p>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4"
              checked={draft.autoScrollLogs}
              onChange={(e) => patch({ autoScrollLogs: e.target.checked })}
            />
            <span className="text-sm text-gray-300">日志自动滚动到最新</span>
          </label>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4"
                checked={draft.logPersistenceEnabled}
                onChange={(e) => patch({ logPersistenceEnabled: e.target.checked })}
              />
              <span className="text-sm text-gray-300">日志同时写入磁盘</span>
            </label>
            <p className="text-xs text-gray-500">
              保存到 用户数据目录\logs\服务ID\日期.log，崩溃后还能翻记录
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">单个文件上限</span>
              <input
                type="number"
                min={1}
                max={200}
                className={`${inputClass} w-24`}
                value={draft.maxLogFileMB}
                onChange={(e) => patch({ maxLogFileMB: Number(e.target.value) || 1 })}
                disabled={!draft.logPersistenceEnabled}
              />
              <span className="text-xs text-gray-400">MB</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">保留天数</span>
              <input
                type="number"
                min={1}
                max={90}
                className={`${inputClass} w-24`}
                value={draft.logRetentionDays ?? 7}
                onChange={(e) => patch({ logRetentionDays: Number(e.target.value) || 1 })}
                disabled={!draft.logPersistenceEnabled}
              />
              <span className="text-xs text-gray-400">天（超期自动清理）</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-700">
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
