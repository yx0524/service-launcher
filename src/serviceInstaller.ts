import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppConfig, ProcessConfig } from './types';
import { buildServiceXml, serviceIdForApp, splitCommand } from './serviceBuilder';
import { queryServiceState, runFile } from './probe';
import { expandEnvVars } from './preflight';

export interface ServiceOpResult {
  success: boolean;
  serviceId?: string;
  error?: string;
}

/**
 * 服务包装文件放在机器级目录（C:\ProgramData）。
 * 不放在 %APPDATA%：那是用户目录，系统账户（服务是以 LocalSystem 跑的）
 * 访问起来容易踩坑，而且用户目录的权限继承不干净。
 */
function servicesRoot(): string {
  const base = process.env.ProgramData || 'C:\\ProgramData';
  return path.join(base, 'ProcessLauncher', 'services');
}

export function isWinSwAvailable(assetsDir: string): boolean {
  return fs.existsSync(path.join(assetsDir, 'winsw', 'WinSW.exe'));
}

/**
 * 把命令里的可执行文件解析成绝对 .exe 路径。
 * 只认 .exe：`where npm` 会先返回没有扩展名的 Unix 脚本 `npm`，再返回 `npm.cmd`，
 * 取错第一行就会「无法启动服务」；而 .cmd/.bat 本身也不能被 CreateProcess 直接当可执行文件，
 * 这两种情况一律回退到 cmd.exe /c。
 */
async function resolveExecutable(token: string, workingDir: string): Promise<string> {
  if (!token) return '';
  const expanded = expandEnvVars(token, process.env);
  if (/[\\/]/.test(expanded)) {
    const absolute = path.isAbsolute(expanded) ? expanded : path.join(workingDir, expanded);
    if (!fs.existsSync(absolute)) return '';
    return /\.exe$/i.test(absolute) ? absolute : '';
  }
  const found = await runFile('where.exe', [expanded], workingDir, 8000);
  const lines = found.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((line) => /\.exe$/i.test(line)) ?? '';
}

/** 写一个自提权的 PowerShell 脚本：非管理员时自己弹 UAC 重新跑自己。 */
function writeSelfElevatingScript(payloadLines: string[]): string {
  const dir = path.join(app.getPath('temp'), `launcher-svc-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run.ps1');
  const script = [
    '$ErrorActionPreference = \'Continue\'',
    'if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
    "  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', $PSCommandPath)",
    '  exit $p.ExitCode',
    '}',
    ...payloadLines,
    'exit 0',
  ].join('\r\n');
  // 必须带 BOM：否则中文系统上 PowerShell 5.1 会按 GBK 读，把路径读坏
  fs.writeFileSync(file, `\uFEFF${script}`, 'utf8');
  return file;
}

async function runScript(scriptPath: string, timeoutMs = 120000): Promise<void> {
  await runFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], undefined, timeoutMs);
}

/**
 * 把一个服务注册成 Windows 服务。
 * 调用方需要先把正在运行的实例停掉（否则会和服务的实例抢单实例锁）。
 */
export async function installService(
  appConfig: AppConfig,
  proc: ProcessConfig,
  assetsDir: string
): Promise<ServiceOpResult> {
  const winsw = path.join(assetsDir, 'winsw', 'WinSW.exe');
  if (!fs.existsSync(winsw)) return { success: false, error: '启动器自带的 WinSW 缺失，无法注册服务' };
  if (!fs.existsSync(appConfig.workingDir)) return { success: false, error: `工作目录不存在：${appConfig.workingDir}` };

  const serviceId = proc.service?.trim() || serviceIdForApp(appConfig.id);
  const dir = path.join(servicesRoot(), serviceId);
  fs.mkdirSync(dir, { recursive: true });

  const { executable, args } = splitCommand(proc.command);
  const resolved = await resolveExecutable(executable, appConfig.workingDir);
  const useShell = !resolved;
  const xmlPath = path.join(dir, `${serviceId}.xml`);
  const xml = buildServiceXml({
    serviceId,
    displayName: appConfig.name,
    description: appConfig.description || `由「进程启动器」托管的服务（${appConfig.name}）`,
    executable: useShell ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : resolved,
    args: useShell ? `/c ${proc.command}` : args,
    workingDirectory: appConfig.workingDir,
    logDirectory: path.join(dir, 'logs'),
  });
  fs.writeFileSync(xmlPath, xml, 'utf8');

  // WinSW 本体也从资源里复制出来：打包后它在 app.asar 内部，
  // 而提权脚本是 PowerShell，读不到 asar，所以这一步必须在 Electron 里做。
  const exePath = path.join(dir, `${serviceId}.exe`);
  fs.writeFileSync(exePath, fs.readFileSync(winsw));

  const scriptPath = writeSelfElevatingScript([
    `$dir = '${dir.replace(/'/g, "''")}'`,
    `$exe = Join-Path $dir '${serviceId}.exe'`,
    '& $exe stop 2>&1 | Out-Null',
    '& $exe uninstall 2>&1 | Out-Null',
    'Start-Sleep -Milliseconds 800',
    '& $exe install 2>&1 | Out-Null',
    '& $exe start 2>&1 | Out-Null',
  ]);

  try {
    await runScript(scriptPath);
  } finally {
    try {
      fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // 以实际服务状态为准
  const deadline = Date.now() + 20000;
  let state = await queryServiceState(serviceId);
  while (!state.running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    state = await queryServiceState(serviceId);
  }
  if (!state.exists) return { success: false, error: '安装没成功（可能拒绝了管理员授权）', serviceId };
  if (!state.running) return { success: false, error: '服务已注册但没有起来，看服务目录里的 logs', serviceId };
  return { success: true, serviceId };
}

/** 取消服务托管：停掉并注销服务，程序文件和日志保留。 */
export async function uninstallService(serviceId: string): Promise<ServiceOpResult> {
  if (!serviceId.trim()) return { success: false, error: '没有记录到这个服务对应的 Windows 服务名' };
  const dir = path.join(servicesRoot(), serviceId);
  const exePath = path.join(dir, `${serviceId}.exe`);
  if (!fs.existsSync(exePath)) {
    // 没有启动器生成的包装器，直接让系统删
    const scriptPath = writeSelfElevatingScript([`& sc.exe delete '${serviceId.replace(/'/g, "''")}' 2>&1 | Out-Null`]);
    try {
      await runScript(scriptPath, 60000);
    } finally {
      try {
        fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } else {
    const scriptPath = writeSelfElevatingScript([
      `$exe = '${exePath.replace(/'/g, "''")}'`,
      '& $exe stop 2>&1 | Out-Null',
      'Start-Sleep -Milliseconds 500',
      '& $exe uninstall 2>&1 | Out-Null',
    ]);
    try {
      await runScript(scriptPath, 60000);
    } finally {
      try {
        fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const state = await queryServiceState(serviceId);
  if (state.exists) return { success: false, error: '服务还在，可能拒绝了管理员授权', serviceId };
  return { success: true, serviceId };
}

/** 打开某个服务的日志目录（方便排查为什么起不来）。 */
export function serviceLogDir(serviceId: string): string {
  return path.join(servicesRoot(), serviceId, 'logs');
}
