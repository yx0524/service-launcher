import { execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { parseListeners, parseScQuery } from './parse';

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
  /** 累计 CPU 时间（100ns）。 */
  cpuTime: number;
  /** 工作集字节数。 */
  workingSet: number;
}

function run(file: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err && !stdout ? '' : stdout || '')
    );
  });
}

/** netstat 输出（整个系统一次调用，约 30ms）。 */
export function getNetstat(): Promise<string> {
  if (process.platform !== 'win32') return Promise.resolve('');
  return run('netstat', ['-ano', '-p', 'TCP']);
}

/** PID -> 监听端口。 */
export async function getListeners(): Promise<Map<number, number[]>> {
  return parseListeners(await getNetstat());
}

let processCache: { at: number; data: ProcInfo[] } = { at: 0, data: [] };
let inFlight: Promise<ProcInfo[]> | null = null;

export interface ProcessTableSnapshot {
  data: ProcInfo[];
  /** 这份数据的采样时刻；算 CPU 百分比必须用它当分母，否则时间区间会错位。 */
  at: number;
}

/**
 * 全量进程表（含父进程和命令行）。
 * 用 PowerShell CIM 而不是 wmic —— wmic 在 Win11 24H2 起已被移除。
 * 结果缓存 4 秒，避免反复起进程。
 */
/**
 * 进程表缓存时长。
 * 起一次 PowerShell + CIM 大约 200ms，是启动器自身 CPU 的最大来源，
 * 所以默认缓存 30 秒：够快地认出手工启动的服务，又不会一直查。
 */
export function getProcessTable(maxAgeMs = 30000): Promise<ProcessTableSnapshot> {
  if (process.platform !== 'win32') return Promise.resolve({ data: [], at: Date.now() });
  const now = Date.now();
  if (processCache.data.length > 0 && now - processCache.at < maxAgeMs) {
    return Promise.resolve({ data: processCache.data, at: processCache.at });
  }
  if (inFlight) return inFlight.then((data) => ({ data, at: processCache.at || Date.now() }));

  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ' +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine,UserModeTime,KernelModeTime,WorkingSetSize | ' +
    'ConvertTo-Json -Compress';

  inFlight = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 20000)
    .then((stdout) => {
      const text = stdout.trim();
      if (!text) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return [];
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const data: ProcInfo[] = [];
      for (const row of rows as Array<Record<string, unknown>>) {
        const pid = Number(row.ProcessId);
        if (!Number.isInteger(pid)) continue;
        data.push({
          pid,
          ppid: Number(row.ParentProcessId) || 0,
          name: String(row.Name || ''),
          commandLine: String(row.CommandLine || ''),
          cpuTime: (Number(row.UserModeTime) || 0) + (Number(row.KernelModeTime) || 0),
          workingSet: Number(row.WorkingSetSize) || 0,
        });
      }
      processCache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程还在，只是没权限操作它
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * HTTP 就绪探测。
 * 2xx/3xx = 就绪；401/403 = 服务活着只是没权限，也算就绪；
 * 404/405 = 这个路径不存在（多半是别的程序占着端口，或 healthUrl 写错了）→ 不算就绪；
 * 5xx、超时、连不上 → 不算就绪。
 *
 * 用 http.request 而不是 fetch：Electron 主进程里的 fetch(undici) 对
 * Python http.server 这类 HTTP/1.0 直接断连的服务会报 "other side closed"。
 */
export function probeHttp(url: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(
      {
        method: 'GET',
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        timeout: timeoutMs,
        headers: { Connection: 'close' },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.resume(); // 丢掉响应体
        const ok = (status >= 200 && status < 400) || status === 401 || status === 403;
        finish(ok);
      }
    );
    request.on('timeout', () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => finish(false));
    request.end();
  });
}

/** 跑一个短命令并只要「成功/失败 + 输出」，用于启动前预检。 */
export function runFile(
  file: string,
  args: string[],
  cwd?: string,
  timeoutMs = 20000
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim();
        resolve({ ok: !error, output });
      }
    );
  });
}

export interface ServiceState {
  exists: boolean;
  running: boolean;
  pid: number;
}

/**
 * 查 Windows 服务的实时状态。
 * 用 sc.exe 而不是 PowerShell：它是原生命令，几十毫秒就返回，不吃 CPU。
 */
export async function queryServiceState(name: string): Promise<ServiceState> {
  if (process.platform !== 'win32' || !name) return { exists: false, running: false, pid: 0 };
  const output = await run('sc.exe', ['queryex', name], 8000);
  const parsed = parseScQuery(output);
  if (!parsed) return { exists: false, running: false, pid: 0 };
  return { exists: true, running: parsed.state === 4, pid: parsed.pid };
}

/** 启停 Windows 服务（非管理员可能被拒绝，调用方要把错误显示出来）。 */
export async function controlService(name: string, action: 'start' | 'stop'): Promise<{ ok: boolean; output: string }> {
  if (process.platform !== 'win32' || !name) return { ok: false, output: '非 Windows 平台' };
  return runFile('sc.exe', [action, name], undefined, 30000);
}

/** 强制结束整棵进程树。 */
export async function killTree(pid: number): Promise<void> {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], 10000);
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
}

/** 轮询等待进程真正消失。 */
export async function waitForExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return !isAlive(pid);
}

/**
 * 按父进程关系建一次索引。
 * 一轮里要给多个服务算进程树，索引只建一次就够，别每个服务重建一遍。
 */
export function buildChildrenMap(table: ProcInfo[]): Map<number, number[]> {
  const childrenOf = new Map<number, number[]>();
  for (const p of table) {
    const list = childrenOf.get(p.ppid);
    if (list) list.push(p.pid);
    else childrenOf.set(p.ppid, [p.pid]);
  }
  return childrenOf;
}

/** 用已建好的索引收集 pid 及其所有后代。 */
export function collectTreeWith(childrenOf: Map<number, number[]>, rootPid: number): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    for (const child of childrenOf.get(pid) || []) stack.push(child);
  }
  return result;
}

/** 便利版本：自己建索引（单次调用场景）。 */
export function collectTree(table: ProcInfo[], rootPid: number): number[] {
  return collectTreeWith(buildChildrenMap(table), rootPid);
}
