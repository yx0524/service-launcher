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
