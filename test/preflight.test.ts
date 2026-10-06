import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePreflight,
  expandEnvVars,
  firstToken,
  looksLikePath,
  parseModuleList,
  type PreflightContext,
} from '../src/preflight.ts';
import type { ProcessConfig } from '../src/types.ts';

const ENV = { USERPROFILE: 'C:\\Users\\tester' };

function ctx(overrides: Partial<PreflightContext> = {}): PreflightContext {
  return {
    workingDir: 'C:\\proj',
    dirExists: true,
    exists: () => true,
    hasPackageJson: false,
    hasNodeModules: false,
    env: ENV,
    ...overrides,
  };
}

const proc = (overrides: Partial<ProcessConfig> = {}): ProcessConfig => ({
  id: 'main',
  name: 'Main',
  command: 'python app.py',
  ...overrides,
});

test('expandEnvVars 展开 %VAR%', () => {
  assert.equal(expandEnvVars('%USERPROFILE%\\x.exe', ENV), 'C:\\Users\\tester\\x.exe');
  assert.equal(expandEnvVars('没有变量', ENV), '没有变量');
  assert.equal(expandEnvVars('%NOT_SET%\\x', ENV), '%NOT_SET%\\x', '未知变量原样保留');
});

test('firstToken 支持引号包裹的路径', () => {
  assert.equal(firstToken('"C:\\a b\\python.exe" -m uvicorn'), 'C:\\a b\\python.exe');
  assert.equal(firstToken('node bot.js'), 'node');
  assert.equal(firstToken('   '), '');
});

test('looksLikePath 区分路径与命令名', () => {
  assert.equal(looksLikePath('C:\\x\\python.exe'), true);
  assert.equal(looksLikePath('%USERPROFILE%\\python.exe'), true);
  assert.equal(looksLikePath('node_modules\\vite\\bin\\vite.js'), true);
  assert.equal(looksLikePath('run.py'), true);
  assert.equal(looksLikePath('python'), false);
  assert.equal(looksLikePath('npm'), false);
});

test('parseModuleList 拆分隔符并去重', () => {
  assert.deepEqual(parseModuleList('fastapi, uvicorn;sqlalchemy'), ['fastapi', 'uvicorn', 'sqlalchemy']);
  assert.deepEqual(parseModuleList(['fastapi', 'uvicorn fastapi']), ['fastapi', 'uvicorn']);
  assert.deepEqual(parseModuleList(undefined), []);
});

test('预检：工作目录不存在', () => {
  const issues = evaluatePreflight(proc(), ctx({ dirExists: false }));
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /工作目录不存在/);
});

test('预检：可执行文件找不到', () => {
  const issues = evaluatePreflight(
    proc({ command: '"%USERPROFILE%\\envs\\py\\python.exe" -m uvicorn' }),
    ctx({ exists: () => false })
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /找不到可执行文件/);
  assert.match(issues[0].message, /Users\\tester/, '%USERPROFILE% 应被展开');
});

test('预检：PATH 里的命令名不做存在性检查', () => {
  const issues = evaluatePreflight(proc({ command: 'npm run dev' }), ctx({ exists: () => false }));
  assert.equal(issues.length, 0);
});

test('预检：有 package.json 但没 node_modules', () => {
  const issues = evaluatePreflight(
    proc({ command: 'npm run dev' }),
    ctx({ hasPackageJson: true, hasNodeModules: false })
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /依赖未安装/);
  assert.match(issues[0].fix ?? '', /npm install/);
});

test('预检：普通 node 脚本不会被误判缺依赖', () => {
  const issues = evaluatePreflight(
    proc({ command: 'node bot.js' }),
    ctx({ hasPackageJson: true, hasNodeModules: false })
  );
  assert.equal(issues.length, 0, '没提到 node_modules/npm 就不检查');
});

test('预检：preflightFiles 缺文件', () => {
  const issues = evaluatePreflight(
    proc({ preflightFiles: ['data', 'config.json'] }),
    ctx({ exists: (target) => target.endsWith('data') })
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /config\.json/);
});

test('预检：一切正常则无问题', () => {
  const issues = evaluatePreflight(
    proc({ command: 'npm run dev', preflightFiles: ['package.json'] }),
    ctx({ hasPackageJson: true, hasNodeModules: true })
  );
  assert.deepEqual(issues, []);
});
