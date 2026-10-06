/**
 * 生成 WinSW 服务配置。纯函数，方便单测；
 * 只使用 WinSW 2.x 官方文档里列出的元素（写错会导致安装直接失败）。
 */

export interface ServiceSpec {
  /** 服务名（Windows 服务 ID，建议 ASCII）。 */
  serviceId: string;
  /** 显示名，可以中文。 */
  displayName: string;
  description: string;
  /** 可执行文件（绝对路径）。 */
  executable: string;
  /** 命令行参数，整串。 */
  args: string;
  /** 工作目录。 */
  workingDirectory: string;
  /** WinSW 日志目录。 */
  logDirectory: string;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 服务名清洗：Windows 服务名允许字母数字和 _-.，其余换成下划线。 */
export function sanitizeServiceId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/_{2,}/g, '_');
  return cleaned.replace(/^[_.-]+/, '').slice(0, 60) || 'LauncherService';
}

/** 由应用生成一个稳定的服务名。 */
export function serviceIdForApp(appId: string): string {
  return `LauncherSvc-${sanitizeServiceId(appId)}`;
}

/**
 * 把一条命令行拆成「可执行文件 + 参数」。
 * 只做单层拆分：第一个 token 如果是带引号的路径，去掉引号后作为可执行文件。
 */
export function splitCommand(command: string): { executable: string; args: string } {
  const trimmed = command.trim();
  if (!trimmed) return { executable: '', args: '' };
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) {
      return { executable: trimmed.slice(1, end), args: trimmed.slice(end + 1).trim() };
    }
  }
  const spaceIndex = trimmed.search(/\s/);
  if (spaceIndex < 0) return { executable: trimmed, args: '' };
  return { executable: trimmed.slice(0, spaceIndex), args: trimmed.slice(spaceIndex + 1).trim() };
}

/** 生成 WinSW 的 XML 配置。 */
export function buildServiceXml(spec: ServiceSpec): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- 由「进程启动器」自动生成；在启动器里重新注册会覆盖本文件 -->
<service>
  <id>${escapeXml(spec.serviceId)}</id>
  <name>${escapeXml(spec.displayName)}</name>
  <description>${escapeXml(spec.description)}</description>

  <executable>${escapeXml(spec.executable)}</executable>
  <arguments>${escapeXml(spec.args)}</arguments>
  <workingdirectory>${escapeXml(spec.workingDirectory)}</workingdirectory>

  <startmode>Automatic</startmode>

  <!-- 崩了自动重启：10s → 30s → 60s；稳定运行 1 小时后重新计数 -->
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>

  <stoptimeout>15 sec</stoptimeout>

  <logpath>${escapeXml(spec.logDirectory)}</logpath>
  <log mode="roll"></log>
</service>
`;
}
