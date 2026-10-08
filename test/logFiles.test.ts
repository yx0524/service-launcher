import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { noteWriteFailure, parseLogText, readLogTail } from '../src/logFiles.ts';

const SAMPLE = [
  '[23:35:14] [system] [cc-connect.exe] 已启动（PID 37996）',
  '[23:35:14] [stderr] [cc-connect.exe] Error: another cc-connect instance is already running',
  'Use --force to kill the existing instance.',
  '[23:35:15] [stdout] [cc-connect.exe] time=2026-10-06 level=INFO msg="platform ready"',
  '',
].join('\n');

test('parseLogText：按行解析类型/进程名/内容，认不出的行算上一行的续行', () => {
  const entries = parseLogText(SAMPLE, 'cc-connect', new Date(2026, 9, 6));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].type, 'system');
  assert.equal(entries[0].processName, 'cc-connect.exe');
  assert.equal(entries[0].content, '已启动（PID 37996）');
  assert.equal(entries[0].timestamp, new Date(2026, 9, 6, 23, 35, 14).getTime());
  // 多行报错要并成一条，不然 traceback 会被拆碎
  assert.equal(entries[1].type, 'stderr');
  assert.match(entries[1].content, /already running\nUse --force/);
  assert.equal(entries[2].type, 'stdout');
});

test('readLogTail：读文件尾部，按文件名定日期', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logtail-'));
  const file = path.join(dir, '2026-10-07.log');
  fs.writeFileSync(file, SAMPLE, 'utf-8');
  const entries = readLogTail(file, 'cc-connect');
  assert.equal(entries.length, 3);
  assert.equal(new Date(entries[0].timestamp).getDate(), 7, '日期应取自文件名 2026-10-07');
  // 只取尾部 N 行
  assert.equal(readLogTail(file, 'cc-connect', 2).length, 1);
  // 文件不存在不炸
  assert.deepEqual(readLogTail(path.join(dir, 'nope.log'), 'x'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('noteWriteFailure：失败要留证据，写不进去也不能抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'werr-'));
  noteWriteFailure(dir, 'metrics', new Error('EPERM: operation not permitted'));
  const text = fs.readFileSync(path.join(dir, 'write-errors.log'), 'utf-8');
  assert.match(text, /metrics: EPERM: operation not permitted/);
  // 目录本身不可用时只记录、不抛异常
  assert.doesNotThrow(() => noteWriteFailure('', 'log', new Error('x')));
  fs.rmSync(dir, { recursive: true, force: true });
});
