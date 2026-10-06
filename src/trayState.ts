import type { ProcessStatus } from './types';

export interface TraySummary {
  runningCount: number;
  startingCount: number;
  alertCount: number;
  tooltip: string;
  statusLine: string;
  restartLabel: string;
  hasAlert: boolean;
}

/**
 * 托盘上要显示什么：纯函数，方便单测。
 * alertCount 只统计「错误」——启动中不算异常，避免刚点启动就变红。
 */
export function summarizeTray(statuses: ProcessStatus[]): TraySummary {
  let runningCount = 0;
  let startingCount = 0;
  const failedApps = new Set<string>();

  for (const status of statuses) {
    if (status.state === 'running') runningCount += 1;
    else if (status.state === 'starting') startingCount += 1;
    else if (status.state === 'error') failedApps.add(status.appId);
  }

  const alertCount = failedApps.size;
  const parts = [`运行中 ${runningCount}`];
  if (startingCount > 0) parts.push(`启动中 ${startingCount}`);
  if (alertCount > 0) parts.push(`异常 ${alertCount}`);

  return {
    runningCount,
    startingCount,
    alertCount,
    hasAlert: alertCount > 0,
    tooltip: `进程启动器 — ${parts.join(' · ')}`,
    statusLine: parts.join('  ·  '),
    restartLabel: alertCount > 0 ? `重启异常服务（${alertCount}）` : '重启异常服务',
  };
}
