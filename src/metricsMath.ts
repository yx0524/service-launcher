/** 指标降采样：纯函数，方便单测。 */

export interface MetricPoint {
  t: number;
  cpu: number;
  mem: number;
}

/**
 * 把一串采样点压成固定数量的桶（每桶取平均），用于画长周期曲线。
 * 返回 [时间戳, 内存MB, CPU%] 三元组，时间戳取桶中心。
 */
export function bucketize(
  points: MetricPoint[],
  from: number,
  to: number,
  buckets: number
): Array<[number, number, number]> {
  if (points.length === 0 || buckets <= 0 || to <= from) return [];
  const span = (to - from) / buckets;
  const sums = new Array<{ t: number; mem: number; cpu: number; count: number } | undefined>(buckets);

  for (const point of points) {
    if (point.t < from || point.t > to) continue;
    let index = Math.floor((point.t - from) / span);
    if (index < 0) index = 0;
    if (index >= buckets) index = buckets - 1;
    const bucket = sums[index];
    if (bucket) {
      bucket.mem += point.mem;
      bucket.cpu += point.cpu;
      bucket.count += 1;
    } else {
      sums[index] = { t: from + span * (index + 0.5), mem: point.mem, cpu: point.cpu, count: 1 };
    }
  }

  const result: Array<[number, number, number]> = [];
  for (const bucket of sums) {
    if (!bucket) continue;
    result.push([
      Math.round(bucket.t),
      Math.round(bucket.mem / bucket.count),
      Math.round((bucket.cpu / bucket.count) * 10) / 10,
    ]);
  }
  return result;
}
