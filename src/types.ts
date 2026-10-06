/** 主进程 / 预加载 / 渲染进程共用的类型定义。 */

export type RunState = 'stopped' | 'starting' | 'running' | 'error';

/** service = 常驻服务（有状态、可托管）；shortcut = 按需工具（点一下打开，不管状态）。 */
export type AppKind = 'service' | 'shortcut';

export interface ProcessConfig {
  id: string;
  name: string;
  /** 完整命令行，例如 `npm run dev` 或 `python -m uvicorn app:app --port 8000`。 */
  command: string;
  /** 是否用 cmd/sh 执行，默认 true（Windows 下能直接跑 npm、uv、&& 串联）。 */
  shell?: boolean;
  /** 监听端口：填了就用「端口是否被监听」判断运行状态（能认出手工启动的进程）。 */
  port?: number;
  /** 没端口时用：命令行关键字（词首匹配，避免 bot.js 误配 photobot.js）。 */
  match?: string;
  /**
   * 由 Windows 服务托管时填服务名（如 WeComContactsBot）。
   * 填了就以服务状态为准，启动/停止也走服务，不再直接拉进程。
   */
  service?: string;
  /**
   * 就绪探测地址：HTTP 返回 <500 视为就绪。
   * 例：FastAPI 用 http://127.0.0.1:8000/ready，前端用 http://127.0.0.1:5173/
   */
  healthUrl?: string;
  /** 启动后多久仍未 running 视为失败（毫秒），留空不启用。 */
  startTimeoutMs?: number;
  /** 崩溃自动重启的最大次数，0 = 关闭。默认 3（只在非正常退出/健康检查失败时触发）。 */
  autoRestartMax?: number;
  /** 启动前预检：工作目录下必须存在的文件/目录（相对路径）。 */
  preflightFiles?: string[];
  /** 启动前预检：必须能 import 的 Python 模块名。 */
  preflightImports?: string[];
}

export interface AppConfig {
  id: string;
  name: string;
  groupId: string;
  /** 默认 service。shortcut 类型不参与状态检测/自动重启，只负责「打开」。 */
  kind?: AppKind;
  description?: string;
  workingDir: string;
  env?: Record<string, string>;
  processes: ProcessConfig[];
  autoStart?: boolean;
  /** 每日定时重启时间，格式 HH:MM；留空不启用。 */
  dailyRestartAt?: string;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  order: number;
}

export interface ProcessStatus {
  appId: string;
  processId: string;
  state: RunState;
  pid?: number;
  /** 该进程不是由本启动器拉起的（手工/其他方式启动，被检测到）。 */
  external?: boolean;
  startedAt?: number;
  ports: number[];
  restartCount: number;
  /** 启动前预检发现的问题（有值时进程不会被启动）。 */
  preflightIssues?: string[];
  /** 崩溃自动重启已尝试次数。 */
  autoRestartAttempts?: number;
  /** 该服务进程树的 CPU 占用（%，相对单核）与内存占用（MB）。 */
  cpuPercent?: number;
  memoryMB?: number;
  /** 这一项由哪个 Windows 服务托管（有值时界面会标出来）。 */
  serviceName?: string;
  exitCode?: number | null;
  signal?: string | null;
  errorHint?: string;
  stderrTail?: string;
  conflictPort?: number;
  conflictPid?: number;
  conflictProcessName?: string;
}

export interface LogEntry {
  timestamp: number;
  type: 'stdout' | 'stderr' | 'system';
  content: string;
}

export interface AppLogEntry extends LogEntry {
  /** 渲染用的稳定序号（避免列表裁剪后用下标做 key 导致内容错位）。 */
  seq?: number;
  appId: string;
  processId: string;
  processName: string;
}

export interface AppSettings {
  /** 每个应用在内存里保留的日志条数上限。 */
  maxLogsPerApp: number;
  autoScrollLogs: boolean;
  /** 批量启动/开机自启时，应用之间的间隔（毫秒）。 */
  autostartDelayMs: number;
  uiZoom: number;
  /** 日志同时写入磁盘（按应用/日期分文件）。 */
  logPersistenceEnabled: boolean;
  maxLogFileMB: number;
  /** 落盘日志保留天数，超期自动清理。 */
  logRetentionDays: number;
}

export interface ConfigBundle {
  apps: AppConfig[];
  groups: Group[];
  version: string;
}

export interface StatusPayload {
  statuses: ProcessStatus[];
}

export interface ImportResult {
  success: boolean;
  error?: string;
  imported?: { apps: number; groups: number };
}

export interface SimpleResult {
  success: boolean;
  error?: string;
}

/** 启动前预检 / 环境体检的结果。 */
export interface CheckIssue {
  message: string;
  fix?: string;
}

export interface AppCheckResult {
  appId: string;
  appName: string;
  processName: string;
  issues: CheckIssue[];
}

export interface PathIssue {
  appId: string;
  appName: string;
  workingDir: string;
}

export interface BackupEntry {
  file: string;
  savedAt: number;
  apps: number;
  groups: number;
}

export interface MetricsSeries {
  from: number;
  to: number;
  series: Record<string, Array<[number, number, number]>>;
}

export interface ElectronAPI {
  getConfig: () => Promise<ConfigBundle>;
  getStatuses: () => Promise<ProcessStatus[]>;
  /** 长期资源曲线（hours 小时窗口）。 */
  getMetrics: (hours: number) => Promise<MetricsSeries>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;

  saveApp: (config: AppConfig) => Promise<void>;
  deleteApp: (appId: string) => Promise<void>;
  launchShortcut: (appId: string) => Promise<SimpleResult>;
  saveGroup: (group: Group) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  /** 拖拽排序后的分组 id 顺序。 */
  reorderGroups: (groupIds: string[]) => Promise<void>;
  /** 把某个服务注册成 Windows 服务（会弹一次 UAC 授权）。 */
  installService: (appId: string) => Promise<SimpleResult & { serviceId?: string }>;
  /** 取消服务托管（停掉并注销服务，程序文件保留）。 */
  uninstallService: (appId: string) => Promise<SimpleResult>;
  /** 打开这个服务的 WinSW 日志目录。 */
  openServiceLogs: (appId: string) => Promise<SimpleResult>;

  startApp: (appId: string) => Promise<SimpleResult>;
  stopApp: (appId: string) => Promise<SimpleResult>;
  restartApp: (appId: string) => Promise<SimpleResult>;
  stopAll: () => Promise<SimpleResult>;
  /** 重新启动所有处于错误状态的应用（托盘菜单用）。 */
  restartFailed: () => Promise<SimpleResult>;
  killPid: (pid: number) => Promise<SimpleResult>;

  selectDirectory: () => Promise<string | null>;
  /** 选一个启动脚本（bat/cmd/ps1/vbs/exe/py/js），用于自动拼启动命令。 */
  selectScriptFile: (defaultPath?: string) => Promise<string | null>;
  openPath: (target: string) => Promise<SimpleResult>;
  openUrl: (url: string) => Promise<void>;
  saveTextFile: (content: string, defaultName: string) => Promise<string | null>;
  /** 打开日志落盘目录。 */
  openLogsDir: () => Promise<SimpleResult>;

  exportConfig: (options?: { groupId?: string | null; appIds?: string[] }) => Promise<string | null>;
  importConfig: () => Promise<ImportResult>;

  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<SimpleResult>;
  getLanAddress: () => Promise<string | null>;

  /** 环境体检：不启动任何东西，跑一遍所有服务的启动前检查。 */
  checkAll: () => Promise<AppCheckResult[]>;
  /** 路径体检：找出工作目录不存在的服务。 */
  checkPaths: () => Promise<PathIssue[]>;
  /** 批量替换路径前缀（工作目录 + 命令行里出现的旧前缀）。 */
  replacePathPrefix: (from: string, to: string) => Promise<{ changed: number }>;
  /** 配置备份列表 / 恢复。 */
  listBackups: () => Promise<BackupEntry[]>;
  restoreBackup: (file: string) => Promise<SimpleResult>;
  /** 导出诊断包（配置 + 状态 + 日志）。 */
  exportDiagnostics: (logs: string) => Promise<string | null>;

  setZoomFactor: (factor: number) => void;
  getZoomFactor: () => number;
  rendererReady: () => void;
  /** 当前是不是以管理员身份在跑。 */
  isElevated: () => Promise<boolean>;
  /** 以管理员身份重启（会弹一次 UAC，然后本进程退出、提权实例接管）。 */
  restartAsAdmin: () => Promise<SimpleResult>;
  /** 退出启动器（会先停掉所有托管服务）。 */
  quit: () => void;

  showAppContextMenu: (appId: string, isRunning: boolean) => Promise<void>;
  onStatusChanged: (callback: (status: ProcessStatus) => void) => () => void;
  onLog: (callback: (log: AppLogEntry) => void) => () => void;
  onConfigUpdated: (callback: () => void) => () => void;
  onSettingsUpdated: (callback: () => void) => () => void;
  onContextMenuAction: (callback: (data: { action: string; appId: string }) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
