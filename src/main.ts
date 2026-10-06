import { BrowserWindow, Notification, app, dialog, ipcMain, screen } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { ProcessManager } from './processManager';
import { registerIpc } from './ipc';
import { createTray, type TrayController } from './tray';
import { isConfigReadable, loadStore, pruneLogs, saveStore, upsertApp, type WindowState } from './config';
import { pruneMetrics } from './metrics';
import { assetsDir, existingAsset } from './paths';
import { controlServiceSmart, installService, uninstallService } from './serviceInstaller';
import type { ProcessStatus } from './types';

if (started) {
  app.quit();
} else if (!app.requestSingleInstanceLock()) {
  // 已经有启动器在跑了：直接退出，避免两个实例抢同一批服务。
  // 已存在的那一个会在 second-instance 里把窗口拉到前台，用户不会"点了没反应"。
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disk-cache-dir', path.join(app.getPath('userData'), 'Cache'));

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let tray: TrayController | null = null;
let quitting = false;
let autoStartDone = false;
let trayUpdateTimer: NodeJS.Timeout | null = null;

/**
 * 命令行入口（调试/脚本用，和界面走同一套逻辑）：
 *   进程启动器.exe --service-install <appId>
 *   进程启动器.exe --service-uninstall <appId>
 *   进程启动器.exe --service-control <appId> <start|stop>
 */
function runServiceCli(): boolean {
  const installIndex = process.argv.indexOf('--service-install');
  const uninstallIndex = process.argv.indexOf('--service-uninstall');
  const controlIndex = process.argv.indexOf('--service-control');
  const isInstall = installIndex >= 0;
  const isControl = controlIndex >= 0;
  const appId = isInstall
    ? process.argv[installIndex + 1]
    : uninstallIndex >= 0
      ? process.argv[uninstallIndex + 1]
      : isControl
        ? process.argv[controlIndex + 1]
        : undefined;
  if (!appId) return false;

  void (async () => {
    const appConfig = loadStore().apps.find((item) => item.id === appId);
    if (!appConfig) {
      console.log(JSON.stringify({ success: false, error: `找不到应用 ${appId}` }));
      app.exit(2);
      return;
    }

    // 启停服务：只动服务状态，不改配置
    if (isControl) {
      const action = process.argv[controlIndex + 2] === 'stop' ? 'stop' : 'start';
      const serviceId = appConfig.processes[0]?.service ?? '';
      const outcome = await controlServiceSmart(serviceId, action);
      console.log(JSON.stringify({ success: outcome.ok, output: outcome.output, serviceId }));
      app.exit(outcome.ok ? 0 : 1);
      return;
    }

    const result = isInstall
      ? await installService(appConfig, appConfig.processes[0], assetsDir())
      : await uninstallService(appConfig.processes[0]?.service ?? '');

    // 和界面里的按钮保持一致：成功之后把 service 字段写回/清掉
    if (result.success) {
      const latest = loadStore().apps.find((item) => item.id === appId);
      if (latest) {
        const processes = latest.processes.map((item, index) => {
          if (index !== 0) return item;
          if (isInstall) return { ...item, service: result.serviceId, match: undefined };
          const next = { ...item };
          delete next.service;
          return next;
        });
        upsertApp({ ...latest, processes });
      }
    }
    console.log(JSON.stringify(result));
    app.exit(result.success ? 0 : 1);
  })();
  return true;
}

/** 窗口位置/大小记忆：读出来的位置如果不在任何屏幕上，就退回居中。 */
function resolveWindowState(): WindowState {
  const saved = loadStore().window;
  const workArea = screen.getPrimaryDisplay().workArea;
  const state: WindowState = {
    width: Math.min(saved?.width ?? 1180, workArea.width),
    height: Math.min(saved?.height ?? 640, workArea.height),
    maximized: saved?.maximized === true,
  };

  if (typeof saved?.x === 'number' && typeof saved?.y === 'number') {
    const savedX = saved.x;
    const savedY = saved.y;
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return (
        savedX + 120 > area.x &&
        savedX < area.x + area.width &&
        savedY + 60 > area.y &&
        savedY < area.y + area.height
      );
    });
    if (visible) {
      state.x = savedX;
      state.y = savedY;
    }
  }
  return state;
}

const lastState = new Map<string, ProcessStatus['state']>();

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

const manager = new ProcessManager(
  (status) => {
    broadcast('status-changed', status);
    scheduleTrayUpdate();

    const key = `${status.appId}::${status.processId}`;
    const previous = lastState.get(key);
    lastState.set(key, status.state);

    // 只在「刚变成错误」时提醒一次，避免刷屏
    if (status.state === 'error' && previous !== 'error') {
      const appConfig = loadStore().apps.find((a) => a.id === status.appId);
      const proc = appConfig?.processes.find((p) => p.id === status.processId);
      try {
        new Notification({
          title: '进程异常',
          body: `${appConfig?.name || status.appId} / ${proc?.name || status.processId}：${status.errorHint || '启动失败'}`,
        }).show();
      } catch {
        /* 系统通知不可用就忽略 */
      }
    }
  },
  (log) => broadcast('log', log)
);

/** 状态事件很密，托盘 250ms 合并刷新一次就够。 */
function scheduleTrayUpdate(): void {
  if (trayUpdateTimer) return;
  trayUpdateTimer = setTimeout(() => {
    trayUpdateTimer = null;
    tray?.update(manager.getSnapshot());
  }, 250);
}

function createWindow(): BrowserWindow {
  const windowIcon = existingAsset('icon.ico');
  const windowState = resolveWindowState();
  const win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(windowState.x !== undefined && windowState.y !== undefined
      ? { x: windowState.x, y: windowState.y }
      : {}),
    minWidth: 820,
    minHeight: 480,
    title: '进程启动器',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#111827',
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  win.once('ready-to-show', () => win.show());
  if (windowState.maximized) win.maximize();

  // 窗口隐藏时不做资源采样（省掉后台的 PowerShell 查询），重新显示再恢复
  win.on('show', () => manager.setResourceSampling(true));
  win.on('hide', () => manager.setResourceSampling(false));

  // 位置/大小变化时落盘（拖动结束、缩放结束各存一次）
  let saveTimer: NodeJS.Timeout | null = null;
  const rememberBounds = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
      const maximized = mainWindow.isMaximized();
      const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      try {
        saveStore({
          window: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            maximized,
          },
        });
      } catch {
        /* 存不下来不影响使用 */
      }
    }, 600);
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('maximize', rememberBounds);
  win.on('unmaximize', rememberBounds);

  // 渲染进程崩溃后自动重载；重载后由渲染端重新拉取状态，不会丢状态
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('渲染进程退出:', details.reason);
    if (!quitting) win.webContents.reload();
  });

  win.webContents.on('did-finish-load', () => {
    broadcast('config-updated', null);
    void runAutoStart();
  });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    showTrayHintOnce();
  });

  return win;
}

/** 第一次点 × 时说明一下「这是收进托盘，不是退出」。 */
function showTrayHintOnce(): void {
  try {
    const store = loadStore();
    if (store.flags?.trayHintShown) return;
    saveStore({ flags: { ...store.flags, trayHintShown: true } });
    tray?.balloon('进程启动器', '已收进托盘，双击托盘图标可重新打开；要退出请用托盘菜单里的「退出」。');
  } catch {
    /* 提示失败不影响使用 */
  }
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 开机/启动时的自动启动：等界面加载完再逐个拉起，避免状态事件丢失。 */
async function runAutoStart(): Promise<void> {
  if (autoStartDone) return;
  autoStartDone = true;

  const { apps, settings } = loadStore();
  const targets = apps.filter((a) => a.autoStart);
  if (targets.length === 0) return;

  for (const appConfig of targets) {
    try {
      await manager.startApp(appConfig.id);
    } catch (error) {
      console.error(`自动启动 ${appConfig.name} 失败:`, error);
    }
    if (settings.autostartDelayMs > 0) {
      await new Promise((r) => setTimeout(r, settings.autostartDelayMs));
    }
  }
}

/** 托盘「启动全部」：跳过快捷方式与已在跑的，按设置里的间隔顺序启动。 */
async function startAllApps(): Promise<void> {
  const { apps, settings } = loadStore();
  for (const appConfig of apps) {
    if (appConfig.kind === 'shortcut') continue;
    if (manager.isAppActive(appConfig.id)) continue;
    try {
      await manager.startApp(appConfig.id);
    } catch (error) {
      console.error(`启动 ${appConfig.name} 失败:`, error);
    }
    if (settings.autostartDelayMs > 0) {
      await new Promise((r) => setTimeout(r, settings.autostartDelayMs));
    }
  }
  scheduleTrayUpdate();
}

async function quitApplication(): Promise<void> {
  if (quitting) return;
  quitting = true;
  manager.beginShutdown();
  manager.stopLoop();
  tray?.destroy();
  tray = null;

  // 等托管进程真正结束，避免退出后留下一堆孤儿进程
  await Promise.race([
    // 只停本启动器拉起的服务；手工启动的被检测到的服务保持运行
    manager.stopAll(false),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);

  app.exit(0);
}

app.whenReady().then(() => {
  // 命令行模式：跑完就退，不开窗口、不进托盘
  if (runServiceCli()) return;

  mainWindow = createWindow();
  tray = createTray({
    showWindow,
    quit: () => void quitApplication(),
    startAll: () => void startAllApps(),
    stopAll: () => {
      void manager.stopAll().then(() => scheduleTrayUpdate());
    },
    iconPaths: {
      normal: existingAsset('tray.png') ?? '',
      alert: existingAsset('tray-alert.png') ?? '',
    },
    restartFailed: () => {
      void manager.restartFailed().then((count) => {
        if (count <= 0) return;
        try {
          new Notification({
            title: '进程启动器',
            body: `已重新拉起 ${count} 个异常服务`,
          }).show();
        } catch {
          /* 通知不可用就忽略 */
        }
        scheduleTrayUpdate();
      });
    },
  });
  registerIpc(() => mainWindow, manager);

  ipcMain.on('renderer-ready', () => {
    void runAutoStart();
  });

  ipcMain.on('quit-app', () => app.quit());

  manager.setApps(loadStore().apps);
  manager.start();

  // 配置读不出来时明确告诉用户，并且在修好前拒绝写盘（避免空配置覆盖真实配置）
  if (!isConfigReadable()) {
    void dialog.showMessageBox({
      type: 'warning',
      title: '配置读取失败',
      message: '没能读到服务配置，已停止任何写入以免覆盖原有配置。',
      detail:
        `请检查文件是否被占用或损坏：\n${app.getPath('userData')}\\config.json\n\n` +
        '常见原因：杀毒软件正在扫描、文件被其他程序打开。关掉启动器重新打开通常即可。',
      buttons: ['知道了'],
    });
  }

  // 清理超期的落盘日志
  const removed = pruneLogs(loadStore().settings.logRetentionDays);
  if (removed > 0) console.log(`已清理 ${removed} 个过期日志文件`);
  pruneMetrics(loadStore().settings.logRetentionDays);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    else showWindow();
  });
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void quitApplication();
});

app.on('window-all-closed', () => {
  // 关窗口只是收进托盘，真正退出走托盘菜单或 Cmd/Ctrl+Q
});
