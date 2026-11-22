import { EventLog, MemoryLogSink } from '../src/core/event-log.ts';
import { MediaClock } from '../src/core/media-clock.ts';
import { VirtualClock } from '../src/core/virtual-clock.ts';

export interface Harness {
  clock: VirtualClock;
  log: EventLog;
  sink: MemoryLogSink;
  media: MediaClock;
}

/** 构造带虚拟时钟与内存日志的测试时钟。 */
export function createHarness(): Harness {
  const clock = new VirtualClock();
  const sink = new MemoryLogSink(5000);
  const log = new EventLog(sink);
  const media = new MediaClock({ clock, log });
  return { clock, log, sink, media };
}

/** 起播并完成初始缓冲，使时钟进入 playing。 */
export function startPlaying(h: Harness, bufferedToMs = 100_000): void {
  h.media.start();
  h.media.updateBufferedRange(0, bufferedToMs, bufferedToMs);
  h.media.notifyDataAvailable();
}

/** 取所有结构化日志的事件名序列，便于断言触发顺序。 */
export function eventNames(h: Harness): string[] {
  return h.sink.entries().map((entry) => `${entry.event}:${entry.phase}`);
}

/** 按事件名与阶段过滤日志。 */
export function entriesOf(
  h: Harness,
  event: string,
  phase?: string,
): ReturnType<MemoryLogSink['entries']> {
  return h.sink
    .entries()
    .filter((entry) => entry.event === event && (phase === undefined || entry.phase === phase));
}
