/** 渲染层共用的小格式化工具。 */

/** 运行时长：从 startedAt 到现在的可读文本。 */
export function formatUptime(startedAt: number | undefined, now = Date.now()): string {
  if (!startedAt) return '—';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${secs}秒`;
  return `${secs}秒`;
}

/** 内存：MB 数字转可读文本。 */
export function formatMemory(mb: number | undefined): string {
  if (mb === undefined) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export function formatCpu(percent: number | undefined): string {
  return percent === undefined ? '—' : `${percent}%`;
}
