import path from 'node:path';
import type { ProcessConfig } from './types';

export interface PreflightIssue {
  /** 问题描述，直接给用户看。 */
  message: string;
  /** 怎么修。 */
  fix?: string;
}

export interface PreflightContext {
  workingDir: string;
  dirExists: boolean;
  /** 注入的文件存在性判断，方便单测。 */
  exists: (absolutePath: string) => boolean;
  hasPackageJson: boolean;
  hasNodeModules: boolean;
  env: Record<string, string | undefined>;
}

/** 展开 %USERPROFILE% 这类 cmd 风格变量（进程内部仍可能用到 $env: 风格，这里只管 %）。 */
export function expandEnvVars(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => {
    const value = env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

/** 取命令行的第一个 token，支持双引号包裹的路径。 */
export function firstToken(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/)[0];
}

/** 判断一个 token 是不是「路径」而不是 PATH 里的命令名。 */
export function looksLikePath(token: string): boolean {
  if (!token) return false;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  if (/^%[A-Za-z_]+%[\\/]/.test(token)) return true;
  if (/[\\/]/.test(token)) return true;
  return /\.(exe|cmd|bat|ps1|py|js|mjs|cjs|sh)$/i.test(token);
}

/** 把「a,b c」这种写法拆成模块名数组。 */
export function parseModuleList(raw: string[] | string | undefined): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const result: string[] = [];
  for (const item of list) {
    for (const part of String(item).split(/[,\s;]+/)) {
      const name = part.trim();
      if (name && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !result.includes(name)) {
        result.push(name);
      }
    }
  }
  return result;
}

/**
 * 启动前静态预检：只做「看得到」的判断，不启动进程。
 * python 依赖能不能 import 需要真正跑一次解释器，由 runner 负责。
 */
export function evaluatePreflight(proc: ProcessConfig, ctx: PreflightContext): PreflightIssue[] {
  const issues: PreflightIssue[] = [];

  if (!ctx.dirExists) {
    issues.push({
      message: `工作目录不存在：${ctx.workingDir}`,
      fix: '在「编辑服务」里改对工作目录',
    });
    return issues;
  }

  const token = firstToken(proc.command);
  if (looksLikePath(token)) {
    const expanded = expandEnvVars(token, ctx.env);
    const absolute = path.isAbsolute(expanded) ? expanded : path.join(ctx.workingDir, expanded);
    if (!ctx.exists(absolute)) {
      issues.push({
        message: `找不到可执行文件：${expanded}`,
        fix: '检查解释器/脚本路径；或把命令改成 PATH 里的名字（如 python、node）',
      });
    }
  }

  const usesNodeModules = /node_modules/i.test(proc.command) || /(^|\s)(npm|npx|yarn|pnpm|bun)(\s|$)/i.test(proc.command);
  if (usesNodeModules && ctx.hasPackageJson && !ctx.hasNodeModules) {
    issues.push({
      message: '依赖未安装（有 package.json，但没有 node_modules）',
      fix: `在 ${ctx.workingDir} 执行 npm install`,
    });
  }

  for (const relative of proc.preflightFiles ?? []) {
    const target = path.isAbsolute(relative) ? relative : path.join(ctx.workingDir, relative);
    if (!ctx.exists(target)) {
      issues.push({ message: `缺少必需的文件/目录：${relative}` });
    }
  }

  return issues;
}
