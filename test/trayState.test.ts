import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeTray } from '../src/trayState.ts';
import type { ProcessStatus } from '../src/types.ts';

const status = (appId: string, state: ProcessStatus['state']): ProcessStatus => ({
  appId,
  processId: 'main',
  state,
  ports: [],
  restartCount: 0,
});

test('托盘：全正常时不报警', () => {
  const summary = summarizeTray([status('a', 'running'), status('b', 'running')]);
  assert.equal(summary.hasAlert, false);
  assert.equal(summary.runningCount, 2);
  assert.match(summary.tooltip, /运行中 2/);
});

test('托盘：启动中不算异常', () => {
  const summary = summarizeTray([status('a', 'starting')]);
  assert.equal(summary.hasAlert, false);
  assert.equal(summary.startingCount, 1);
});

test('托盘：同一应用多个进程报错只算一个异常', () => {
  const summary = summarizeTray([
    status('a', 'error'),
    { ...status('a', 'error'), processId: 'worker' },
    status('b', 'running'),
  ]);
  assert.equal(summary.alertCount, 1);
  assert.equal(summary.hasAlert, true);
  assert.equal(summary.restartLabel, '重启异常服务（1）');
});

test('托盘：空列表也不崩', () => {
  const summary = summarizeTray([]);
  assert.equal(summary.runningCount, 0);
  assert.equal(summary.hasAlert, false);
  assert.equal(summary.tooltip, '进程启动器 — 运行中 0');
});
