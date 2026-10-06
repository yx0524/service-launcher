import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeOutput,
  findPidOnPort,
  isAccessDenied,
  inferPort,
  matchCommandLine,
  parseListeners,
  parsePortConflict,
  summarizeError,
} from '../src/parse.ts';

const SAMPLE = [
  '  TCP    0.0.0.0:8000           0.0.0.0:0              LISTENING       4321',
  '  TCP    0.0.0.0:80001          0.0.0.0:0              LISTENING       9999',
  '  TCP    127.0.0.1:8000         127.0.0.1:52000        ESTABLISHED     777',
  '  TCP    [::]:5173              [::]:0                 LISTENING       2468',
  '  UDP    0.0.0.0:500             *:*                                    1111',
].join('\r\n');

test('parseListeners 只认 LISTENING，IPv6 与 IPv4 都能解析', () => {
  const map = parseListeners(SAMPLE);
  assert.deepEqual(map.get(4321), [8000]);
  assert.deepEqual(map.get(9999), [80001]);
  assert.deepEqual(map.get(2468), [5173]);
  assert.equal(map.get(777), undefined, 'ESTABLISHED 不算监听');
  assert.equal(map.get(1111), undefined, 'UDP 行不算 TCP 监听');
});

test('findPidOnPort 不会把 8000 匹配成 80001', () => {
  assert.equal(findPidOnPort(SAMPLE, 8000), 4321);
  assert.equal(findPidOnPort(SAMPLE, 80001), 9999);
  assert.equal(findPidOnPort(SAMPLE, 8888), 0);
});

test('inferPort 从常见命令行里猜端口', () => {
  assert.equal(inferPort('python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload'), 8000);
  assert.equal(inferPort('npm run dev -- --port 5173'), 5173);
  assert.equal(inferPort('set PORT=3000 && node server.js'), 3000);
  assert.equal(inferPort('node bot.js'), undefined);
});

test('matchCommandLine 要求词首边界', () => {
  assert.equal(matchCommandLine('node  bot.js', 'bot.js'), true);
  assert.equal(matchCommandLine('cmd.exe /c node bot.js', 'bot.js'), true);
  assert.equal(matchCommandLine('node C:\\x\\photobot.js', 'bot.js'), false);
  assert.equal(matchCommandLine('node C:\\x\\photobot.js', 'photobot.js'), true);
  assert.equal(matchCommandLine('', 'bot.js'), false);
});

test('parsePortConflict 抓 EADDRINUSE 端口', () => {
  const text = "Error: listen EADDRINUSE: address already in use 0.0.0.0:8000";
  assert.equal(parsePortConflict(text), 8000);
  assert.equal(parsePortConflict('一切正常'), undefined);
});

test('summarizeError 给出人话提示', () => {
  assert.match(summarizeError('Traceback (most recent call last): ...', 1), /Traceback/);
  assert.equal(summarizeError('', 3), '退出码 3');
  assert.equal(summarizeError('', 0), '未知错误');
});

test('isAccessDenied 认得中英文两种「权限不足」', () => {
  assert.equal(isAccessDenied('[SC] StartService: OpenService 失败 5: 拒绝访问。'), true);
  assert.equal(isAccessDenied('[SC] StartService: OpenService FAILED 5:\r\n\r\nAccess is denied.'), true);
  assert.equal(isAccessDenied('指定的服务未安装。'), false);
  assert.equal(isAccessDenied(''), false);
});

test('decodeOutput 把 sc.exe 的 GBK 输出还原成中文（旧行为是一圈乱码）', () => {
  // 「失败 5: 拒绝访问。」按 GBK 编码 —— sc.exe 在中文系统上就是这么输出的
  const gbk = Buffer.from([0xca, 0xa7, 0xb0, 0xdc, 0x20, 0x35, 0x3a, 0x20, 0xbe, 0xdc, 0xbe, 0xf8, 0xb7, 0xc3, 0xce, 0xca, 0xa1, 0xa3]);
  assert.equal(decodeOutput(gbk), '失败 5: 拒绝访问。');
  // 纯 ASCII / 已经是 UTF-8 的内容不乱动
  assert.equal(decodeOutput(Buffer.from('FAILED 1060', 'utf8')), 'FAILED 1060');
  assert.equal(decodeOutput(Buffer.from('中文 UTF-8 输出', 'utf8')), '中文 UTF-8 输出');
});
