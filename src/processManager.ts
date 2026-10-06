import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type {
  AppCheckResult,
  AppConfig,
  AppLogEntry,
  CheckIssue,
  LogEntry,
  ProcessConfig,
  ProcessStatus,
  RunState,
} from './types';
import {
  buildChildrenMap,
  collectTreeWith,
  getListeners,
  getProcessTable,
  isAlive,
  killTree,
  probeHttp,
  queryServiceState,
  runFile,
  waitForExit,
  type ProcInfo,
} from './probe';
import { inferPort, matchProcess, parsePortConflict, summarizeError } from './parse';
import { loadStore } from './config';
import { serviceIdForApp } from './serviceBuilder';
import { controlServiceSmart } from './serviceInstaller';
import { appendMetrics, type MetricSample } from './metrics';
import { evaluatePreflight, expandEnvVars, firstToken, looksLikePath, parseModuleList, type PreflightIssue } from './preflight';

/** 轮询节奏：有服务在启动就快问，都稳定了就慢问，全停了就问得很慢。 */
const TICK_STARTING_MS = 1500;
/** 服务都稳定跑着时没必要问得那么勤（端口死了 6 秒内也能发现）。 */
const TICK_RUNNING_MS = 6000;
const TICK_IDLE_MS = 15000;
/** 长期内存/CPU 采样落盘的间隔。 */
const METRICS_INTERVAL_MS = 60000;

/** 有就绪判据（端口/健康地址/关键字）时，默认多久没就绪就算启动失败。 */
const READY_TIMEOUT_DEFAULT = 60000;
/** 健康检查连续失败几次判定为异常。 */
const HEALTH_FAIL_LIMIT = 3;
/** 已经跑起来之后降低探测频率（毫秒），别每隔 1.5 秒就去戳一次对方接口。 */
const PROBE_RUNNING_MS = 3000;
/** 自动重启退避基数：第 n 次等 n * 5 秒。 */
const AUTO_RESTART_BASE_MS = 5000;
/** 连续稳定运行超过这个时间才把「自动重启计数」清零，避免崩溃循环被当成健康。 */
const HEALTHY_UPTIME_MS = 15000;
const STDERR_TAIL_LIMIT = 6 * 1024;

type StatusListener = (status: ProcessStatus) => void;
type LogListener = (log: AppLogEntry) => void;

interface Runtime {
  appId: string;
  processId: string;
  appName: string;
  processName: string;

  state: RunState;
  ready: boolean;
  /** 本次就绪的起始时间，用于判断「稳定运行」而不是「刚起来又挂」。 */
  readySince?: number;
  child?: ChildProcess;
  pid?: number;
  external: boolean;
  trackedAlive: boolean;
  startedAt?: number;
  restartCount: number;
  stopRequested: boolean;
  exitCode: number | null;
  signal: string | null;
  errorHint?: string;
  stderrTail: string;
  ports: number[];
  preflightIssues?: string[];
  /** 由 Windows 服务托管时的服务名。 */
  serviceName?: string;

  healthFailures: number;
  lastProbeAt: number;
  lastProbeOk: boolean;
  autoRestartAttempts: number;
  autoRestartTimer?: NodeJS.Timeout;
  readinessDeadline?: number;
  startTimer?: NodeJS.Timeout;
  /** 这次退出是我们自己杀出来的（重启前清理），exit 处理器不要当成崩溃。 */
  expectExit?: boolean;
  /** 资源采样：上次的累计 CPU 时间与时刻。 */
  resSample?: { at: number; cpuTime: number };
  /** 落盘指标采样：同上，但按 1 分钟粒度单独算。 */
  metricSample?: { at: number; cpuTime: number };
  cpuPercent?: number;
  memoryMB?: number;

  conflictPort?: number;
  conflictPid?: number;
  conflictProcessName?: string;
  /** 上次广播出去的状态快照（JSON），用于去重。 */
  emitted: string;
}

const utf8Decoder = new TextDecoder('utf-8');
let gbkDecoder: TextDecoder | null = null;

/** 中文 Windows 上不少工具输出 GBK，先用 UTF-8 试，出现乱码再按 GBK 解。 */
function decodeChunk(data: Buffer): string {
  const utf8 = utf8Decoder.decode(data);
  if (process.platform !== 'win32' || !utf8.includes('\uFFFD')) return utf8;
  try {
    gbkDecoder ??= new TextDecoder('gbk');
    return gbkDecoder.decode(data);
  } catch {
    return utf8;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ProcessManager {
  private runtimes = new Map<string, Runtime>();
  private apps = new Map<string, AppConfig>();
  private timer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private refreshChain: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  /** 窗口隐藏时不采样资源，避免一直在后台起 PowerShell 查进程表。 */
  private resourceSampling = true;
  /** 每日定时重启：appId -> 已执行过的「日期 时间」。 */
  private dailyRestartDone = new Map<string, string>();
  private scheduledRestarting = new Set<string>();

  constructor(private onStatus: StatusListener, private onLog: LogListener) {}

  /* ---------------- 配置同步 ---------------- */

  setApps(apps: AppConfig[]): void {
    this.apps = new Map(apps.map((a) => [a.id, a]));
    const alive = new Set<string>();
    for (const appConfig of apps) {
      if (appConfig.kind === 'shortcut') continue; // 快捷方式不托管、不跟踪状态
      for (const proc of appConfig.processes) alive.add(this.key(appConfig.id, proc.id));
    }
    for (const key of [...this.runtimes.keys()]) {
      if (!alive.has(key)) this.runtimes.delete(key);
    }
    for (const appConfig of apps) {
      if (appConfig.kind === 'shortcut') continue;
      for (const proc of appConfig.processes) this.ensureRuntime(appConfig, proc);
    }
    this.emitAll();
    // 立刻检测一次：不然刚打开启动器要等第一个轮询周期才认出手工启动的服务
    void this.refresh();
  }

  start(): void {
    if (this.timer) return;
    if (!this.metricsTimer) {
      this.metricsTimer = setInterval(
        () => void this.sampleMetrics().catch((error) => console.error('指标采样失败:', error)),
        METRICS_INTERVAL_MS
      );
    }
    this.scheduleNextTick();
  }

  /** 自适应轮询：自己安排下一次，按当前状态决定间隔。 */
  private scheduleNextTick(): void {
    if (this.shuttingDown) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().finally(() => this.scheduleNextTick());
    }, this.currentTickMs());
  }

  private currentTickMs(): number {
    let hasStarting = false;
    let hasRunning = false;
    for (const runtime of this.runtimes.values()) {
      if (runtime.state === 'starting') hasStarting = true;
      else if (runtime.state === 'running') hasRunning = true;
    }
    if (hasStarting) return TICK_STARTING_MS;
    if (hasRunning) return TICK_RUNNING_MS;
    return TICK_IDLE_MS;
  }

  setResourceSampling(enabled: boolean): void {
    this.resourceSampling = enabled;
  }

  stopLoop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.metricsTimer = null;
  }

  /** 进入退出流程：不再触发自动重启。 */
  beginShutdown(): void {
    this.shuttingDown = true;
    for (const runtime of this.runtimes.values()) {
      if (runtime.autoRestartTimer) clearTimeout(runtime.autoRestartTimer);
      runtime.autoRestartTimer = undefined;
    }
  }

  private key(appId: string, processId: string): string {
    return `${appId}::${processId}`;
  }

  private ensureRuntime(appConfig: AppConfig, proc: ProcessConfig): Runtime {
    const key = this.key(appConfig.id, proc.id);
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = {
        appId: appConfig.id,
        processId: proc.id,
        appName: appConfig.name,
        processName: proc.name,
        state: 'stopped',
        ready: false,
        external: false,
        trackedAlive: false,
        restartCount: 0,
        stopRequested: false,
        exitCode: null,
        signal: null,
        stderrTail: '',
        ports: [],
        healthFailures: 0,
        lastProbeAt: 0,
        lastProbeOk: false,
        autoRestartAttempts: 0,
        emitted: '',
      };
      this.runtimes.set(key, runtime);
    }
    runtime.appName = appConfig.name;
    runtime.processName = proc.name;
    runtime.serviceName = proc.service;
    return runtime;
  }

  /* ---------------- 对外查询 ---------------- */

  getSnapshot(): ProcessStatus[] {
    return [...this.runtimes.values()].map((r) => this.toStatus(r));
  }

  isAppActive(appId: string): boolean {
    for (const r of this.runtimes.values()) {
      if (r.appId === appId && (r.state === 'running' || r.state === 'starting')) return true;
    }
    return false;
  }

  /* ---------------- 就绪判据 ---------------- */

  private effectivePort(proc: ProcessConfig): number | undefined {
    return proc.port ?? inferPort(proc.command);
  }

  private hasCriterion(proc: ProcessConfig): boolean {
    return (
      Boolean(proc.service) ||
      Boolean(proc.healthUrl) ||
      this.effectivePort(proc) !== undefined ||
      Boolean(proc.match)
    );
  }

  private readinessTimeout(proc: ProcessConfig): number {
    if (typeof proc.startTimeoutMs === 'number' && proc.startTimeoutMs > 0) return proc.startTimeoutMs;
    return this.hasCriterion(proc) ? READY_TIMEOUT_DEFAULT : 0;
  }

  /* ---------------- 启动前预检 ---------------- */

  private async runPreflight(appConfig: AppConfig, proc: ProcessConfig): Promise<PreflightIssue[]> {
    const workingDir = path.normalize(appConfig.workingDir);
    const dirExists = fs.existsSync(workingDir);
    const issues = evaluatePreflight(proc, {
      workingDir,
      dirExists,
      exists: (target) => fs.existsSync(target),
      hasPackageJson: dirExists && fs.existsSync(path.join(workingDir, 'package.json')),
      hasNodeModules: dirExists && fs.existsSync(path.join(workingDir, 'node_modules')),
      env: process.env,
    });

    const modules = parseModuleList(proc.preflightImports);
    if (modules.length > 0 && dirExists) {
      const python = this.resolvePython(proc.command, workingDir);
      const result = await runFile(python, ['-c', `import ${modules.join(', ')}`], workingDir, 25000);
      if (!result.ok) {
        issues.push({
          message: `Python 依赖缺失：${modules.join(', ')}`,
          fix: `在 ${workingDir} 执行 pip install -r requirements.txt`,
        });
      }
    }

    return issues;
  }

  /** 从命令行里取出 python 解释器（绝对路径优先，其次 PATH 里的名字）。 */
  private resolvePython(command: string, workingDir: string): string {
    const token = firstToken(command);
    if (looksLikePath(token)) {
      const expanded = expandEnvVars(token, process.env);
      return path.isAbsolute(expanded) ? expanded : path.join(workingDir, expanded);
    }
    if (/^python(w)?(\.exe)?$/i.test(token)) return token;
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  /** 查一个 PID 的进程名，用于「端口被谁占了」这类提示。 */
  private async describePid(pid: number): Promise<string> {
    try {
      const { data } = await getProcessTable();
      return data.find((p) => p.pid === pid)?.name ?? '';
    } catch {
      return '';
    }
  }

  /** 环境体检：不启动任何东西，把所有服务的启动前检查跑一遍。 */
  async checkAll(): Promise<AppCheckResult[]> {
    const results: AppCheckResult[] = [];
    for (const appConfig of this.apps.values()) {
      for (const proc of appConfig.processes) {
        const issues: CheckIssue[] = await this.runPreflight(appConfig, proc);

        const port = this.effectivePort(proc);
        if (port !== undefined) {
          const listeners = await getListeners();
          let holderPid = 0;
          for (const [pid, ports] of listeners) {
            if (ports.includes(port)) {
              holderPid = pid;
              break;
            }
          }
          // 自己已经在跑的不算问题
          const runtime = this.runtimes.get(this.key(appConfig.id, proc.id));
          const mine = runtime?.state === 'running' || runtime?.state === 'starting';
          if (holderPid > 0 && !mine) {
            const holderName = await this.describePid(holderPid);
            issues.push({
              message: `端口 ${port} 已被 PID ${holderPid}${holderName ? ` (${holderName})` : ''} 占用`,
              fix: '先结束占用端口的进程，或改这个服务的端口',
            });
          }
        }

        results.push({
          appId: appConfig.id,
          appName: appConfig.name,
          processName: proc.name,
          issues,
        });
      }
    }
    return results;
  }

  /* ---------------- 启停 ---------------- */

  async startApp(appId: string): Promise<void> {
    const appConfig = this.apps.get(appId);
    if (!appConfig) throw new Error('应用不存在');

    // 先跑一次检测：如果服务已经在跑（手工起的、或上次没退干净），
    // 先接管再判断，避免又拉起一份造成端口被两个进程同时绑定。
    await this.refresh();
    if (this.isAppActive(appId)) throw new Error('该应用已在运行');

    let timeout = 0;
    for (const proc of appConfig.processes) {
      const runtime = this.ensureRuntime(appConfig, proc);
      if (runtime.state === 'running' || runtime.state === 'starting') {
        timeout = Math.max(timeout, this.readinessTimeout(proc));
        continue;
      }
      runtime.autoRestartAttempts = 0;
      timeout = Math.max(timeout, this.readinessTimeout(proc));

      // Windows 服务托管的：让服务管理器去起，不直接拉进程
      if (proc.service) {
        const result = await controlServiceSmart(proc.service, 'start');
        if (!result.ok) {
          throw new Error(`启动服务「${proc.service}」失败：${result.output || '可能需要管理员权限'}`);
        }
        continue;
      }

      await this.spawnProcess(appConfig, proc, runtime);
    }

    // 等到「起来了」或「明确失败」再返回，启动全部才能按顺序等前一个就绪
    await this.waitSettled(appId, timeout + 5000);
  }

  private async spawnProcess(appConfig: AppConfig, proc: ProcessConfig, runtime: Runtime): Promise<void> {
    runtime.state = 'starting';
    runtime.ready = false;
    runtime.external = false;
    runtime.stopRequested = false;
    runtime.exitCode = null;
    runtime.signal = null;
    runtime.errorHint = undefined;
    runtime.stderrTail = '';
    runtime.ports = [];
    runtime.preflightIssues = undefined;
    runtime.healthFailures = 0;
    runtime.readinessDeadline = undefined;
    runtime.conflictPort = undefined;
    runtime.conflictPid = undefined;
    runtime.conflictProcessName = undefined;
    runtime.expectExit = false;
    this.emit(runtime);

    const issues = await this.runPreflight(appConfig, proc);
    if (issues.length > 0) {
      runtime.state = 'error';
      runtime.preflightIssues = issues.map((i) => (i.fix ? `${i.message} → ${i.fix}` : i.message));
      runtime.errorHint = '启动前预检未通过';
      this.emit(runtime);
      this.pushLog(runtime, 'system', `启动前预检未通过：\n- ${runtime.preflightIssues.join('\n- ')}`);
      return;
    }

    // 启动前端口占用预检：端口被别的程序占着就别硬起，报清楚是谁占的
    const targetPort = this.effectivePort(proc);
    if (targetPort !== undefined) {
      const listeners = await getListeners();
      let holderPid = 0;
      for (const [pid, ports] of listeners) {
        if (ports.includes(targetPort)) {
          holderPid = pid;
          break;
        }
      }
      if (holderPid > 0 && isAlive(holderPid)) {
        const holderName = await this.describePid(holderPid);
        runtime.state = 'error';
        runtime.conflictPort = targetPort;
        runtime.conflictPid = holderPid;
        runtime.conflictProcessName = holderName;
        runtime.errorHint = `端口 ${targetPort} 已被 PID ${holderPid}${holderName ? ` (${holderName})` : ''} 占用，未启动`;
        this.emit(runtime);
        this.pushLog(runtime, 'system', runtime.errorHint);
        return;
      }
    }

    runtime.startedAt = Date.now();

    let child: ChildProcess;
    try {
      child = spawn(proc.command, [], {
        cwd: path.normalize(appConfig.workingDir),
        env: {
          ...process.env,
          ...appConfig.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
        shell: proc.shell !== false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      runtime.state = 'error';
      runtime.errorHint = error instanceof Error ? error.message : '启动失败';
      this.emit(runtime);
      this.pushLog(runtime, 'system', `启动失败：${runtime.errorHint}`);
      return;
    }

    runtime.child = child;
    runtime.pid = child.pid;
    runtime.trackedAlive = true;

    child.on('spawn', () => {
      if (runtime.startTimer) clearTimeout(runtime.startTimer);
      runtime.startTimer = undefined;
      runtime.pid = child.pid;
      runtime.startedAt = Date.now();
      this.pushLog(runtime, 'system', `已启动（PID ${child.pid}）`);

      if (this.hasCriterion(proc)) {
        // 进程起来 ≠ 服务可用，交给就绪探测决定何时变成「运行中」
        const timeout = this.readinessTimeout(proc);
        runtime.readinessDeadline = timeout > 0 ? Date.now() + timeout : undefined;
        this.emit(runtime);
      } else {
        runtime.state = 'running';
        runtime.ready = true;
        runtime.readySince = Date.now();
        this.emit(runtime);
      }
    });

    child.stdout?.on('data', (data: Buffer) => this.pushLog(runtime, 'stdout', decodeChunk(data)));
    child.stderr?.on('data', (data: Buffer) => this.handleStderr(runtime, decodeChunk(data)));

    child.on('error', (error) => {
      if (runtime.startTimer) clearTimeout(runtime.startTimer);
      runtime.startTimer = undefined;
      runtime.state = 'error';
      runtime.errorHint = error.message;
      this.appendTail(runtime, `\n${error.message}\n`);
      this.emit(runtime);
      this.pushLog(runtime, 'system', `错误：${error.message}`);
    });

    child.on('exit', (code, signal) => {
      if (runtime.startTimer) clearTimeout(runtime.startTimer);
      runtime.startTimer = undefined;
      runtime.child = undefined;
      runtime.trackedAlive = false;
      runtime.ready = false;
      runtime.readySince = undefined;
      runtime.exitCode = code;
      runtime.signal = signal || null;

      if (runtime.stopRequested || runtime.expectExit || code === 0) {
        runtime.expectExit = false;
        runtime.state = 'stopped';
        runtime.pid = undefined;
        runtime.ports = [];
        runtime.errorHint = undefined;
        this.emit(runtime);
      } else {
        runtime.state = 'error';
        runtime.errorHint = summarizeError(runtime.stderrTail, code);
        runtime.pid = undefined;
        runtime.ports = [];
        this.emit(runtime);
        this.scheduleAutoRestart(appConfig, proc, runtime);
      }
      this.pushLog(
        runtime,
        'system',
        `进程退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`
      );
    });
  }

  /* ---------------- 崩溃自动重启 ---------------- */

  private scheduleAutoRestart(appConfig: AppConfig, proc: ProcessConfig, runtime: Runtime): void {
    if (this.shuttingDown || runtime.stopRequested) return;
    const max = proc.autoRestartMax ?? 3;
    if (max <= 0) return;

    if (runtime.autoRestartAttempts >= max) {
      runtime.errorHint = `${runtime.errorHint || '异常'}；已自动重启 ${max} 次仍失败，不再重试`;
      this.emit(runtime);
      this.pushLog(runtime, 'system', runtime.errorHint);
      return;
    }

    runtime.autoRestartAttempts += 1;
    const delayMs = AUTO_RESTART_BASE_MS * runtime.autoRestartAttempts;
    const reason = runtime.errorHint || '异常';
    runtime.errorHint = `${reason}；${Math.round(delayMs / 1000)} 秒后自动重启（第 ${runtime.autoRestartAttempts}/${max} 次）`;
    this.emit(runtime);
    this.pushLog(runtime, 'system', runtime.errorHint);

    runtime.autoRestartTimer = setTimeout(() => {
      runtime.autoRestartTimer = undefined;
      if (this.shuttingDown || runtime.stopRequested) return;
      void this.restartRuntime(appConfig, proc, runtime);
    }, delayMs);
  }

  /**
   * 自动重启前先把上一份残留进程清掉。
   * 不清就会出现「同一个端口绑了好几份实例」——端口能绑上但请求没人应答，
   * 服务反而被重启搞坏。
   */
  private async restartRuntime(appConfig: AppConfig, proc: ProcessConfig, runtime: Runtime): Promise<void> {
    // 先确认「是不是已经有一份在跑」：手工启动的、或者程序自己转成后台的。
    // 有的话直接认下来，别再拉一份去抢单实例锁 —— 否则会陷入
    // 拉起→被锁挡下退出→再拉起 的循环，界面上一直闪「异常」。
    const live = await this.findLiveOwner(proc, runtime);
    if (live > 0) {
      runtime.state = 'running';
      runtime.ready = true;
      runtime.pid = live;
      runtime.external = true;
      runtime.errorHint = undefined;
      runtime.autoRestartAttempts = 0;
      if (runtime.readySince === undefined) runtime.readySince = Date.now();
      this.emit(runtime);
      this.pushLog(runtime, 'system', `已有一份在运行（PID ${live}），不再重复启动`);
      return;
    }

    const pids = new Set<number>();
    if (runtime.child?.pid) pids.add(runtime.child.pid);
    if (runtime.pid) pids.add(runtime.pid);

    if (pids.size > 0) {
      runtime.expectExit = true;
      for (const pid of pids) {
        if (isAlive(pid)) await killTree(pid);
      }
      for (const pid of pids) await waitForExit(pid, 4000);
    }

    runtime.expectExit = false;
    runtime.child = undefined;
    runtime.trackedAlive = false;
    runtime.pid = undefined;

    if (this.shuttingDown || runtime.stopRequested) return;

    // 等端口真的空出来，避免新实例 EADDRINUSE
    const port = this.effectivePort(proc);
    if (port !== undefined) {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const listeners = await getListeners();
        const busy = [...listeners.values()].some((list) => list.includes(port));
        if (!busy) break;
        await sleep(250);
      }
    }

    await this.spawnProcess(appConfig, proc, runtime);
  }

  /**
   * 找一份「活着、但不是我们这次拉起来的那份」的实例：
   * 端口持有者，或者命令行/进程名命中关键字。
   */
  private async findLiveOwner(proc: ProcessConfig, runtime: Runtime): Promise<number> {
    const port = this.effectivePort(proc);
    if (port === undefined && !proc.match) return 0;

    const [listeners, snapshot] = await Promise.all([
      port !== undefined ? getListeners() : Promise.resolve(new Map<number, number[]>()),
      proc.match ? getProcessTable(0) : Promise.resolve({ data: [] as ProcInfo[], at: 0 }),
    ]);

    const own = runtime.child?.pid;
    if (port !== undefined) {
      for (const [pid, ports] of listeners) {
        if (ports.includes(port) && pid !== own) return pid;
      }
    }
    if (proc.match) {
      const hit = this.findByMatch(snapshot.data, proc.match, own);
      if (hit > 0) return hit;
    }
    return 0;
  }

  private handleStderr(runtime: Runtime, content: string): void {
    const conflictPort = parsePortConflict(content);
    if (conflictPort !== undefined) {
      runtime.conflictPort = conflictPort;
      void getListeners().then((listeners) => {
        for (const [pid, ports] of listeners) {
          if (ports.includes(conflictPort)) {
            runtime.conflictPid = pid;
            this.emit(runtime);
            return;
          }
        }
      });
      this.emit(runtime);
    }

    this.appendTail(runtime, content);
    runtime.errorHint = summarizeError(runtime.stderrTail, null);
    this.emit(runtime);
    this.pushLog(runtime, 'stderr', content);
  }

  private appendTail(runtime: Runtime, chunk: string): void {
    runtime.stderrTail = (runtime.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  }

  /** 停止单个应用：真正杀掉进程并确认已退出，避免「显示停止但进程还在」。 */
  async stopApp(appId: string): Promise<void> {
    const targets = [...this.runtimes.values()].filter((r) => r.appId === appId);
    await Promise.all(targets.map((r) => this.stopRuntime(r)));
  }

  private async stopRuntime(runtime: Runtime): Promise<void> {
    runtime.stopRequested = true;
    runtime.ready = false;
    runtime.readySince = undefined;
    runtime.healthFailures = 0;

    // Windows 服务托管的：交给服务管理器停，不要直接杀进程
    if (runtime.serviceName) {
      if (runtime.autoRestartTimer) {
        clearTimeout(runtime.autoRestartTimer);
        runtime.autoRestartTimer = undefined;
      }
      const result = await controlServiceSmart(runtime.serviceName, 'stop');
      if (!result.ok) {
        runtime.state = 'error';
        runtime.errorHint = `停止服务「${runtime.serviceName}」失败：${result.output || '可能需要管理员权限'}`;
        this.emit(runtime);
        return;
      }
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const state = await queryServiceState(runtime.serviceName);
        if (!state.running) break;
        await sleep(500);
      }
      runtime.state = 'stopped';
      runtime.pid = undefined;
      runtime.ports = [];
      runtime.errorHint = undefined;
      this.emit(runtime);
      return;
    }

    if (runtime.startTimer) {
      clearTimeout(runtime.startTimer);
      runtime.startTimer = undefined;
    }
    if (runtime.autoRestartTimer) {
      clearTimeout(runtime.autoRestartTimer);
      runtime.autoRestartTimer = undefined;
    }

    const pids = new Set<number>();
    if (runtime.child?.pid) pids.add(runtime.child.pid);
    if (runtime.pid) pids.add(runtime.pid);

    if (pids.size === 0) {
      runtime.state = 'stopped';
      runtime.external = false;
      runtime.pid = undefined;
      runtime.ports = [];
      this.emit(runtime);
      return;
    }

    for (const pid of pids) {
      if (isAlive(pid)) await killTree(pid);
    }

    let stillAlive = false;
    for (const pid of pids) {
      const gone = await waitForExit(pid, 6000);
      if (!gone) stillAlive = true;
    }

    runtime.child = undefined;
    runtime.trackedAlive = false;
    if (stillAlive) {
      runtime.state = 'error';
      runtime.errorHint = '无法结束进程（可能被其他程序占用，可尝试强制重启）';
    } else {
      runtime.state = 'stopped';
      runtime.pid = undefined;
      runtime.ports = [];
      runtime.errorHint = undefined;
      runtime.conflictPort = undefined;
      runtime.conflictPid = undefined;
      runtime.conflictProcessName = undefined;
    }
    this.emit(runtime);
  }

  async restartApp(appId: string): Promise<void> {
    const appConfig = this.apps.get(appId);
    if (!appConfig) throw new Error('应用不存在');

    await this.stopApp(appId);

    // 等端口真正释放，再重新拉起，避免 EADDRINUSE
    const ports = appConfig.processes
      .map((p) => this.effectivePort(p))
      .filter((p): p is number => p !== undefined);
    if (ports.length > 0) {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const listeners = await getListeners();
        const busy = [...listeners.values()].some((list) => list.some((port) => ports.includes(port)));
        if (!busy) break;
        await sleep(250);
      }
    }

    for (const proc of appConfig.processes) {
      const runtime = this.ensureRuntime(appConfig, proc);
      runtime.restartCount += 1;
      runtime.autoRestartAttempts = 0;
      await this.spawnProcess(appConfig, proc, runtime);
    }
    await this.waitSettled(appId, this.settleTimeout(appConfig) + 5000);
  }

  /** 重启所有处于错误状态的应用，返回处理数量（托盘菜单用）。 */
  async restartFailed(): Promise<number> {
    const failed = new Set(
      [...this.runtimes.values()].filter((r) => r.state === 'error').map((r) => r.appId)
    );
    for (const appId of failed) {
      try {
        await this.restartApp(appId);
      } catch (error) {
        console.error('重启异常服务失败:', appId, error);
      }
    }
    return failed.size;
  }

  private settleTimeout(appConfig: AppConfig): number {
    let timeout = 0;
    for (const proc of appConfig.processes) timeout = Math.max(timeout, this.readinessTimeout(proc));
    return Math.max(timeout, 5000);
  }

  /** 等到该应用所有进程都「就绪」或「明确失败」。 */
  private async waitSettled(appId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.refresh();
      const list = [...this.runtimes.values()].filter((r) => r.appId === appId);
      const failed = list.find((r) => r.state === 'error');
      if (failed) throw new Error(failed.errorHint || '启动失败');
      if (!list.some((r) => r.state === 'starting')) return;
      await sleep(350);
    }
    throw new Error('启动超时：等待就绪超时（进程可能仍在运行，可查看日志）');
  }

  /**
   * 停止所有服务。
   * includeExternal=false 时只停「本启动器拉起来的」，外部启动的（比如手工开的窗口）保持不动——
   * 退出启动器不应该顺手杀掉用户自己开的进程。
   */
  async stopAll(includeExternal = true): Promise<void> {
    const targets = [...this.runtimes.values()].filter((runtime) => {
      if (runtime.state === 'stopped') return false;
      if (includeExternal) return true;
      return Boolean(runtime.child) || runtime.trackedAlive;
    });
    await Promise.all(targets.map((runtime) => this.stopRuntime(runtime).catch((): void => undefined)));
  }

  /* ---------------- 检测 ---------------- */

  private refresh(): Promise<void> {
    this.refreshChain = this.refreshChain.then(() => this.doRefresh()).catch((error) => {
      console.error('状态刷新失败:', error);
    });
    return this.refreshChain;
  }

  private async doRefresh(): Promise<void> {
    const apps = [...this.apps.values()];
    const needListeners = apps.some((a) => a.processes.some((p) => this.effectivePort(p) !== undefined));
    const needTableForMatch = apps.some((a) =>
      a.processes.some((p) => this.effectivePort(p) === undefined && p.match)
    );
    const hasActive = [...this.runtimes.values()].some(
      (r) => r.state === 'running' || r.state === 'starting'
    );
    const needTable = needTableForMatch || (this.resourceSampling && hasActive);

    const [listeners, tableSnap] = await Promise.all([
      needListeners ? getListeners() : Promise.resolve(new Map<number, number[]>()),
      needTable ? getProcessTable() : Promise.resolve({ data: [] as ProcInfo[], at: Date.now() }),
    ]);
    const table = tableSnap.data;

    // 一轮只建一次进程树索引，9 个服务共用
    const childrenOf = table.length > 0 ? buildChildrenMap(table) : new Map<number, number[]>();

    for (const appConfig of apps) {
      for (const proc of appConfig.processes) {
        const runtime = this.ensureRuntime(appConfig, proc);
        await this.evaluate(appConfig, proc, runtime, listeners, table);
        this.applyResources(runtime, table, childrenOf, tableSnap.at);
      }
    }

    this.checkSchedules();
  }

  /** 汇总进程树的 CPU / 内存占用。CPU 以「单核 100%」为准。 */
  private applyResources(
    runtime: Runtime,
    table: ProcInfo[],
    childrenOf: Map<number, number[]>,
    sampledAt: number
  ): void {
    if (table.length === 0 || runtime.state === 'stopped' || !runtime.pid) {
      runtime.cpuPercent = undefined;
      runtime.memoryMB = undefined;
      runtime.resSample = undefined;
      return;
    }
    const tree = collectTreeWith(childrenOf, runtime.pid);
    let cpuTime = 0;
    let workingSet = 0;
    const byPid = new Map(table.map((p) => [p.pid, p]));
    for (const pid of tree) {
      const info = byPid.get(pid);
      if (!info) continue;
      cpuTime += info.cpuTime;
      workingSet += info.workingSet;
    }
    // 用进程表的采样时刻算区间：轮询间隔和 CPU 计数的区间不是一回事
    const now = sampledAt;
    const previous = runtime.resSample;
    const beforeCpu = runtime.cpuPercent;
    const beforeMem = runtime.memoryMB;
    if (previous && now > previous.at) {
      const deltaCpu = cpuTime - previous.cpuTime; // 100ns 单位
      const deltaMs = now - previous.at;
      runtime.cpuPercent = Math.max(0, Math.round((deltaCpu / (deltaMs * 10000)) * 100));
    }
    runtime.resSample = { at: now, cpuTime };
    runtime.memoryMB = Math.max(0, Math.round(workingSet / (1024 * 1024)));
    // 资源变了要推一次，否则界面上要等下一个状态变化才显示出来
    if (runtime.cpuPercent !== beforeCpu || runtime.memoryMB !== beforeMem) this.emit(runtime);
  }

  /**
   * 长期采样：每分钟把运行中服务的 CPU / 内存写进 metrics 文件，
   * 这样关掉启动器以后还能看一天/一周的内存曲线（排查慢涨）。
   * 和界面用的资源采样分开，收进托盘也照常记。
   */
  private async sampleMetrics(): Promise<void> {
    if (this.shuttingDown) return;
    const active = [...this.runtimes.values()].filter((r) => r.state === 'running' && r.pid);
    if (active.length === 0) return;

    // 指标采样要拿「最新」的累计 CPU 时间，否则算出来的百分比区间会错位
    const snapshot = await getProcessTable(0);
    const table = snapshot.data;
    if (table.length === 0) return;

    // 用进程表自己的采样时刻，保证 CPU 百分比的时间区间和计数区间一致
    const at = snapshot.at;
    const childrenOf = buildChildrenMap(table);
    const byPid = new Map(table.map((p) => [p.pid, p]));
    const samples: MetricSample[] = [];
    for (const runtime of active) {
      const tree = collectTreeWith(childrenOf, runtime.pid as number);
      let workingSet = 0;
      let cpuTime = 0;
      for (const pid of tree) {
        const info = byPid.get(pid);
        if (!info) continue;
        workingSet += info.workingSet;
        cpuTime += info.cpuTime;
      }
      const previous = runtime.metricSample;
      let cpu = 0;
      if (previous && at > previous.at) {
        cpu = Math.max(0, Math.round(((cpuTime - previous.cpuTime) / ((at - previous.at) * 10000)) * 100));
      }
      runtime.metricSample = { at, cpuTime };
      samples.push({
        key: this.key(runtime.appId, runtime.processId),
        cpu,
        mem: Math.max(0, Math.round(workingSet / (1024 * 1024))),
      });
    }
    appendMetrics(samples);
  }

  /** 每日定时重启：到点且服务正在跑才重启。 */
  private checkSchedules(): void {
    if (this.shuttingDown) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${hhmm}`;

    for (const appConfig of this.apps.values()) {
      if (appConfig.kind === 'shortcut' || !appConfig.dailyRestartAt) continue;
      if (appConfig.dailyRestartAt !== hhmm) continue;
      if (this.dailyRestartDone.get(appConfig.id) === stamp) continue;
      if (this.scheduledRestarting.has(appConfig.id)) continue;

      const running = [...this.runtimes.values()].filter(
        (r) => r.appId === appConfig.id && (r.state === 'running' || r.state === 'starting')
      );
      if (running.length === 0) continue; // 没在跑就不管

      this.dailyRestartDone.set(appConfig.id, stamp);
      this.scheduledRestarting.add(appConfig.id);
      for (const runtime of running) {
        this.pushLog(runtime, 'system', `到达定时重启时间（每日 ${hhmm}），正在重启…`);
      }
      void this.restartApp(appConfig.id)
        .catch((error) => console.error('定时重启失败:', appConfig.id, error))
        .finally(() => this.scheduledRestarting.delete(appConfig.id));
    }
  }

  /**
   * 配置里记的服务名可能过期（服务改过名、导入过旧配置）。
   * 配置名没在跑的时候，再按启动器自己的命名约定 LauncherSvc-<appId> 查一次，
   * 查到就用它，免得界面上把正在跑的服务显示成「未安装 / 已停止」。
   */
  private async resolveServiceName(appId: string, configured: string): Promise<string> {
    const configuredState = await queryServiceState(configured);
    if (configuredState.running) return configured;
    const fallback = serviceIdForApp(appId);
    if (fallback === configured) return configured;
    const fallbackState = await queryServiceState(fallback);
    return fallbackState.exists ? fallback : configured;
  }

  private async evaluate(
    appConfig: AppConfig,
    proc: ProcessConfig,
    runtime: Runtime,
    listeners: Map<number, number[]>,
    table: ProcInfo[]
  ): Promise<void> {
    const trackedPid = runtime.child?.pid;
    const trackedAlive = trackedPid !== undefined && isAlive(trackedPid);
    runtime.trackedAlive = trackedAlive;

    const port = this.effectivePort(proc);

    // 找当前谁在持有这个服务（可能是本启动器起的，也可能是手工起的）
    let ownerPid = 0;
    if (port !== undefined) {
      for (const [pid, list] of listeners) {
        if (list.includes(port)) {
          ownerPid = pid;
          break;
        }
      }
    }
    if (ownerPid === 0 && proc.match) ownerPid = this.findByMatch(table, proc.match, trackedPid);
    if (ownerPid === 0 && trackedAlive) ownerPid = trackedPid;

    const processAlive = trackedAlive || ownerPid > 0;

    // 由 Windows 服务托管的进程：状态直接问服务，比查进程表准（服务进程在 session 0，命令行读不到）
    if (proc.service) {
      const serviceName = await this.resolveServiceName(appConfig.id, proc.service);
      const state = await queryServiceState(serviceName);
      if (!state.exists) {
        runtime.state = 'error';
        runtime.errorHint = `Windows 服务「${serviceName}」未安装`;
        runtime.pid = undefined;
        runtime.ports = [];
        runtime.ready = false;
        runtime.serviceName = serviceName;
        this.emit(runtime);
        return;
      }
      if (state.running) {
        runtime.healthFailures = 0;
        runtime.ready = true;
        runtime.state = 'running';
        runtime.serviceName = serviceName;
        runtime.pid = state.pid;
        runtime.external = false;
        runtime.ports = state.pid ? listeners.get(state.pid) ?? [] : [];
        if (runtime.readySince === undefined) runtime.readySince = Date.now();
        if (!runtime.startedAt) runtime.startedAt = runtime.readySince;
        this.emit(runtime);
        return;
      }
      runtime.ready = false;
      runtime.readySince = undefined;
      runtime.state = 'stopped';
      runtime.pid = undefined;
      runtime.ports = [];
      runtime.errorHint = undefined;
      runtime.serviceName = serviceName;
      this.emit(runtime);
      return;
    }

    // 就绪判定
    let ready: boolean;
    if (proc.healthUrl) {
      const interval = runtime.state === 'starting' ? 0 : PROBE_RUNNING_MS;
      if (processAlive || runtime.state === 'running' || runtime.state === 'starting') {
        if (interval === 0 || Date.now() - runtime.lastProbeAt >= interval) {
          runtime.lastProbeAt = Date.now();
          runtime.lastProbeOk = await probeHttp(proc.healthUrl);
        }
        ready = runtime.lastProbeOk;
      } else {
        // 服务根本没在跑，没必要去打它的接口
        runtime.lastProbeOk = false;
        ready = false;
      }
    } else if (port !== undefined) {
      ready = ownerPid > 0;
    } else if (proc.match) {
      ready = ownerPid > 0;
    } else {
      ready = trackedAlive;
    }

    runtime.pid = ownerPid > 0 ? ownerPid : undefined;
    // 端口实际持有者常常是我们拉起的 cmd 的子进程，"不是同一个 PID" 不等于"外部启动"
    runtime.external = ownerPid > 0 && ownerPid !== trackedPid && !trackedAlive;
    runtime.ports = ownerPid > 0 ? listeners.get(ownerPid) ?? (port ? [port] : []) : [];

    if (ready) {
      runtime.healthFailures = 0;
      runtime.ready = true;
      runtime.readinessDeadline = undefined;
      runtime.state = 'running';
      if (runtime.readySince === undefined) runtime.readySince = Date.now();
      if (!runtime.startedAt) runtime.startedAt = runtime.readySince;
      // 稳定跑够一段时间才算真的好了，再清空重试计数
      if (Date.now() - runtime.readySince >= HEALTHY_UPTIME_MS) runtime.autoRestartAttempts = 0;
      this.emit(runtime);
      return;
    }

    runtime.ready = false;
    runtime.readySince = undefined;

    // 运行中变成探测失败：连续失败够次数才算异常（避免一次抖动就报警）
    if (runtime.state === 'running' && proc.healthUrl && processAlive) {
      runtime.healthFailures += 1;
      if (runtime.healthFailures >= HEALTH_FAIL_LIMIT) {
        runtime.state = 'error';
        runtime.errorHint = `健康检查连续 ${HEALTH_FAIL_LIMIT} 次失败：${proc.healthUrl}`;
        runtime.autoRestartAttempts = 0;
        this.emit(runtime);
        this.pushLog(runtime, 'system', runtime.errorHint);
        this.scheduleAutoRestart(appConfig, proc, runtime);
      }
      return;
    }

    if (runtime.state === 'error') return; // 错误状态是粘性的，等重启或用户操作

    if (trackedAlive) {
      // 进程活着但还没就绪
      if (runtime.readinessDeadline && Date.now() > runtime.readinessDeadline) {
        const seconds = Math.round(this.readinessTimeout(proc) / 1000);
        runtime.state = 'error';
        runtime.errorHint = `启动超时：${seconds} 秒内未通过就绪探测（检查 healthUrl 路径是否正确、端口是否被别的程序占用）`;
        this.emit(runtime);
        this.pushLog(runtime, 'system', runtime.errorHint);
        this.scheduleAutoRestart(appConfig, proc, runtime);
        return;
      }
      runtime.state = 'starting';
      this.emit(runtime);
      return;
    }

    if (runtime.state === 'starting') {
      // 进程还没被 spawn 出来（预检中）或刚退出，交给 exit 处理器
      this.emit(runtime);
      return;
    }

    this.markStopped(runtime);
  }

  private findByMatch(table: ProcInfo[], keyword: string, preferredRoot?: number): number {
    const hits = table.filter((p) => matchProcess({ name: p.name, commandLine: p.commandLine }, keyword));
    if (hits.length === 0) return 0;
    if (preferredRoot) {
      const tree = collectTreeWith(this.tableIndex(table), preferredRoot);
      const inTree = hits.find((p) => tree.includes(p.pid));
      if (inTree) return inTree.pid;
    }
    return hits[0].pid;
  }

  /** 进程树索引缓存：同一轮里多个服务共用，避免反复建表。 */
  private indexCache: { table: ProcInfo[]; index: Map<number, number[]> } | null = null;

  private tableIndex(table: ProcInfo[]): Map<number, number[]> {
    if (this.indexCache && this.indexCache.table === table) return this.indexCache.index;
    const index = buildChildrenMap(table);
    this.indexCache = { table, index };
    return index;
  }

  private markStopped(runtime: Runtime): void {
    if (
      runtime.state === 'stopped' &&
      runtime.pid === undefined &&
      runtime.ports.length === 0 &&
      !runtime.ready
    ) {
      return;
    }
    runtime.state = 'stopped';
    runtime.ready = false;
    runtime.readySince = undefined;
    runtime.pid = undefined;
    runtime.external = false;
    runtime.ports = [];
    runtime.startedAt = undefined;
    runtime.readinessDeadline = undefined;
    runtime.preflightIssues = undefined;
    runtime.conflictPort = undefined;
    runtime.conflictPid = undefined;
    runtime.conflictProcessName = undefined;
    this.emit(runtime);
  }

  /* ---------------- 状态 / 日志广播 ---------------- */

  private toStatus(r: Runtime): ProcessStatus {
    const status: ProcessStatus = {
      appId: r.appId,
      processId: r.processId,
      state: r.state,
      ports: r.ports,
      restartCount: r.restartCount,
    };
    if (r.pid !== undefined) status.pid = r.pid;
    if (r.external) status.external = true;
    if (r.startedAt !== undefined) status.startedAt = r.startedAt;
    if (r.exitCode !== null) status.exitCode = r.exitCode;
    if (r.signal !== null) status.signal = r.signal;
    if (r.errorHint) status.errorHint = r.errorHint;
    if (r.stderrTail) status.stderrTail = r.stderrTail;
    if (r.preflightIssues) status.preflightIssues = r.preflightIssues;
    if (r.autoRestartAttempts > 0) status.autoRestartAttempts = r.autoRestartAttempts;
    if (r.cpuPercent !== undefined) status.cpuPercent = r.cpuPercent;
    if (r.memoryMB !== undefined) status.memoryMB = r.memoryMB;
    if (r.serviceName) status.serviceName = r.serviceName;
    if (r.conflictPort !== undefined) status.conflictPort = r.conflictPort;
    if (r.conflictPid !== undefined) status.conflictPid = r.conflictPid;
    if (r.conflictProcessName) status.conflictProcessName = r.conflictProcessName;
    return status;
  }

  private emit(runtime: Runtime): void {
    const status = this.toStatus(runtime);
    const fingerprint = JSON.stringify(status);
    if (fingerprint === runtime.emitted) return;
    runtime.emitted = fingerprint;
    this.onStatus(status);
  }

  private emitAll(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.emitted = '';
      this.emit(runtime);
    }
  }

  private pushLog(runtime: Runtime, type: LogEntry['type'], content: string): void {
    if (!content) return;
    const entry: AppLogEntry = {
      appId: runtime.appId,
      processId: runtime.processId,
      processName: runtime.processName,
      timestamp: Date.now(),
      type,
      content,
    };
    this.onLog(entry);
    this.persistLog(entry);
  }

  private persistLog(entry: AppLogEntry): void {
    const settings = loadStore().settings;
    if (!settings.logPersistenceEnabled) return;
    try {
      const dir = path.join(app.getPath('userData'), 'logs', entry.appId);
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date(entry.timestamp).toISOString().slice(0, 10);
      let file = path.join(dir, `${day}.log`);
      if (fs.existsSync(file) && fs.statSync(file).size > settings.maxLogFileMB * 1024 * 1024) {
        let index = 1;
        while (fs.existsSync(path.join(dir, `${day}.${index}.log`))) index += 1;
        file = path.join(dir, `${day}.${index}.log`);
      }
      const line = `[${new Date(entry.timestamp).toLocaleTimeString()}] [${entry.type}] [${entry.processName}] ${entry.content.replace(/\s+$/, '')}\n`;
      fs.appendFileSync(file, line, 'utf-8');
    } catch {
      /* 落盘失败不影响运行 */
    }
  }
}
