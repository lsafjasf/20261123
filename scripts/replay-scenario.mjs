/**
 * 离线场景回放（Node 标准库，无外部服务）。
 * 用虚拟时钟驱动统一媒体时钟，复现：起播缓冲 -> 播放 -> 暂停 ->
 * 蓝牙耳机延迟突变 -> 切后台冻结 -> 回前台恢复 -> 拖动/追直播冲突，
 * 并把结构化事件日志写入 artifacts/replay-log.jsonl。
 */
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { EventLog, CompositeLogSink, MemoryLogSink } = await import(
  new URL('../src/core/event-log.ts', import.meta.url)
);
const { MediaClock } = await import(new URL('../src/core/media-clock.ts', import.meta.url));
const { VirtualClock } = await import(new URL('../src/core/virtual-clock.ts', import.meta.url));
const { SyncEngine } = await import(new URL('../src/media/sync-engine.ts', import.meta.url));

class SpyRenderer {
  constructor(name) {
    this.name = name;
    this.rendered = 0;
    this.freezes = [];
  }
  render() {
    this.rendered += 1;
  }
  release() {}
  freeze(reason) {
    this.freezes.push(reason);
  }
}

const clock = new VirtualClock();
const memory = new MemoryLogSink(10_000);
const log = new EventLog(new CompositeLogSink(memory));
const media = new MediaClock({ clock, log });
const audio = new SpyRenderer('audio');
const video = new SpyRenderer('video');
const engine = new SyncEngine({
  clock,
  media,
  log,
  audioRenderer: audio,
  videoRenderer: video,
  catchUpPolicy: { thresholdMs: Number.POSITIVE_INFINITY, stepMs: 1000, withinMs: 200 },
});

// 起播初始缓冲
media.start();
clock.advance(150);
media.updateBufferedRange(0, 60_000, 60_000);
media.notifyDataAvailable();

// 播放 2 秒
clock.advance(2000);
engine.tick();

// 用户暂停
media.pause();
clock.advance(3000);
engine.tick();

// 蓝牙耳机接入：延迟 0 -> 210ms
media.latencyChange({ baseLatencyMs: 40, outputLatencyMs: 210, perfMs: clock.now() });

// 恢复后切后台
media.resume();
clock.advance(800);
engine.onHidden();
clock.advance(4000);
engine.tick();
media.updateBufferedRange(0, 60_000, 60_000);
engine.onVisible();

// 缓冲内冲突：追直播排队后被用户拖动抢占
media.beginBuffering('underrun');
media.catchUp(55_000);
media.userSeek(8_000);
media.updateBufferedRange(0, 60_000, 60_000);
media.notifyDataAvailable();
engine.tick();

media.end();

const outDir = join(root, 'artifacts');
mkdirSync(outDir, { recursive: true });
const target = join(outDir, 'replay-log.jsonl');
const lines = memory.entries().map((entry) => JSON.stringify(entry)).join('\n');
writeFileSync(target, `${lines}\n`);

const summary = {
  events: memory.entries().length,
  finalState: media.getState(),
  finalMediaMs: media.getMediaMs(),
  outputLatencyMs: media.getOutputLatencyMs(),
  audioFreezes: audio.freezes,
  videoFreezes: video.freezes,
  logFile: target,
};
console.log(JSON.stringify(summary, null, 2));
