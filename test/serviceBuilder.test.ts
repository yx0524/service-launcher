import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildServiceXml,
  commandFromScript,
  sanitizeServiceId,
  serviceIdForApp,
  splitCommand,
} from '../src/serviceBuilder.ts';

test('拆分命令行：带引号的路径', () => {
  assert.deepEqual(splitCommand('"C:\\Program Files\\nodejs\\node.exe" bot.js'), {
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    args: 'bot.js',
  });
  assert.deepEqual(splitCommand('node bot.js --flag'), { executable: 'node', args: 'bot.js --flag' });
  assert.deepEqual(splitCommand('node'), { executable: 'node', args: '' });
  assert.deepEqual(splitCommand('   '), { executable: '', args: '' });
});

test('服务名清洗：只留合法字符', () => {
  assert.equal(sanitizeServiceId('file upload!'), 'file_upload_');
  assert.equal(sanitizeServiceId('...abc'), 'abc');
  assert.equal(sanitizeServiceId('文件上传'), 'LauncherService', '全是非法字符时给个兜底名');
  assert.equal(serviceIdForApp('contacts-bot'), 'LauncherSvc-contacts-bot');
});

test('生成的 XML 只包含 WinSW 2.x 认识元素，且转义正确', () => {
  const xml = buildServiceXml({
    serviceId: 'LauncherSvc-demo',
    displayName: '演示 & 测试',
    description: 'a < b',
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    args: 'app.js --name "a b"',
    workingDirectory: 'E:\\demo',
    logDirectory: 'C:\\logs\\demo',
  });

  // 必须有的元素
  for (const tag of ['<id>', '<name>', '<description>', '<executable>', '<arguments>', '<workingdirectory>', '<startmode>', '<onfailure', '<resetfailure>', '<stoptimeout>', '<logpath>', '<log mode="roll">']) {
    assert.ok(xml.includes(tag), `缺少 ${tag}`);
  }
  // WinSW 2.x 不认识的旧写法不能出现，否则安装会失败
  for (const bad of ['roll-by-size', 'sizeThreshold', 'keepFiles', 'stopparentprocessfirst', 'delayedAutoStart']) {
    assert.ok(!xml.includes(bad), `不该出现 ${bad}`);
  }
  assert.ok(xml.includes('演示 &amp; 测试'), '& 要转义');
  assert.ok(xml.includes('a &lt; b'), '< 要转义');
  assert.ok(xml.includes('<startmode>Automatic</startmode>'));
});

test('从脚本文件拼启动命令：按扩展名走对应解释器，目录内用相对路径', () => {
  const dir = 'E:\\00000.工艺\\工艺\\小工具\\端口占用管理工具';
  // 工作目录里的 bat 直接跑（cmd 会执行它）
  assert.equal(
    commandFromScript(`${dir}\\启动端口占用管理工具.bat`, dir),
    '"启动端口占用管理工具.bat"'
  );
  assert.equal(commandFromScript(`${dir}\\run.ps1`, dir), 'powershell -NoProfile -ExecutionPolicy Bypass -File "run.ps1"');
  assert.equal(commandFromScript(`${dir}\\app.py`, dir), 'python "app.py"');
  assert.equal(commandFromScript(`${dir}\\server.js`, dir), 'node "server.js"');
  // 目录外 / 没填工作目录：用绝对路径
  assert.equal(
    commandFromScript('C:\\tools\\cc-connect.exe', dir),
    '"C:\\tools\\cc-connect.exe"'
  );
  assert.equal(commandFromScript('C:\\tools\\x.bat', ''), '"C:\\tools\\x.bat"');
  // 大小写和路径分隔符不影响判断
  assert.equal(commandFromScript(`${dir.toUpperCase()}\\a.BAT`, dir), '"a.BAT"');
});
