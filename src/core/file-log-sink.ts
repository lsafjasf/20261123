import { appendFileSync, closeSync, openSync } from 'node:fs';
import type { LogSink } from './event-log.ts';
import type { LogEntry } from './types.ts';

/**
 * 文件日志 Sink（Node 环境）：每行一条 JSON（JSONL），
 * 完整保留事件触发顺序（seq）、缓冲状态、媒体时间与误差，
 * 供离线复盘与外部分析工具消费。
 */
export class FileLogSink implements LogSink {
  private readonly fd: number;

  constructor(filePath: string) {
    this.fd = openSync(filePath, 'a');
  }

  write(entry: LogEntry): void {
    appendFileSync(this.fd, `${JSON.stringify(entry)}\n`);
  }

  close(): void {
    closeSync(this.fd);
  }
}
