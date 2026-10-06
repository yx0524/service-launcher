import { useState } from 'react';
import { FolderOpen, Plus, Trash2, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { AppConfig, AppKind, ProcessConfig } from '../types';

interface AppDialogProps {
  appId: string | null;
  onClose: () => void;
}

const inputClass =
  'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

export default function AppDialog({ appId, onClose }: AppDialogProps) {
  const apps = useAppStore((s) => s.apps);
  const groups = useAppStore((s) => s.groups);
  const editing = appId ? apps.find((a) => a.id === appId) : undefined;

  const [name, setName] = useState(editing?.name ?? '');
  const [kind, setKind] = useState<AppKind>(editing?.kind ?? 'service');
  const [groupId, setGroupId] = useState(editing?.groupId ?? groups[0]?.id ?? 'default');
  const [workingDir, setWorkingDir] = useState(editing?.workingDir ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [autoStart, setAutoStart] = useState(editing?.autoStart ?? false);
  const [dailyRestartAt, setDailyRestartAt] = useState(editing?.dailyRestartAt ?? '');
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    editing?.env ? Object.entries(editing.env).map(([key, value]) => ({ key, value })) : []
  );
  const [processes, setProcesses] = useState<ProcessConfig[]>(
    editing?.processes ?? [{ id: crypto.randomUUID(), name: 'Main', command: '' }]
  );
  const [saving, setSaving] = useState(false);

  const patchProcess = (id: string, patch: Partial<ProcessConfig>) => {
    setProcesses((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const handleSave = async () => {
    const cleaned = processes
      .map((p) => ({ ...p, name: p.name.trim() || 'Main', command: p.command.trim() }))
      .filter((p) => p.command);

    if (!name.trim()) return alert('请填写应用名称');
    if (!workingDir.trim()) return alert('请选择工作目录');
    if (cleaned.length === 0) return alert('至少填写一个启动命令');

    const env: Record<string, string> = {};
    for (const { key, value } of envVars) if (key.trim()) env[key.trim()] = value;

    const config: AppConfig = {
      id: editing?.id ?? crypto.randomUUID(),
      name: name.trim(),
      groupId,
      workingDir: workingDir.trim(),
      processes: cleaned,
    };
    if (kind === 'shortcut') config.kind = 'shortcut';
    else {
      config.autoStart = autoStart;
      const time = dailyRestartAt.trim();
      if (time) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
          alert('定时重启时间格式应为 HH:MM，例如 04:30');
          return;
        }
        config.dailyRestartAt = time;
      }
    }
    if (description.trim()) config.description = description.trim();
    if (Object.keys(env).length > 0) config.env = env;

    setSaving(true);
    try {
      await window.electronAPI.saveApp(config);
      onClose();
    } catch (error) {
      alert(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg w-[min(760px,94vw)] max-h-[92vh] flex flex-col border border-gray-700">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">{editing ? '编辑服务' : '添加服务'}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-5 space-y-4">
          <div>
            <label className="block text-sm text-gray-300 mb-1.5">类型</label>
            <div className="flex gap-2">
              {([
                { value: 'service', title: '常驻服务', hint: '后台长期运行，跟踪状态、崩溃自动重启' },
                { value: 'shortcut', title: '快捷方式', hint: '按需工具，点一下打开，不跟踪状态' },
              ] as Array<{ value: AppKind; title: string; hint: string }>).map((item) => (
                <button
                  key={item.value}
                  onClick={() => setKind(item.value)}
                  className={`flex-1 text-left px-3 py-2 rounded border transition-colors ${
                    kind === item.value
                      ? 'border-blue-500 bg-blue-600/20'
                      : 'border-gray-600 bg-gray-700/40 hover:bg-gray-700'
                  }`}
                >
                  <div className={`text-sm ${kind === item.value ? 'text-white' : 'text-gray-300'}`}>{item.title}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{item.hint}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-300 mb-1.5">服务名称 *</label>
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="SMT编程平台-后端服务"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1.5">分组</label>
              <select className={inputClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-1.5">工作目录 *</label>
            <div className="flex gap-2">
              <input
                className={inputClass}
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                placeholder="E:\项目\后端"
              />
              <button
                onClick={async () => {
                  const dir = await window.electronAPI.selectDirectory();
                  if (dir) setWorkingDir(dir);
                }}
                className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
                title="选择目录"
              >
                <FolderOpen size={18} />
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-1.5">备注</label>
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="选填，例如：给 MES 提供接口的 FastAPI 服务"
            />
          </div>

          {kind === 'service' && (
            <div className="flex items-end gap-4">
              <label className="flex items-center gap-2 cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(e) => setAutoStart(e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="text-sm text-gray-300 whitespace-nowrap">启动器打开时自动启动</span>
              </label>
              <div className="flex-1">
                <label className="block text-sm text-gray-300 mb-1.5">每日定时重启</label>
                <input
                  className={inputClass}
                  value={dailyRestartAt}
                  onChange={(e) => setDailyRestartAt(e.target.value)}
                  placeholder="04:30（留空不启用）"
                  title="到点自动重启这个服务（只在自己正在运行时生效）"
                />
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm text-gray-300">启动命令 *</label>
              <button
                onClick={() =>
                  setProcesses((list) => [
                    ...list,
                    { id: crypto.randomUUID(), name: `进程${list.length + 1}`, command: '' },
                  ])
                }
                className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs flex items-center gap-1"
              >
                <Plus size={14} />
                添加进程
              </button>
            </div>

            <div className="space-y-3">
              {processes.map((proc, index) => (
                <div key={proc.id} className="p-3 bg-gray-700/60 rounded space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 w-12 flex-shrink-0">进程 {index + 1}</span>
                    <input
                      className={`${inputClass} flex-1`}
                      value={proc.name}
                      onChange={(e) => patchProcess(proc.id, { name: e.target.value })}
                      placeholder="名称"
                    />
                    {processes.length > 1 && (
                      <button
                        onClick={() => setProcesses((list) => list.filter((p) => p.id !== proc.id))}
                        className="p-1.5 text-red-400 hover:text-red-300 hover:bg-gray-600 rounded"
                        title="删除这个进程"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>

                  <input
                    className={inputClass}
                    value={proc.command}
                    onChange={(e) => patchProcess(proc.id, { command: e.target.value })}
                    placeholder="python -m uvicorn app:app --host 0.0.0.0 --port 8000"
                  />

                  {kind === 'service' && (
                  <>
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      className={inputClass}
                      value={proc.port ?? ''}
                      onChange={(e) => {
                        const value = e.target.value.trim();
                        patchProcess(proc.id, { port: value === '' ? undefined : Number(value) || undefined });
                      }}
                      placeholder="端口（选填）"
                      title="填了就按「端口是否被监听」判断状态，能认出手工启动的同一服务"
                    />
                    <input
                      className={inputClass}
                      value={proc.match ?? ''}
                      onChange={(e) => patchProcess(proc.id, { match: e.target.value || undefined })}
                      placeholder="关键字（选填）"
                      title="没有端口时用命令行关键字识别，例如 bot.js"
                    />
                    <input
                      className={inputClass}
                      value={proc.startTimeoutMs ?? ''}
                      onChange={(e) => {
                        const value = e.target.value.trim();
                        patchProcess(proc.id, {
                          startTimeoutMs: value === '' ? undefined : Number(value) || undefined,
                        });
                      }}
                      placeholder="启动超时 ms"
                      title="超过这个时间还没起来就标红，留空不检查"
                    />
                  </div>

                  <input
                    className={inputClass}
                    value={proc.healthUrl ?? ''}
                    onChange={(e) => patchProcess(proc.id, { healthUrl: e.target.value.trim() || undefined })}
                    placeholder="就绪探测地址（选填）：http://127.0.0.1:8000/ready"
                    title="填了就按 HTTP 返回码判断「好了没」；返回 5xx 或连不上算没就绪"
                  />

                  <div className="grid grid-cols-3 gap-2">
                    <input
                      className={inputClass}
                      value={proc.autoRestartMax ?? 3}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        patchProcess(proc.id, {
                          autoRestartMax: Number.isFinite(value) ? Math.max(0, Math.min(10, value)) : 3,
                        });
                      }}
                      placeholder="自动重启次数"
                      title="崩溃/健康检查失败时自动重试的次数，0 = 关闭"
                    />
                    <input
                      className={inputClass}
                      value={(proc.preflightFiles ?? []).join(',')}
                      onChange={(e) =>
                        patchProcess(proc.id, {
                          preflightFiles: e.target.value.trim()
                            ? e.target.value.split(/[,\s;]+/).filter(Boolean)
                            : undefined,
                        })
                      }
                      placeholder="预检文件：data,config.json"
                      title="启动前必须存在的文件/目录（相对工作目录），逗号分隔"
                    />
                    <input
                      className={inputClass}
                      value={(proc.preflightImports ?? []).join(',')}
                      onChange={(e) =>
                        patchProcess(proc.id, {
                          preflightImports: e.target.value.trim()
                            ? e.target.value.split(/[,\s;]+/).filter(Boolean)
                            : undefined,
                        })
                      }
                      placeholder="预检模块：fastapi,uvicorn"
                      title="启动前用解释器 import 检查这些 Python 模块，缺了就不启动"
                  />
                  </div>
                  </>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm text-gray-300">环境变量</label>
              <button
                onClick={() => setEnvVars((list) => [...list, { key: '', value: '' }])}
                className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs flex items-center gap-1"
              >
                <Plus size={14} />
                添加变量
              </button>
            </div>
            {envVars.length === 0 ? (
              <p className="text-xs text-gray-500">没有额外环境变量</p>
            ) : (
              <div className="space-y-2">
                {envVars.map((env, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      className={inputClass}
                      value={env.key}
                      onChange={(e) =>
                        setEnvVars((list) =>
                          list.map((item, i) => (i === index ? { ...item, key: e.target.value } : item))
                        )
                      }
                      placeholder="变量名"
                    />
                    <input
                      className={inputClass}
                      value={env.value}
                      onChange={(e) =>
                        setEnvVars((list) =>
                          list.map((item, i) => (i === index ? { ...item, value: e.target.value } : item))
                        )
                      }
                      placeholder="变量值"
                    />
                    <button
                      onClick={() => setEnvVars((list) => list.filter((_, i) => i !== index))}
                      className="px-2 text-red-400 hover:text-red-300"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
