import { X, Keyboard } from 'lucide-react';

interface KeyboardShortcutsHelpProps {
  onClose: () => void;
}

export default function KeyboardShortcutsHelp({ onClose }: KeyboardShortcutsHelpProps) {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const modKey = isMac ? 'Cmd' : 'Ctrl';

  const shortcuts = [
    { key: `${modKey} + R`, description: '重启选中的应用' },
    { key: `${modKey} + S`, description: '启动/停止选中的应用' },
    { key: `${modKey} + L`, description: '显示/隐藏日志面板' },
    { key: `${modKey} + F`, description: '聚焦到搜索框' },
    { key: `${modKey} + Q`, description: '退出（启动器启动的服务会先停止）' },
    { key: 'Escape', description: '清除搜索或取消选中' },
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg w-full max-w-md">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <Keyboard size={20} className="text-blue-400" />
            <h2 className="text-xl font-semibold text-white">键盘快捷键</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-700 rounded transition-colors text-gray-400 hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-3">
          {shortcuts.map((shortcut, index) => (
            <div
              key={index}
              className="flex items-center justify-between py-2 border-b border-gray-700 last:border-0"
            >
              <span className="text-gray-300">{shortcut.description}</span>
              <kbd className="px-3 py-1 bg-gray-700 border border-gray-600 rounded text-sm font-mono text-white">
                {shortcut.key}
              </kbd>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-gray-700 bg-gray-750">
          <p className="text-xs text-gray-400 text-center">
            提示：某些快捷键需要先选中一个应用才能使用
          </p>
        </div>
      </div>
    </div>
  );
}
