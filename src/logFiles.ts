import fs from 'node:fs';
import path from 'node:path';
import type { AppLogEntry, LogEntry } from './types';

/** persistLog 写出来的行：[HH:MM:SS] [stdout|stderr|system] [进程名] 内容 */
const LINE = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*\[(stdout|stderr|system)\]\s*\[(.*?)\]\s?([\s\S]*)$/;

/**
 * 把落盘的日志文本解析回日志条目。
 * 认不出来的行算上一行的续行：多行堆栈、带换行的报错全靠这个，
 * 否则一条 traceback 会被拆成十几条没有类型的碎行。
 */
export function parseLogText(text: string, appId: string, day: Date): AppLogEntry[] {
  const out: AppLogEntry[] = [];
  const base = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const matched = LINE.exec(raw);
    if (matched) {
      const seconds = Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3]);
      out.push({
        appId,
        processId: 'main',
        processName: matched[5],
        timestamp: base + seconds * 1000,
        type: matched[4] as LogEntry['type'],
        content: matched[6],
      });
      continue;
    }
    const last = out[out.length - 1];
    if (last) last.content = `${last.content}\n${raw}`;
  }
  return out;
}

/**
 * 落盘失败时留个证据。
 * 日志/指标原来都是 catch 里空着 —— 权限不对、文件被占用、磁盘满，
 * 界面上一点提示都没有，只能看着「曲线不动了」猜。这里单独写一个诊断文件，
 * 它跟出问题的文件不是同一个，所以「单个文件被锁」这种情况照样能记下来。
 */
export function noteWriteFailure(dir: string, scope: string, error: unknown): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'write-errors.log');
    try {
      if (fs.statSync(file).size > 200 * 1024) fs.rmSync(file, { force: true });
    } catch {
      /* 没有就不用管 */
    }
    const message = error instanceof Error ? error.message : String(error);
    fs.appendFileSync(file, `[${new Date().toLocaleString()}] ${scope}: ${message}\n`, 'utf-8');
  } catch {
    /* 连诊断文件都写不进去，就只能靠启动时的可写性自检报错了 */
  }
}

/** 读日志文件尾部（最多 maxLines 行）；文件不存在或读不动就返回空数组。 */
export function readLogTail(file: string, appId: string, maxLines = 600): AppLogEntry[] {
  let text: string;
  let day: Date;
  try {
    const stat = fs.statSync(file);
    text = fs.readFileSync(file, 'utf-8');
    const stamped = /^(\d{4})-(\d{2})-(\d{2})/.exec(path.basename(file));
    day = stamped
      ? new Date(Number(stamped[1]), Number(stamped[2]) - 1, Number(stamped[3]))
      : stat.mtime;
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > maxLines) text = lines.slice(-maxLines).join('\n');
  return parseLogText(text, appId, day);
}
