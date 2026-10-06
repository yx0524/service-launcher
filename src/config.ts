import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AppConfig,
  AppSettings,
  BackupEntry,
  ConfigBundle,
  Group,
  ProcessConfig,
} from './types';
import {
  applyGroupOrder,
  normalizeWindowState,
  type WindowState,
} from './configRules';

export { findPortConflicts, replacePrefix, findBrokenPaths, commonDirPrefix, normalizeWindowState } from './configRules';
export type { WindowState } from './configRules';

export const CONFIG_VERSION = '2.0';
export const DEFAULT_GROUP_ID = 'default';

export const DEFAULT_SETTINGS: AppSettings = {
  maxLogsPerApp: 2000,
  autoScrollLogs: true,
  autostartDelayMs: 1200,
  uiZoom: 1,
  logPersistenceEnabled: true,
  maxLogFileMB: 10,
  logRetentionDays: 7,
};

interface StoreShape {
  apps: AppConfig[];
  groups: Group[];
  settings: AppSettings;
  window?: WindowState;
  /** 一次性的界面状态标记（不动声色地记着，不放进设置面板）。 */
  flags?: { trayHintShown?: boolean };
}

const DEFAULT_GROUP: Group = {
  id: DEFAULT_GROUP_ID,
  name: '默认分组',
  color: '#3b82f6',
  order: 0,
};

function storeFile(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function backupDir(): string {
  return path.join(app.getPath('userData'), 'backups');
}

/* ------------------------------------------------------------------ */
/* 校验 / 归一化                                                        */
/* ------------------------------------------------------------------ */

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalPort(value: unknown): number | undefined {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return port;
}

export function normalizeProcessConfig(raw: unknown): ProcessConfig | null {
  const input = (raw || {}) as Record<string, unknown>;
  const command = asString(input.command).trim();
  if (!command) return null;

  const process: ProcessConfig = {
    id: asString(input.id) || randomUUID(),
    name: asString(input.name).trim() || 'Main',
    command,
  };

  if (input.shell === false) process.shell = false;

  const port = asOptionalPort(input.port);
  if (port) process.port = port;

  const match = asString(input.match).trim();
  if (match) process.match = match;

  // Windows 服务托管：填了服务名就以服务状态为准
  const service = asString(input.service).trim();
  if (service) process.service = service;

  const timeout = Number(input.startTimeoutMs);
  if (Number.isFinite(timeout) && timeout > 0) process.startTimeoutMs = Math.floor(timeout);

  const healthUrl = asString(input.healthUrl).trim();
  if (/^https?:\/\//i.test(healthUrl)) process.healthUrl = healthUrl;

  // 默认 3 次；显式写 0 才是关闭
  const autoRestartMax = input.autoRestartMax === undefined ? 3 : Number(input.autoRestartMax);
  process.autoRestartMax = Number.isFinite(autoRestartMax)
    ? Math.max(0, Math.min(10, Math.floor(autoRestartMax)))
    : 3;

  const toList = (value: unknown): string[] | undefined => {
    const list = (Array.isArray(value) ? value : [value])
      .map((item) => asString(item).trim())
      .filter(Boolean);
    return list.length > 0 ? list : undefined;
  };
  const preflightFiles = toList(input.preflightFiles);
  if (preflightFiles) process.preflightFiles = preflightFiles;
  const preflightImports = toList(input.preflightImports);
  if (preflightImports) process.preflightImports = preflightImports;

  return process;
}

export function normalizeAppConfig(raw: unknown, fallbackGroupId = DEFAULT_GROUP_ID): AppConfig | null {
  const input = (raw || {}) as Record<string, unknown>;
  const name = asString(input.name).trim();
  const workingDir = asString(input.workingDir).trim();
  if (!name || !workingDir) return null;

  const list = Array.isArray(input.processes) ? input.processes : [];
  const processes = list.map(normalizeProcessConfig).filter((p): p is ProcessConfig => p !== null);
  if (processes.length === 0) return null;

  const appConfig: AppConfig = {
    id: asString(input.id) || randomUUID(),
    name,
    groupId: asString(input.groupId) || fallbackGroupId,
    workingDir,
    processes,
  };

  if (input.kind === 'shortcut') appConfig.kind = 'shortcut';
  const dailyRestartAt = asString(input.dailyRestartAt).trim();
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyRestartAt)) appConfig.dailyRestartAt = dailyRestartAt;
  const description = asString(input.description).trim();
  if (description) appConfig.description = description;
  if (input.autoStart === true) appConfig.autoStart = true;

  if (input.env && typeof input.env === 'object') {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env as Record<string, unknown>)) {
      if (key.trim() && typeof value === 'string') env[key.trim()] = value;
    }
    if (Object.keys(env).length > 0) appConfig.env = env;
  }

  return appConfig;
}

export function normalizeGroup(raw: unknown, index = 0): Group | null {
  const input = (raw || {}) as Record<string, unknown>;
  const name = asString(input.name).trim();
  if (!name) return null;
  const order = Number(input.order);
  return {
    id: asString(input.id) || randomUUID(),
    name,
    color: /^#[0-9a-f]{6}$/i.test(asString(input.color)) ? asString(input.color) : '#3b82f6',
    order: Number.isFinite(order) ? order : index,
  };
}

export function normalizeSettings(raw: unknown): AppSettings {
  const input = (raw || {}) as Record<string, unknown>;
  const clampNumber = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  return {
    maxLogsPerApp: Math.floor(clampNumber(input.maxLogsPerApp, 100, 20000, DEFAULT_SETTINGS.maxLogsPerApp)),
    autoScrollLogs: input.autoScrollLogs !== false,
    autostartDelayMs: Math.floor(clampNumber(input.autostartDelayMs, 0, 60000, DEFAULT_SETTINGS.autostartDelayMs)),
    uiZoom: Math.round(clampNumber(input.uiZoom, 0.5, 2, DEFAULT_SETTINGS.uiZoom) * 10) / 10,
    logPersistenceEnabled: input.logPersistenceEnabled === true,
    maxLogFileMB: Math.floor(clampNumber(input.maxLogFileMB, 1, 200, DEFAULT_SETTINGS.maxLogFileMB)),
    logRetentionDays: Math.floor(clampNumber(input.logRetentionDays, 1, 90, DEFAULT_SETTINGS.logRetentionDays)),
  };
}

/** 清掉指向不存在分组的应用（删分组时用）。 */
function repairGroupIds(apps: AppConfig[], groups: Group[]): AppConfig[] {
  const ids = new Set(groups.map((g) => g.id));
  const fallback = groups[0]?.id || DEFAULT_GROUP_ID;
  let changed = false;
  const fixed = apps.map((item) => {
    if (ids.has(item.groupId)) return item;
    changed = true;
    return { ...item, groupId: fallback };
  });
  return changed ? fixed : apps;
}

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

let cache: StoreShape | null = null;
/** 读取失败标记：读不到就绝不允许写回，避免用空配置覆盖用户的真实配置。 */
let readFailed = false;
/** 本进程最后一次写盘时文件的修改时间，用来发现「外部改过配置」。 */
let lastWrittenMtime = 0;

function readFromDisk(): StoreShape {
  const file = storeFile();
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    // 杀软/索引服务偶发占用会让读取瞬时失败，退避重试几次再判定
    let text: string | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3 && text === null; attempt++) {
      try {
        text = fs.readFileSync(file, 'utf-8');
      } catch (error) {
        lastError = error;
        // 同步小睡一会儿再重试（Node 主线程允许 Atomics.wait）
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        } catch {
          /* 环境不支持就立刻重试 */
        }
      }
    }

    if (text === null) {
      // 读不到：保留上一份缓存，并禁止写回（防止空配置覆盖真实配置）
      readFailed = true;
      console.error('配置文件读取失败，已阻止写入以免覆盖:', lastError);
      return cache ?? emptyStore();
    }

    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      readFailed = true;
      try {
        const broken = `${file}.broken-${Date.now()}`;
        fs.copyFileSync(file, broken);
        console.error('配置文件解析失败，已备份到', broken, error);
      } catch {
        /* ignore */
      }
      return cache ?? emptyStore();
    }
  }

  readFailed = false;
  return buildStore(raw);
}

function emptyStore(): StoreShape {
  return {
    apps: [],
    groups: [{ ...DEFAULT_GROUP }],
    settings: { ...DEFAULT_SETTINGS },
  };
}

function buildStore(raw: Record<string, unknown>): StoreShape {
  let groups = (Array.isArray(raw.groups) ? raw.groups : [])
    .map((g, i) => normalizeGroup(g, i))
    .filter((g): g is Group => g !== null);
  if (groups.length === 0) groups = [{ ...DEFAULT_GROUP }];

  const apps = (Array.isArray(raw.apps) ? raw.apps : [])
    .map((a) => normalizeAppConfig(a, groups[0].id))
    .filter((a): a is AppConfig => a !== null);

  return {
    apps: repairGroupIds(apps, groups),
    groups,
    settings: normalizeSettings(raw.settings),
    window: normalizeWindowState(raw.window),
    flags: normalizeFlags(raw.flags),
  };
}

function normalizeFlags(raw: unknown): StoreShape['flags'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  const flags: { trayHintShown?: boolean } = {};
  if (input.trayHintShown === true) flags.trayHintShown = true;
  return Object.keys(flags).length > 0 ? flags : undefined;
}

export function loadStore(): StoreShape {
  if (!cache) cache = readFromDisk();
  return cache;
}

/** 配置读取是否出过错（出错期间禁止写盘）。 */
export function isConfigReadable(): boolean {
  return !readFailed;
}

function writeToDisk(shape: StoreShape): void {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf-8');
  fs.renameSync(tmp, file); // 原子替换，避免写一半掉电把配置写坏
  try {
    lastWrittenMtime = fs.statSync(file).mtimeMs;
  } catch {
    lastWrittenMtime = 0;
  }
}

export function saveStore(patch: Partial<StoreShape>): StoreShape {
  if (readFailed) {
    throw new Error('配置文件读取失败，已阻止写入以免覆盖你的服务配置；请重启启动器后重试');
  }

  // 写之前先看文件有没有被外部改过（手工编辑、脚本改、恢复备份…），
  // 有的话先重新读盘，否则会把外面的修改覆盖掉。
  const file = storeFile();
  if (cache && fs.existsSync(file)) {
    try {
      if (fs.statSync(file).mtimeMs !== lastWrittenMtime) {
        cache = null;
        loadStore();
      }
    } catch {
      /* 读不到时间就按原逻辑走 */
    }
  }

  const current = loadStore();
  const next: StoreShape = {
    apps: patch.apps ? repairGroupIds(patch.apps, patch.groups || current.groups) : current.apps,
    groups: patch.groups || current.groups,
    settings: patch.settings || current.settings,
    window: patch.window !== undefined ? normalizeWindowState(patch.window) : current.window,
    flags: patch.flags !== undefined ? patch.flags : current.flags,
  };
  cache = next;
  writeToDisk(next);
  ensureDailyBackup();
  return next;
}

/** 每天第一次成功写入时留一份自动备份，万一被误改还能找回。 */
function ensureDailyBackup(): void {
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(dir, `auto-${day}.json`);
    if (fs.existsSync(target)) return;
    const current = loadStore();
    if (current.apps.length === 0) return;
    fs.writeFileSync(target, JSON.stringify({ apps: current.apps, groups: current.groups }, null, 2), 'utf-8');
  } catch {
    /* 备份失败不影响主流程 */
  }
}

/** 列出可恢复的配置备份。 */
export function listBackups(): BackupEntry[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  const entries: BackupEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      const parsed = parseBundle(JSON.parse(fs.readFileSync(full, 'utf-8')));
      entries.push({
        file: name,
        savedAt: stat.mtimeMs,
        apps: parsed?.apps.length ?? 0,
        groups: parsed?.groups.length ?? 0,
      });
    } catch {
      /* 坏文件跳过 */
    }
  }
  return entries.sort((a, b) => b.savedAt - a.savedAt);
}

export function restoreBackup(fileName: string): { apps: AppConfig[]; groups: Group[] } | null {
  const full = path.join(backupDir(), path.basename(fileName)); // basename 防目录穿越
  if (!fs.existsSync(full)) return null;
  try {
    return parseBundle(JSON.parse(fs.readFileSync(full, 'utf-8')));
  } catch {
    return null;
  }
}

/** 清理超期的落盘日志，返回删除的文件数。 */
export function pruneLogs(retentionDays: number): number {
  const root = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(root)) return 0;
  const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 3600 * 1000;
  let removed = 0;
  for (const appDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!appDir.isDirectory()) continue;
    const full = path.join(root, appDir.name);
    for (const file of fs.readdirSync(full)) {
      const target = path.join(full, file);
      try {
        if (fs.statSync(target).mtimeMs < cutoff) {
          fs.rmSync(target);
          removed += 1;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

/** 把当前配置另存一份到 backups/，导入前调用。 */
export function backupCurrentConfig(reason: string): string | null {
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `${reason}-${stamp}.json`);
    fs.copyFileSync(storeFile(), target);
    return target;
  } catch {
    return null;
  }
}

export function toBundle(store: StoreShape): ConfigBundle {
  return { apps: store.apps, groups: store.groups, version: CONFIG_VERSION };
}

/** 解析导入文件；返回 null 表示格式不合法。 */
export function parseBundle(raw: unknown): { apps: AppConfig[]; groups: Group[] } | null {
  const input = (raw || {}) as Record<string, unknown>;
  if (!Array.isArray(input.apps) || !Array.isArray(input.groups)) return null;

  let groups = input.groups
    .map((g, i) => normalizeGroup(g, i))
    .filter((g): g is Group => g !== null);
  if (groups.length === 0) groups = [{ ...DEFAULT_GROUP }];

  const apps = input.apps
    .map((a) => normalizeAppConfig(a, groups[0].id))
    .filter((a): a is AppConfig => a !== null);
  if (apps.length === 0 && input.apps.length > 0) return null;

  return { apps, groups };
}

export function findApp(appId: string): AppConfig | undefined {
  return loadStore().apps.find((a) => a.id === appId);
}

export function upsertApp(config: AppConfig): AppConfig {
  const store = loadStore();
  const apps = [...store.apps];
  const index = apps.findIndex((a) => a.id === config.id);
  if (index >= 0) apps[index] = config;
  else apps.push(config);
  saveStore({ apps });
  return config;
}

export function removeApp(appId: string): void {
  const store = loadStore();
  saveStore({ apps: store.apps.filter((a) => a.id !== appId) });
}

export function upsertGroup(group: Group): void {
  const store = loadStore();
  const groups = [...store.groups];
  const index = groups.findIndex((g) => g.id === group.id);
  if (index >= 0) groups[index] = group;
  else groups.push(group);
  saveStore({ groups });
}

/** 按给定 id 顺序重排分组（拖拽排序用），同时刷新 order 字段。 */
export function reorderGroups(groupIds: string[]): number {
  const store = loadStore();
  const ordered = applyGroupOrder(store.groups, groupIds);
  saveStore({ groups: ordered });
  return ordered.length;
}

/** 删除分组并把组内应用迁移到其他分组（不会让应用凭空消失）。 */
export function removeGroup(groupId: string): { moved: number } {
  const store = loadStore();
  const groups = store.groups.filter((g) => g.id !== groupId);
  if (groups.length === 0) groups.push({ ...DEFAULT_GROUP, id: DEFAULT_GROUP_ID, name: '默认分组' });

  const fallback = groups[0].id;
  let moved = 0;
  const apps = store.apps.map((item) => {
    if (item.groupId !== groupId) return item;
    moved += 1;
    return { ...item, groupId: fallback };
  });

  saveStore({ apps, groups });
  return { moved };
}
