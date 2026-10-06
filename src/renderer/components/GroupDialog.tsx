import { useState } from 'react';
import { X } from 'lucide-react';
import type { Group } from '../types';

interface GroupDialogProps {
  group: Group | null;
  onClose: () => void;
}

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#94a3b8',
];

export default function GroupDialog({ group, onClose }: GroupDialogProps) {
  const [name, setName] = useState(group?.name ?? '');
  const [color, setColor] = useState(group?.color ?? PRESET_COLORS[10]);

  const handleSave = async () => {
    if (!name.trim()) return alert('请输入分组名称');
    try {
      await window.electronAPI.saveGroup({
        id: group?.id ?? crypto.randomUUID(),
        name: name.trim(),
        color,
        order: group?.order ?? Date.now(),
      });
      onClose();
    } catch (error) {
      alert(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg w-[min(440px,92vw)] border border-gray-700">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">{group ? '编辑分组' : '添加分组'}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm text-gray-300 mb-1.5">分组名称 *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSave();
              }}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：SMT编程平台"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-2">颜色</label>
            <div className="grid grid-cols-9 gap-2">
              {PRESET_COLORS.map((preset) => (
                <button
                  key={preset}
                  onClick={() => setColor(preset)}
                  className={`w-7 h-7 rounded-full transition-transform ${
                    color === preset ? 'ring-2 ring-white scale-110' : ''
                  }`}
                  style={{ backgroundColor: preset }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-700">
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded">
            取消
          </button>
          <button onClick={handleSave} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded">
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
