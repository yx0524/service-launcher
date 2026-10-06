import fs from 'node:fs';
import path from 'node:path';

/**
 * 图标、WinSW 等随包资源的目录。
 * 开发时是 <项目根>/assets，打包后是 app.asar/assets（便携打包脚本会把它放进去）。
 * __dirname 在两种情况下都是 <根>/.vite/build。
 */
export function assetsDir(): string {
  return path.join(__dirname, '..', '..', 'assets');
}

export function assetPath(name: string): string {
  return path.join(assetsDir(), name);
}

export function existingAsset(name: string): string | undefined {
  const target = assetPath(name);
  return fs.existsSync(target) ? target : undefined;
}
