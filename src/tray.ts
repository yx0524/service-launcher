import { Menu, Tray, nativeImage } from 'electron';
import fs from 'node:fs';
import type { ProcessStatus } from './types';
import { summarizeTray } from './trayState';

/** 图标文件读不到时的兜底：纯代码画一个方块，保证托盘不会空白。 */
function makeIcon(kind: 'normal' | 'alert'): Electron.NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const fill = kind === 'alert' ? [220, 38, 38] : [37, 99, 235];
  const border = [255, 255, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const edge = x < 2 || x >= size - 2 || y < 2 || y >= size - 2;
      const color = edge ? border : fill;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
      buffer[offset + 3] = 255;
    }
  }

  if (kind === 'alert') {
    // 中间一竖 + 一点，做成感叹号，16px 下也认得出
    const draw = (x: number, y: number) => {
      const offset = (y * size + x) * 4;
      buffer[offset] = 255;
      buffer[offset + 1] = 255;
      buffer[offset + 2] = 255;
      buffer[offset + 3] = 255;
    };
    for (let y = 4; y <= 8; y++) {
      draw(7, y);
      draw(8, y);
    }
    draw(7, 11);
    draw(8, 11);
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

/** 读 assets 里的托盘图；读不到就退回代码绘制的方块。 */
function loadTrayIcon(filePath: string | undefined, kind: 'normal' | 'alert'): Electron.NativeImage {
  if (filePath && fs.existsSync(filePath)) {
    const image = nativeImage.createFromPath(filePath);
    if (!image.isEmpty()) return image;
  }
  return makeIcon(kind);
}

export interface TrayController {
  update(statuses: ProcessStatus[]): void;
  /** 托盘气泡提示（只在第一次收进托盘之类的场景用）。 */
  balloon(title: string, content: string): void;
  destroy(): void;
}

export function createTray(options: {
  showWindow: () => void;
  quit: () => void;
  restartFailed: () => void;
  startAll: () => void;
  stopAll: () => void;
  /** assets/tray.png 与 assets/tray-alert.png 的路径。 */
  iconPaths?: { normal: string; alert: string };
}): TrayController {
  const normalIcon = loadTrayIcon(options.iconPaths?.normal, 'normal');
  const alertIcon = loadTrayIcon(options.iconPaths?.alert, 'alert');
  const tray = new Tray(normalIcon);
  tray.setToolTip('进程启动器');

  let lastAlert = false;

  const update = (statuses: ProcessStatus[]) => {
    const summary = summarizeTray(statuses);

    if (summary.hasAlert !== lastAlert) {
      tray.setImage(summary.hasAlert ? alertIcon : normalIcon);
      lastAlert = summary.hasAlert;
    }
    tray.setToolTip(summary.tooltip);

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: '进程启动器', enabled: false },
      { label: summary.statusLine, enabled: false },
      { type: 'separator' },
      { label: '显示窗口', click: options.showWindow },
      ...(summary.runningCount + summary.startingCount > 0
        ? [{ label: '停止全部', click: options.stopAll } as Electron.MenuItemConstructorOptions]
        : []),
      { label: '启动全部', click: options.startAll },
    ];
    if (summary.alertCount > 0) {
      template.push({ label: summary.restartLabel, click: options.restartFailed });
    }
    template.push({ type: 'separator' }, { label: '退出', click: options.quit });

    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  tray.on('click', options.showWindow);
  update([]);

  return {
    update,
    balloon: (title: string, content: string) => {
      try {
        tray.displayBalloon({ title, content });
      } catch {
        /* 部分系统不支持气泡就静默忽略 */
      }
    },
    destroy: () => {
      tray.destroy();
    },
  };
}
