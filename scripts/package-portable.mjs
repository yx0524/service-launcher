/**
 * 便携版打包脚本（离线可用）。
 *
 * 为什么不用 `electron-forge package`：
 *   Forge 打包时用 extract-zip 解压 Electron 缓存包，该库在 Node 26 上 promise 永不 resolve，
 *   进程会静默退出（exit 0 但什么都不生成）。这里改成：
 *   1) 仍然用 Forge 的 Vite 插件产出 .vite 构建产物（这一步是好的）
 *   2) 直接复制 node_modules/electron/dist（@electron/get 已解压好的运行时）
 *   3) 用 @electron/asar 自己打 app.asar
 *
 * 用法：npm run package:portable
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out-zip', 'launcher-app-new-win32-x64');
const stagingDir = path.join(root, 'out-zip', '.app-staging');
const appDir = path.join(root, '.vite');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));

function assertInsideProject(target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝操作项目目录之外的路径：${target}`);
  }
}

function step(message) {
  console.log(`\n▶ ${message}`);
}

// 1) 用 Forge 跑一遍构建（打包那步会失败，这里忽略，只要 .vite 产物）
step('构建 Vite 产物');
spawnSync('npx', ['electron-forge', 'package'], { cwd: root, stdio: 'inherit', shell: true });

const mainBundle = path.join(appDir, 'build', 'main.js');
if (!fs.existsSync(mainBundle)) {
  throw new Error('构建失败：找不到 .vite/build/main.js');
}

if (!fs.existsSync(electronDist)) {
  throw new Error(`找不到 Electron 运行时：${electronDist}`);
}

// 2) 准备 app 目录（只需要 package.json + .vite）
step('整理 app 目录');
for (const target of [stagingDir, outDir]) {
  assertInsideProject(target);
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const minimalPkg = {
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  main: '.vite/build/main.js',
  author: pkg.author,
  license: pkg.license,
};
fs.writeFileSync(
  path.join(stagingDir, 'package.json'),
  JSON.stringify(minimalPkg, null, 2),
  'utf-8'
);
fs.cpSync(appDir, path.join(stagingDir, '.vite'), { recursive: true });
// 图标资源：主进程读 <app>/assets/icon.ico 与 assets/tray*.png（预览图之类不必进包）
const stagedAssets = path.join(stagingDir, 'assets');
fs.mkdirSync(stagedAssets, { recursive: true });
for (const name of ['icon.ico', 'tray.png', 'tray-alert.png']) {
  const from = path.join(root, 'assets', name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(stagedAssets, name));
}
// WinSW：界面里的「注册为 Windows 服务」用它把程序包成系统服务
const winswSrc = path.join(root, 'assets', 'winsw');
if (fs.existsSync(winswSrc)) {
  fs.cpSync(winswSrc, path.join(stagedAssets, 'winsw'), { recursive: true });
}

// 3) 复制 Electron 运行时 + 打 app.asar
step('复制 Electron 运行时');
fs.cpSync(electronDist, outDir, { recursive: true });

const exeFrom = path.join(outDir, 'electron.exe');
const exeTo = path.join(outDir, 'launcher-app-new.exe');
if (fs.existsSync(exeFrom)) fs.renameSync(exeFrom, exeTo);

// 给 exe 换图标资源（rcedit 随 electron-winstaller 一起装好了）
step('写入 exe 图标');
const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const icoPath = path.join(root, 'assets', 'icon.ico');
if (fs.existsSync(rcedit) && fs.existsSync(icoPath)) {
  // rcedit 处理不了含中文的绝对路径，统一用相对路径 + cwd，并且刚复制完的 exe
  // 偶尔还被占用/被杀软扫描，所以重试几次
  const relExe = path.basename(exeTo);
  const relIco = path.relative(outDir, icoPath);
  let done = false;
  let lastError = '';
  for (let attempt = 1; attempt <= 4 && !done; attempt++) {
    const result = spawnSync(rcedit, [relExe, '--set-icon', relIco], {
      cwd: outDir,
      encoding: 'utf-8',
    });
    if (result.status === 0) {
      done = true;
    } else {
      lastError = [result.error?.message, result.stderr, result.stdout]
        .filter(Boolean)
        .join(' ')
        .trim();
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  if (done) console.log('  exe 图标已更新');
  else console.warn(`  ⚠ rcedit 失败（${lastError || '未知原因'}），exe 保留默认图标（不影响功能）`);
} else {
  console.warn('  ⚠ 未找到 rcedit 或 icon.ico，跳过 exe 图标');
}

step('生成 resources/app.asar');
const resourcesDir = path.join(outDir, 'resources');
fs.mkdirSync(resourcesDir, { recursive: true });
const defaultApp = path.join(resourcesDir, 'default_app.asar');
if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp);
await asar.createPackage(stagingDir, path.join(resourcesDir, 'app.asar'));

fs.rmSync(stagingDir, { recursive: true, force: true });

const size = (dir) => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? size(full) : fs.statSync(full).size;
  }
  return total;
};

console.log(`\n✅ 打包完成：${exeTo}`);
console.log(`   体积：${(size(outDir) / 1024 / 1024).toFixed(1)} MB`);
