/**
 * 纯解析函数：不依赖 Electron / Node API，方便直接用 node --test 校验。
 */

/** 从 netstat -ano -p TCP 输出里解析出「PID -> 监听端口」。 */
export function parseListeners(netstatText: string): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const line of netstatText.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    const port = Number(m[2]);
    const pid = Number(m[3]);
    if (!Number.isInteger(port) || !Number.isInteger(pid) || pid <= 0) continue;
    const list = map.get(pid);
    if (list) {
      if (!list.includes(port)) list.push(port);
    } else {
      map.set(pid, [port]);
    }
  }
  for (const list of map.values()) list.sort((a, b) => a - b);
  return map;
}

/** 找出监听指定端口的 PID，没有则返回 0。 */
export function findPidOnPort(netstatText: string, port: number): number {
  const needle = ':' + String(port);
  for (const line of netstatText.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    // 端口后面必须是空白，避免 8000 匹配到 80001
    if (!new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s').test(line)) continue;
    const m = line.match(/(\d+)\s*$/);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** 从命令行里猜监听端口，用于没显式配置 port 的进程。 */
export function inferPort(command: string): number | undefined {
  const patterns = [
    /--port[=\s]+(\d{2,5})(?:\s|$)/i,
    /(?:^|\s)-p\s+(\d{2,5})(?:\s|$)/,
    /(?:^|\s)(?:PORT|SERVER_PORT|APP_PORT)=(\d{2,5})(?:\s|$)/,
    /(?:^|\s)(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(?:\s|$)/,
    /-b\s+\S*?:(\d{2,5})(?:\s|$)/,
  ];
  for (const re of patterns) {
    const m = command.match(re);
    if (!m) continue;
    const port = Number(m[1]);
    if (port > 0 && port <= 65535) return port;
  }
  return undefined;
}

/** 命令行关键字匹配：要求词首边界，避免 bot.js 误配 photobot.js。 */
export function matchCommandLine(commandLine: string, keyword: string): boolean {
  if (!commandLine || !keyword) return false;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s"'/\\\\])${escaped}`, 'i').test(commandLine);
}

/** 把 stderr 尾巴翻译成一句人话。 */
export function summarizeError(stderrTail: string, exitCode: number | null): string {
  const tail = (stderrTail || '').trim();
  if (!tail) {
    return exitCode && exitCode !== 0 ? `退出码 ${exitCode}` : '未知错误';
  }
  if (/EADDRINUSE|address already in use/i.test(tail)) return '端口被占用（EADDRINUSE）';
  if (/_PySemaphore_Wakeup|ReleaseSemaphore failed/i.test(tail)) {
    return 'Python 线程/文件监听异常（可能是 watchdog 退出时被强杀）';
  }
  if (/Failed joining thread|failed detaching thread/i.test(tail)) {
    return '线程停止异常（watchdog 线程未正常退出）';
  }
  if (/ModuleNotFoundError|ImportError/i.test(tail)) return 'Python 模块缺失';
  if (/Traceback/i.test(tail)) return 'Python 运行异常（Traceback）';
  if (/is not recognized|command not found/i.test(tail)) return '命令不存在或未安装';
  if (/ENOENT/i.test(tail)) return '目录或命令不存在';

  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] || '未知错误').slice(0, 200);
}

/** 从 stderr 里抓端口冲突信息。 */
export function parsePortConflict(text: string): number | undefined {
  const patterns = [
    /EADDRINUSE[\s\S]{0,200}?(?:\[?::\]?|\b\d+\.\d+\.\d+\.\d+):(\d{2,5})/i,
    /address already in use[\s\S]{0,200}?(?:\[?::\]?|\b\d+\.\d+\.\d+\.\d+):(\d{2,5})/i,
    /端口\D{0,10}(\d{2,5})\D{0,10}占用/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const port = Number(m[1]);
      if (port > 0 && port <= 65535) return port;
    }
  }
  return undefined;
}

/**
 * 解析 `sc queryex <服务名>` 的输出。
 * 中文系统上 sc.exe 的字段名和状态值仍是英文，所以按固定格式取数字即可，
 * 不依赖任何本地化文本。STATE: 4 = RUNNING，1 = STOPPED。
 */
export function parseScQuery(text: string): { state: number; pid: number } | null {
  if (!text) return null;
  const state = text.match(/STATE\s*:\s*(\d+)/i);
  if (!state) return null;
  const pid = text.match(/PID\s*:\s*(\d+)/i);
  return { state: Number(state[1]), pid: pid ? Number(pid[1]) : 0 };
}
