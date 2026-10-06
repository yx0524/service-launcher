import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyGroupOrder,
  commonDirPrefix,
  findPortConflicts,
  normalizeWindowState,
  replacePrefix,
} from '../src/configRules.ts';
import type { AppConfig, Group } from '../src/types.ts';

function app(overrides: Partial<AppConfig> & { id: string }): AppConfig {
  return {
    name: 'svc',
    groupId: 'default',
    workingDir: 'C:\\proj',
    processes: [{ id: 'main', name: 'main', command: 'node app.js' }],
    ...overrides,
  };
}

test('端口冲突：检出跨服务重复端口', () => {
  const existing = [
    app({ id: 'a', name: '后端', processes: [{ id: 'm', name: 'm', command: 'x', port: 8000 }] }),
  ];
  const candidate = app({ id: 'b', name: '另一个', processes: [{ id: 'm', name: 'm', command: 'y', port: 8000 }] });
  const conflicts = findPortConflicts(existing, candidate);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /8000/);
  assert.match(conflicts[0], /后端/);
});

test('端口冲突：改自己不算冲突，没端口不报', () => {
  const existing = [
    app({ id: 'a', name: '后端', processes: [{ id: 'm', name: 'm', command: 'x', port: 8000 }] }),
  ];
  const sameId = app({ id: 'a', name: '后端改名', processes: [{ id: 'm', name: 'm', command: 'x', port: 8000 }] });
  assert.deepEqual(findPortConflicts(existing, sameId), []);

  const noPort = app({ id: 'c', name: 'bot', processes: [{ id: 'm', name: 'm', command: 'node bot.js' }] });
  assert.deepEqual(findPortConflicts(existing, noPort), []);
});

test('路径替换：工作目录和命令行里的旧前缀一起换', () => {
  const apps = [
    app({
      id: 'a',
      workingDir: 'D:\\old-root\\project',
      processes: [
        {
          id: 'm',
          name: 'm',
          command: '"D:\\old-root\\venv\\python.exe" -m uvicorn app:app',
        },
      ],
    }),
    app({ id: 'b', name: '无关', workingDir: 'D:\\other' }),
  ];
  const { apps: next, changed } = replacePrefix(apps, 'D:\\old-root', 'D:\\new-root');
  assert.equal(changed, 1);
  assert.equal(next[0].workingDir, 'D:\\new-root\\project');
  assert.match(next[0].processes[0].command, /^"D:\\new-root\\venv\\python\.exe"/);
  assert.equal(next[1].workingDir, 'D:\\other', '不匹配的服务不动');
});

test('路径替换：空前缀直接返回原样', () => {
  const apps = [app({ id: 'a' })];
  const result = replacePrefix(apps, '   '.trim(), 'X');
  assert.equal(result.changed, 0);
  assert.equal(result.apps, apps);
});

test('公共目录前缀：多路径取共同部分', () => {
  assert.equal(
    commonDirPrefix(['E:\\a\\b\\c1', 'E:\\a\\b\\c2']),
    'E:\\a\\b'
  );
  assert.equal(commonDirPrefix(['E:\\a']), 'E:\\a');
  assert.equal(commonDirPrefix([]), '');
});

test('窗口状态：越界值收敛到合理范围，缺坐标则不给位置', () => {
  assert.deepEqual(normalizeWindowState({ width: 1180, height: 640 }), { width: 1180, height: 640 });
  assert.deepEqual(normalizeWindowState({ x: 10, y: 20, width: 900, height: 500, maximized: true }), {
    x: 10,
    y: 20,
    width: 900,
    height: 500,
    maximized: true,
  });
  const tiny = normalizeWindowState({ width: 10, height: 10 });
  assert.equal(tiny?.width, 600);
  assert.equal(tiny?.height, 400);
  assert.equal(normalizeWindowState({ width: 'abc', height: 5 }), undefined);
  assert.equal(normalizeWindowState(null), undefined);
});

const group = (id: string, name: string, order: number): Group => ({
  id,
  name,
  color: '#3b82f6',
  order,
});

test('分组排序：按给定顺序重排并刷新 order', () => {
  const groups = [group('a', 'A', 0), group('b', 'B', 1), group('c', 'C', 2)];
  const result = applyGroupOrder(groups, ['c', 'a', 'b']);
  assert.deepEqual(
    result.map((g) => g.id),
    ['c', 'a', 'b']
  );
  assert.deepEqual(
    result.map((g) => g.order),
    [0, 1, 2]
  );
  assert.equal(result[0].name, 'C', '分组内容不变，只换位置');
});

test('分组排序：漏掉的分组补在后面，不会丢', () => {
  const groups = [group('a', 'A', 0), group('b', 'B', 1), group('c', 'C', 2)];
  const result = applyGroupOrder(groups, ['b']);
  assert.deepEqual(
    result.map((g) => g.id),
    ['b', 'a', 'c']
  );
  assert.equal(result.length, 3);
});

test('分组排序：未知 id 被忽略', () => {
  const groups = [group('a', 'A', 0)];
  const result = applyGroupOrder(groups, ['zzz', 'a']);
  assert.deepEqual(
    result.map((g) => g.id),
    ['a']
  );
});
