import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { bucketize, type MetricPoint } from './metricsMath';
import { noteWriteFailure } from './logFiles';

export type { MetricPoint } from './metricsMath';

export interface MetricSample {
  key: string;
  cpu: number;
  mem: number;
}

/** 每个采样点一条记录，按天分文件，方便追加和过期清理。 */
interface MetricLine {
  t: number;
  items: MetricSample[];
}

function metricsDir(): string {
  return path.join(app.getPath('userData'), 'metrics');
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

/** 追加一批采样（每个采样周期调用一次）。 */
export function appendMetrics(samples: MetricSample[]): void {
  const useful = samples.filter((s) => Number.isFinite(s.mem));
  if (useful.length === 0) return;
  try {
    const dir = metricsDir();
    fs.mkdirSync(dir, { recursive: true });
    const line: MetricLine = { t: Date.now(), items: useful };
    fs.appendFileSync(path.join(dir, `${dayKey(new Date())}.jsonl`), `${JSON.stringify(line)}\n`, 'utf-8');
  } catch (error) {
    // 采样落盘失败不影响主流程，但必须留下证据，否则只能看到曲线不动了
    noteWriteFailure(metricsDir(), 'metrics', error);
  }
}

/** 清理超期的指标文件，返回删除数量。 */
export function pruneMetrics(retentionDays: number): number {
  const dir = metricsDir();
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 3600 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full);
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export interface MetricsSeries {
  /** 起止时间（毫秒），前端用来画坐标。 */
  from: number;
  to: number;
  /** key（appId::processId）-> [[时间, 内存MB, CPU%], ...] */
  series: Record<string, Array<[number, number, number]>>;
}

/** 读取最近 hours 小时的指标并按最多 buckets 个点降采样。 */
export function readMetrics(hours: number, buckets = 120): MetricsSeries {
  const to = Date.now();
  const from = to - Math.max(1, hours) * 3600 * 1000;
  const dir = metricsDir();
  const collected = new Map<string, MetricPoint[]>();

  if (fs.existsSync(dir)) {
    // 只读窗口覆盖到的日期文件（多读一天防止跨天漏点）
    const first = dayKey(new Date(from - 24 * 3600 * 1000));
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      if (name.replace('.jsonl', '') < first) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf-8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed: MetricLine;
        try {
          parsed = JSON.parse(line) as MetricLine;
        } catch {
          continue;
        }
        if (!parsed.t || parsed.t < from || parsed.t > to) continue;
        for (const item of parsed.items ?? []) {
          const list = collected.get(item.key);
          const point: MetricPoint = { t: parsed.t, cpu: item.cpu, mem: item.mem };
          if (list) list.push(point);
          else collected.set(item.key, [point]);
        }
      }
    }
  }

  const series: MetricsSeries['series'] = {};
  for (const [key, points] of collected) {
    points.sort((a, b) => a.t - b.t);
    series[key] = bucketize(points, from, to, buckets);
  }
  return { from, to, series };
}
