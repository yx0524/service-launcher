import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScQuery } from '../src/parse.ts';

const RUNNING = `
SERVICE_NAME: DemoService
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : 25556
        FLAGS              :
`;

test('sc queryex：运行中能取到状态和 PID', () => {
  const parsed = parseScQuery(RUNNING);
  assert.deepEqual(parsed, { state: 4, pid: 25556 });
});

test('sc queryex：已停止时 PID 为 0', () => {
  const stopped = RUNNING.replace('STATE              : 4  RUNNING', 'STATE              : 1  STOPPED').replace(
    'PID                : 25556',
    'PID                : 0'
  );
  assert.deepEqual(parseScQuery(stopped), { state: 1, pid: 0 });
});

test('sc queryex：服务不存在（报错文本）返回 null', () => {
  const missing = '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\r\n\r\n指定的服务未安装。\r\n';
  assert.equal(parseScQuery(missing), null);
  assert.equal(parseScQuery(''), null);
});
