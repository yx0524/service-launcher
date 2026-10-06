import fs from 'node:fs';
import type { AppConfig, Group } from './types';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

/** 窗口位置/大小的归一化与边界保护（离屏/异常值一律退回默认）。 */
export function normalizeWindowState(raw: unknown): WindowState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  const width = Number(input.width);
  const height = Number(input.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  const state: WindowState = {
    width: Math.max(600, Math.min(10000, Math.floor(width))),
    height: Math.max(400, Math.min(10000, Math.floor(height))),
  };
  const x = Number(input.x);
  const y = Number(input.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    state.x = Math.floor(x);
    state.y = Math.floor(y);
  }
  if (input.maximized === true) state.maximized = true;
  return state;
}

/** 找出与新服务端口重复的既有服务（跨服务配置校验）。 */
export function findPortConflicts(apps: AppConfig[], candidate: AppConfig): string[] {
  const conflicts: string[] = [];
  const usedPorts = new Map<number, string>();
  for (const item of apps) {
    if (item.id === candidate.id) continue;
    for (const proc of item.processes) {
      if (proc.port) usedPorts.set(proc.port, item.name);
    }
  }
  for (const proc of candidate.processes) {
    if (!proc.port) continue;
    const owner = usedPorts.get(proc.port);
    if (owner) conflicts.push(`端口 ${proc.port} 已被「${owner}」占用`);
  }
  return conflicts;
}

/** 批量替换路径前缀：工作目录 + 各进程命令行里出现的旧前缀。 */
export function replacePrefix(
  apps: AppConfig[],
  from: string,
  to: string
): { apps: AppConfig[]; changed: number } {
  const normalize = (value: string) => value.replace(/[\\/]+$/, '');
  const oldPrefix = normalize(from);
  if (!oldPrefix) return { apps, changed: 0 };
  const newPrefix = normalize(to);
  const pattern = new RegExp(oldPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let changed = 0;

  const next = apps.map((item) => {
    let touched = false;
    let workingDir = item.workingDir;
    if (normalize(workingDir).toLowerCase().startsWith(oldPrefix.toLowerCase())) {
      workingDir = newPrefix + workingDir.slice(oldPrefix.length);
      touched = true;
    }
    const processes = item.processes.map((proc) => {
      if (!proc.command.toLowerCase().includes(oldPrefix.toLowerCase())) return proc;
      touched = true;
      return { ...proc, command: proc.command.replace(pattern, newPrefix) };
    });
    if (!touched) return item;
    changed += 1;
    return { ...item, workingDir, processes };
  });

  return { apps: next, changed };
}

/** 列出工作目录不存在的服务。 */
export function findBrokenPaths(
  apps: AppConfig[]
): Array<{ appId: string; appName: string; workingDir: string }> {
  return apps
    .filter((item) => !fs.existsSync(item.workingDir))
    .map((item) => ({ appId: item.id, appName: item.name, workingDir: item.workingDir }));
}

/** 取一组路径的公共目录前缀，用来猜「旧前缀」。 */
export function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const split = paths.map((p) => p.split(/[\\/]/));
  const first = split[0];
  let end = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < end && i < parts.length && parts[i].toLowerCase() === first[i].toLowerCase()) i += 1;
    end = i;
  }
  return first.slice(0, Math.max(1, end)).join('\\');
}

export type { AppConfig, Group };

/**
 * 按给定 id 顺序重排分组（拖拽排序用）。
 * 不在列表里的分组按原顺序补在后面，避免拖拽时丢分组。
 */
export function applyGroupOrder(groups: Group[], orderedIds: string[]): Group[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const result: Group[] = [];
  for (const id of orderedIds) {
    const group = byId.get(id);
    if (!group) continue;
    result.push({ ...group, order: result.length });
    byId.delete(id);
  }
  for (const group of groups) {
    if (byId.has(group.id)) result.push({ ...group, order: result.length });
  }
  return result;
}
