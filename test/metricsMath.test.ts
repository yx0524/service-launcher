import assert from 'node:assert/strict';
import test from 'node:test';
import { bucketize, type MetricPoint } from '../src/metricsMath.ts';

const point = (t: number, mem: number, cpu = 0): MetricPoint => ({ t, cpu, mem });

test('降采样：窗口外的点被丢掉', () => {
  const points = [point(0, 100), point(500, 200), point(5000, 300)];
  const result = bucketize(points, 1000, 2000, 10);
  assert.deepEqual(result, [], '窗口 1000~2000 内没有点');
});

test('降采样：桶内取平均，桶数受限', () => {
  const points: MetricPoint[] = [];
  for (let i = 0; i < 100; i++) points.push(point(1000 + i * 10, 100 + i, 10));
  const result = bucketize(points, 1000, 2000, 10);
  assert.ok(result.length <= 10, `桶数应 <=10，实际 ${result.length}`);
  assert.ok(result.length >= 9, '大部分桶应有数据');
  // 每个三元组是 [时间, 内存, CPU]
  for (const [t, mem, cpu] of result) {
    assert.ok(t >= 1000 && t <= 2000, '时间落在窗口内');
    assert.ok(mem >= 100 && mem <= 199);
    assert.equal(cpu, 10);
  }
});

test('降采样：只有一个点时也能出图（单桶）', () => {
  const result = bucketize([point(1500, 250)], 1000, 2000, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0][1], 250);
});

test('降采样：空输入与非法参数不炸', () => {
  assert.deepEqual(bucketize([], 0, 1000, 10), []);
  assert.deepEqual(bucketize([point(500, 1)], 1000, 1000, 10), []);
  assert.deepEqual(bucketize([point(500, 1)], 1000, 2000, 0), []);
});

test('降采样：超大窗口也不会返回超过桶数的点', () => {
  const points: MetricPoint[] = [];
  for (let i = 0; i < 5000; i++) points.push(point(i * 1000, 50 + (i % 40)));
  const result = bucketize(points, 0, 5000 * 1000, 60);
  assert.ok(result.length <= 60, `实际 ${result.length}`);
  assert.ok(result.length > 50, '长窗口也应该铺满');
});
