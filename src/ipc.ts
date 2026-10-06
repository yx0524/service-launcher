import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AppConfig, AppSettings, SimpleResult } from './types';
import {
  backupCurrentConfig,
  findBrokenPaths,
  findPortConflicts,
  findApp,
  listBackups,
  loadStore,
  normalizeAppConfig,
  normalizeGroup,
  normalizeSettings,
  parseBundle,
  removeApp,
  removeGroup,
  reorderGroups,
  replacePrefix,
  restoreBackup,
  saveStore,
  toBundle,
  upsertApp,
  upsertGroup,
} from './config';
import type { ProcessManager } from './processManager';
import { killTree, runFile } from './probe';
import { readMetrics } from './metrics';
import { installService, serviceLogDir, uninstallService } from './serviceInstaller';
import { assetsDir } from './paths';

type GetWindow = () => BrowserWindow | null;

function fail(error: unknown): SimpleResult {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerIpc(getWindow: GetWindow, manager: ProcessManager): void {
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  const sync = () => {
    manager.setApps(loadStore().apps);
    send('config-updated');
  };

  /* ---------------- 配置 ---------------- */

  ipcMain.handle('get-config', () => {
    const store = loadStore();
    manager.setApps(store.apps);
    return toBundle(store);
  });

  ipcMain.handle('get-statuses', () => manager.getSnapshot());

  /** 长期资源曲线：hours 小时窗口，最多 120 个点。 */
  ipcMain.handle('get-metrics', (_e, hours: number) => {
    const span = [1, 6, 24, 168].includes(Number(hours)) ? Number(hours) : 1;
    return readMetrics(span, span <= 6 ? 120 : 96);
  });

  ipcMain.handle('get-settings', (): AppSettings => loadStore().settings);

  ipcMain.handle('save-settings', (_e, raw: unknown): AppSettings => {
    const settings = normalizeSettings(raw);
    saveStore({ settings });
    send('settings-updated');
    return settings;
  });

  ipcMain.handle('save-app', (_e, raw: unknown) => {
    const normalized = normalizeAppConfig(raw);
    if (!normalized) throw new Error('应用配置不完整（名称、工作目录、至少一个命令）');

    // 跨服务端口校验：两个服务配同一个端口，起第二个必然 EADDRINUSE
    const conflicts = findPortConflicts(loadStore().apps, normalized);
    if (conflicts.length > 0) throw new Error(conflicts.join('；'));

    upsertApp(normalized);
    sync();
  });

  /* ---------------- 快捷方式 ---------------- */

  ipcMain.handle('launch-shortcut', async (_e, appId: string): Promise<SimpleResult> => {
    const appConfig = findApp(appId);
    if (!appConfig) return { success: false, error: '应用不存在' };
    const proc = appConfig.processes[0];
    if (!proc) return { success: false, error: '没有配置启动命令' };
    if (!fs.existsSync(appConfig.workingDir)) {
      return { success: false, error: `工作目录不存在：${appConfig.workingDir}` };
    }
    try {
      // 按需工具：拉起来就不管了，窗口该显示就显示
      const child = spawn(proc.command, [], {
        cwd: path.normalize(appConfig.workingDir),
        env: { ...process.env, ...appConfig.env },
        shell: proc.shell !== false,
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
      });
      child.unref();
      return { success: true };
    } catch (error) {
      return fail(error);
    }
  });

  /* ---------------- 环境体检 / 路径体检 ---------------- */

  ipcMain.handle('check-all', () => manager.checkAll());

  ipcMain.handle('check-paths', () => findBrokenPaths(loadStore().apps));

  ipcMain.handle('replace-path-prefix', async (_e, from: string, to: string) => {
    const store = loadStore();
    const { apps, changed } = replacePrefix(store.apps, from, to);
    if (changed > 0) {
      backupCurrentConfig('before-path-replace');
      saveStore({ apps });
      sync();
    }
    return { changed };
  });

  /* ---------------- 配置备份 / 恢复 ---------------- */

  ipcMain.handle('list-backups', () => listBackups());

  ipcMain.handle('restore-backup', async (_e, fileName: string): Promise<SimpleResult> => {
    const parsed = restoreBackup(fileName);
    if (!parsed) return { success: false, error: '备份文件已损坏或不存在' };
    backupCurrentConfig('before-restore');
    await manager.stopAll();
    saveStore({ apps: parsed.apps, groups: parsed.groups });
    sync();
    return { success: true };
  });

  ipcMain.handle('delete-app', async (_e, appId: string) => {
    await manager.stopApp(appId);
    removeApp(appId);
    sync();
  });

  ipcMain.handle('save-group', (_e, raw: unknown) => {
    const group = normalizeGroup(raw);
    if (!group) throw new Error('分组名称不能为空');
    upsertGroup(group);
    sync();
  });

  ipcMain.handle('delete-group', (_e, groupId: string) => {
    const { moved } = removeGroup(groupId);
    sync();
    return { moved };
  });

  ipcMain.handle('reorder-groups', (_e, groupIds: string[]) => {
    if (!Array.isArray(groupIds)) return;
    reorderGroups(groupIds.filter((id): id is string => typeof id === 'string'));
    sync();
  });

  /* ---------------- Windows 服务托管 ---------------- */

  ipcMain.handle('install-service', async (_e, appId: string): Promise<SimpleResult & { serviceId?: string }> => {
    const appConfig = findApp(appId);
    const proc = appConfig?.processes[0];
    if (!appConfig || !proc) return { success: false, error: '应用不存在或没配命令' };

    // 先把启动器拉起的实例停掉：否则服务的实例会被单实例锁挡住、反复重启
    try {
      await manager.stopApp(appId);
    } catch {
      /* 没在跑也无所谓 */
    }

    const result = await installService(appConfig, proc, assetsDir());
    if (result.success && result.serviceId) {
      const latest = findApp(appId);
      if (latest) {
        const processes = latest.processes.map((item, index) =>
          index === 0 ? { ...item, service: result.serviceId, match: undefined } : item
        );
        upsertApp({ ...latest, processes });
        sync();
      }
    }
    return { success: result.success, error: result.error, serviceId: result.serviceId };
  });

  ipcMain.handle('uninstall-service', async (_e, appId: string): Promise<SimpleResult> => {
    const appConfig = findApp(appId);
    const serviceId = appConfig?.processes[0]?.service;
    if (!appConfig || !serviceId) return { success: false, error: '这个服务没有托管记录' };

    const result = await uninstallService(serviceId);
    if (result.success) {
      const latest = findApp(appId);
      if (latest) {
        const processes = latest.processes.map((item, index) => {
          if (index !== 0) return item;
          const next = { ...item };
          delete next.service;
          return next;
        });
        upsertApp({ ...latest, processes });
        sync();
      }
    }
    return { success: result.success, error: result.error };
  });

  ipcMain.handle('open-service-logs', async (_e, appId: string): Promise<SimpleResult> => {
    const serviceId = findApp(appId)?.processes[0]?.service;
    if (!serviceId) return { success: false, error: '这个服务没有托管记录' };
    try {
      const dir = serviceLogDir(serviceId);
      fs.mkdirSync(dir, { recursive: true });
      const message = await shell.openPath(dir);
      return message ? { success: false, error: message } : { success: true };
    } catch (error) {
      return fail(error);
    }
  });

  /* ---------------- 运行控制 ---------------- */

  ipcMain.handle('start-app', async (_e, appId: string): Promise<SimpleResult> => {
    try {
      await manager.startApp(appId);
      return { success: true };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('stop-app', async (_e, appId: string): Promise<SimpleResult> => {
    try {
      await manager.stopApp(appId);
      return { success: true };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('restart-app', async (_e, appId: string): Promise<SimpleResult> => {
    try {
      await manager.restartApp(appId);
      return { success: true };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('stop-all', async (): Promise<SimpleResult> => {
    try {
      await manager.stopAll();
      return { success: true };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('restart-failed', async (): Promise<SimpleResult> => {
    try {
      const count = await manager.restartFailed();
      return count > 0 ? { success: true } : { success: false, error: '当前没有异常状态的服务' };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('kill-pid', async (_e, pid: number): Promise<SimpleResult> => {
    if (!Number.isInteger(pid) || pid <= 0) return { success: false, error: 'PID 无效' };
    try {
      await killTree(pid);
      return { success: true };
    } catch (error) {
      return fail(error);
    }
  });

  /* ---------------- 系统 / 文件 ---------------- */

  ipcMain.handle('select-directory', async () => {
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  /** 选一个启动脚本，用来自动拼「启动命令」（bat/cmd/ps1/vbs/exe/py/js）。 */
  ipcMain.handle('select-script-file', async (_e, defaultPath?: string) => {
    const win = getWindow();
    const options = {
      defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openFile'] as const,
      filters: [
        {
          name: '启动脚本',
          extensions: ['bat', 'cmd', 'ps1', 'vbs', 'exe', 'py', 'js', 'mjs', 'cjs'],
        },
        { name: '所有文件', extensions: ['*'] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, { ...options, properties: ['openFile'] })
      : await dialog.showOpenDialog({ ...options, properties: ['openFile'] });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  /** 打开日志落盘目录（没有就建一个，避免打开失败）。 */
  ipcMain.handle('open-logs-dir', async (): Promise<SimpleResult> => {
    try {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const message = await shell.openPath(dir);
      return message ? { success: false, error: message } : { success: true };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('open-path', async (_e, target: string): Promise<SimpleResult> => {
    if (!target) return { success: false, error: '路径为空' };
    if (!fs.existsSync(target)) return { success: false, error: `路径不存在：${target}` };
    const message = await shell.openPath(target);
    return message ? { success: false, error: message } : { success: true };
  });

  ipcMain.handle('open-url', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });

  ipcMain.handle('save-text-file', async (_e, content: string, defaultName: string) => {
    const win = getWindow();
    const options: Electron.SaveDialogOptions = {
      title: '导出',
      defaultPath: defaultName,
      filters: [
        { name: '文本文件', extensions: ['txt', 'log'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return result.filePath;
  });

  /* ---------------- 导入 / 导出 ---------------- */

  ipcMain.handle(
    'export-config',
    async (_e, options?: { groupId?: string | null; appIds?: string[] }) => {
      const store = loadStore();
      const groupId = options?.groupId || null;
      const appIds = options?.appIds;

      const apps =
        Array.isArray(appIds) && appIds.length > 0
          ? store.apps.filter((a) => appIds.includes(a.id))
          : groupId
          ? store.apps.filter((a) => a.groupId === groupId)
          : store.apps;
      const groups = groupId ? store.groups.filter((g) => g.id === groupId) : store.groups;

      const win = getWindow();
      const result = win
        ? await dialog.showSaveDialog(win, {
            title: '导出配置',
            defaultPath: `launcher-config-${new Date().toISOString().slice(0, 10)}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
          })
        : await dialog.showSaveDialog({
            title: '导出配置',
            defaultPath: `launcher-config-${new Date().toISOString().slice(0, 10)}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
          });
      if (result.canceled || !result.filePath) return null;

      fs.writeFileSync(
        result.filePath,
        JSON.stringify({ apps, groups, version: toBundle(store).version }, null, 2),
        'utf-8'
      );
      return result.filePath;
    }
  );

  ipcMain.handle('import-config', async () => {
    const win = getWindow();
    const options: Electron.OpenDialogOptions = {
      title: '导入配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: '未选择文件' };
    }

    try {
      const parsed = parseBundle(JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8')));
      if (!parsed) return { success: false, error: '配置文件格式不正确' };

      // 覆盖前先备份，误导入还能找回
      const backup = backupCurrentConfig('before-import');
      if (backup) console.log('导入前已备份配置:', backup);
      let apps = parsed.apps;
      const groups = parsed.groups;
      apps = apps.map((a) =>
        groups.some((g) => g.id === a.groupId) ? a : { ...a, groupId: groups[0].id }
      );

      await manager.stopAll();
      saveStore({ apps, groups });
      sync();

      return {
        success: true,
        imported: { apps: apps.length, groups: groups.length },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '导入失败' };
    }
  });

  /* ---------------- 开机自启 / 右键菜单 ---------------- */

  ipcMain.handle('get-auto-launch', () => app.getLoginItemSettings().openAtLogin);

  /** 局域网地址：同事要访问时用得上，优先常见的私网网段。 */
  ipcMain.handle('get-lan-address', () => {
    const candidates: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list ?? []) {
        if (item.family !== 'IPv4' || item.internal) continue;
        candidates.push(item.address);
      }
    }
    const preferred =
      candidates.find((ip) => ip.startsWith('192.168.')) ??
      candidates.find((ip) => ip.startsWith('10.')) ??
      candidates.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ??
      candidates[0];
    return preferred ?? null;
  });

  /* ---------------- 诊断包 ---------------- */

  ipcMain.handle('export-diagnostics', async (_e, logsText: string) => {
    const win = getWindow();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const options: Electron.SaveDialogOptions = {
      title: '导出诊断包',
      defaultPath: `启动器诊断-${stamp}.zip`,
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    };
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return null;

    const staging = path.join(app.getPath('temp'), `launcher-diag-${Date.now()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      const store = loadStore();
      fs.writeFileSync(
        path.join(staging, 'config.json'),
        JSON.stringify({ apps: store.apps, groups: store.groups, settings: store.settings }, null, 2),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(staging, 'status.json'),
        JSON.stringify(manager.getSnapshot(), null, 2),
        'utf-8'
      );
      fs.writeFileSync(path.join(staging, 'logs.txt'), logsText || '（没有日志）', 'utf-8');

      const ports = ['netstat', '-ano', '-p', 'TCP'];
      fs.writeFileSync(
        path.join(staging, 'meta.txt'),
        [
          `时间：${new Date().toLocaleString()}`,
          `系统：${os.type()} ${os.release()} (${os.arch()})`,
          `Electron：${process.versions.electron}  Node：${process.versions.node}`,
          `用户数据目录：${app.getPath('userData')}`,
          '',
          '端口占用（netstat）：',
          (await runFile(ports[0], ports.slice(1))).output,
        ].join('\n'),
        'utf-8'
      );

      fs.mkdirSync(path.dirname(picked.filePath), { recursive: true });
      fs.rmSync(picked.filePath, { force: true });
      const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const script = `Compress-Archive -Path ${quote(path.join(staging, '*'))} -DestinationPath ${quote(picked.filePath)} -Force`;
      const result = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], undefined, 60000);
      if (!result.ok || !fs.existsSync(picked.filePath)) {
        return null;
      }
      return picked.filePath;
    } finally {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  ipcMain.handle('set-auto-launch', (_e, enabled: boolean): SimpleResult => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false });
    return { success: true };
  });

  ipcMain.handle('show-app-context-menu', async (_e, appId: string, isRunning: boolean) => {
    const appConfig: AppConfig | undefined = findApp(appId);
    const win = getWindow();
    if (!appConfig || !win) return;

    const act = (action: string) => send('context-menu-action', { action, appId });

    Menu.buildFromTemplate([
      { label: isRunning ? '停止' : '启动', click: () => act(isRunning ? 'stop' : 'start') },
      { label: '重启', enabled: isRunning, click: () => act('restart') },
      { type: 'separator' },
      { label: '编辑', click: () => act('edit') },
      {
        label: appConfig.processes[0]?.service ? '取消服务托管' : '注册为 Windows 服务（开机自启）',
        click: () => act(appConfig.processes[0]?.service ? 'uninstallService' : 'installService'),
      },
      {
        label: '打开服务日志',
        enabled: Boolean(appConfig.processes[0]?.service),
        click: () => act('openServiceLogs'),
      },
      { type: 'separator' },
      { label: '复制一份', click: () => act('duplicate') },
      { label: '删除', click: () => act('delete') },
      { type: 'separator' },
      {
        label: '打开工作目录',
        click: () => {
          void shell.openPath(appConfig.workingDir);
        },
      },
      { label: '查看日志', enabled: isRunning, click: () => act('viewLogs') },
    ]).popup({ window: win });
  });
}
