import type { EventPhase, LogEntry, PlaybackState } from './types.ts';

/** 日志接收方：可同时输出到内存环形缓冲、控制台或文件。 */
export interface LogSink {
  write(entry: LogEntry): void;
}

/** 控制台日志 Sink（浏览器 devtools / Node stdout 通用）。 */
export class ConsoleLogSink implements LogSink {
  write(entry: LogEntry): void {
    const payload = JSON.stringify(entry);
    if (entry.phase === 'rejected') {
      console.warn(`[media-clock#${entry.seq}] ${payload}`);
      return;
    }
    console.log(`[media-clock#${entry.seq}] ${payload}`);
  }
}

/** 内存环形缓冲 Sink，便于测试断言与页面内日志面板展示。 */
export class MemoryLogSink implements LogSink {
  private readonly buffer: LogEntry[] = [];

  private readonly capacity: number;

  constructor(capacity = 2000) {
    this.capacity = capacity;
  }

  write(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  entries(): readonly LogEntry[] {
    return this.buffer;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

/** 多路复用 Sink。 */
export class CompositeLogSink implements LogSink {
  private readonly sinks: readonly LogSink[];
  constructor(...sinks: LogSink[]) {
    this.sinks = sinks;
  }
  write(entry: LogEntry): void {
    for (const sink of this.sinks) {
      sink.write(entry);
    }
  }
}

/**
 * 统一事件日志器。
 * seq 严格单调递增，因此即使同一毫秒内发生多个事件，触发顺序也可确定。
 */
export class EventLog {
  private seq = 0;

  private readonly sink: LogSink;

  constructor(sink: LogSink) {
    this.sink = sink;
  }

  record(params: {
    perfMs: number;
    event: string;
    phase: EventPhase;
    state: PlaybackState;
    mediaMs: number;
    outputLatencyMs: number;
    errorMs?: number;
    detail?: Readonly<Record<string, string | number | boolean>>;
  }): LogEntry {
    const entry: LogEntry = {
      seq: ++this.seq,
      perfMs: params.perfMs,
      event: params.event,
      phase: params.phase,
      state: params.state,
      mediaMs: round3(params.mediaMs),
      outputLatencyMs: round3(params.outputLatencyMs),
      errorMs: round3(params.errorMs ?? 0),
      detail: { ...(params.detail ?? {}) },
    };
    this.sink.write(entry);
    return entry;
  }

  /** 下一条日志的序号，测试中用于断言事件数量。 */
  nextSeq(): number {
    return this.seq + 1;
  }
}

/** 保留 3 位小数，避免浮点噪声污染日志（单位仍是毫秒）。 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
