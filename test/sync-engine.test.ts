import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog, MemoryLogSink } from '../src/core/event-log.ts';
import { MediaClock } from '../src/core/media-clock.ts';
import { VirtualClock } from '../src/core/virtual-clock.ts';
import { SyncEngine, type FrameRenderer } from '../src/media/sync-engine.ts';
import type { MediaFrame } from '../src/media/media-types.ts';

let sourceSeq = 0;

function frame(kind: 'audio' | 'video', ptsMs: number): MediaFrame {
  sourceSeq += 1;
  return {
    kind,
    ptsMs,
    durationMs: kind === 'audio' ? 20 : 33,
    payload: { id: sourceSeq },
    sourceSeq,
  };
}

class FakeRenderer implements FrameRenderer {
  rendered: MediaFrame[] = [];
  released: MediaFrame[] = [];
  freezes: string[] = [];

  render(f: MediaFrame): void {
    this.rendered.push(f);
  }
  release(f: MediaFrame): void {
    this.released.push(f);
  }
  freeze(reason: string): void {
    this.freezes.push(reason);
  }
}

function setup(catchUpPolicy = { thresholdMs: Number.POSITIVE_INFINITY, stepMs: 1000, withinMs: 200 }) {
  const clock = new VirtualClock();
  const sink = new MemoryLogSink(5000);
  const log = new EventLog(sink);
  const media = new MediaClock({ clock, log });
  const audioRenderer = new FakeRenderer();
  const videoRenderer = new FakeRenderer();
  const engine = new SyncEngine({
    clock,
    media,
    log,
    audioRenderer,
    videoRenderer,
    catchUpPolicy,
  });
  return { clock, sink, log, media, engine, audioRenderer, videoRenderer };
}

test('播放 tick：音频与视频按同一媒体时间调度，渲染日志带误差', () => {
  const h = setup();
  h.media.start();
  h.media.updateBufferedRange(0, 100_000, 100_000);
  h.media.notifyDataAvailable();

  h.engine.enqueue(frame('audio', 0));
  h.engine.enqueue(frame('video', 0));
  h.engine.enqueue(frame('audio', 20));
  h.engine.tick();

  assert.equal(h.audioRenderer.rendered.length, 1);
  assert.equal(h.videoRenderer.rendered.length, 1);
  const renderEntries = h.sink.entries().filter((entry) => entry.event.endsWith('Render'));
  assert.ok(renderEntries.every((entry) => typeof entry.errorMs === 'number'));
});

test('缓冲冻结时音视频一起停住，恢复后从同一 PTS 继续', () => {
  const h = setup();
  h.media.start();
  h.media.updateBufferedRange(0, 100_000, 100_000);
  h.media.notifyDataAvailable();
  h.clock.advance(500);

  h.engine.enqueue(frame('audio', 500));
  h.engine.enqueue(frame('video', 500));
  h.engine.tick();
  const renderedBefore = h.audioRenderer.rendered.length + h.videoRenderer.rendered.length;

  h.media.beginBuffering('underrun');
  h.engine.enqueue(frame('audio', 520));
  h.engine.enqueue(frame('video', 533));
  h.clock.advance(3000);
  h.engine.tick();

  assert.deepEqual(h.audioRenderer.freezes, ['buffering']);
  assert.deepEqual(h.videoRenderer.freezes, ['buffering']);
  const totalAfterFreeze = h.audioRenderer.rendered.length + h.videoRenderer.rendered.length;
  assert.equal(totalAfterFreeze, renderedBefore, '冻结期间不渲染新帧');
  assert.equal(h.media.getMediaMs(), 500);

  h.media.updateBufferedRange(0, 100_000, 100_000);
  h.engine.notifyDataAvailable();
  h.engine.tick();
  assert.equal(h.media.getState(), 'playing');
  assert.equal(h.media.getMediaMs(), 500, '从冻结位置恢复');
});

test('切后台进入 background 缓冲，回前台满足数据条件后恢复', () => {
  const h = setup();
  h.media.start();
  h.media.updateBufferedRange(0, 100_000, 100_000);
  h.media.notifyDataAvailable();
  h.clock.advance(800);

  h.engine.onHidden();
  assert.equal(h.media.getState(), 'buffering');
  assert.equal(h.sink.entries().at(-1)?.event, 'bufferStart');

  h.clock.advance(5000);
  assert.equal(h.media.getMediaMs(), 800);
  h.media.updateBufferedRange(0, 100_000, 100_000);
  h.engine.onVisible();
  assert.equal(h.media.getState(), 'playing');
  assert.ok(h.sink.entries().some((entry) => entry.event === 'foregroundResume'));
});

test('欠载由缓冲区间报告驱动，引擎自动进入 underrun 缓冲', () => {
  const h = setup();
  h.media.start();
  h.media.updateBufferedRange(0, 1000, 1000);
  h.media.notifyDataAvailable();
  h.clock.advance(1000);

  h.engine.updateBufferedRange(0, 1000, 1000);
  assert.equal(h.media.getState(), 'buffering');
  assert.equal(h.sink.entries().filter((entry) => entry.event === 'bufferStart').at(-1)?.detail.reason, 'underrun');
});

test('滞后超阈值时 tick 自动发起步长化追直播', () => {
  const h = setup({ thresholdMs: 3000, stepMs: 1000, withinMs: 200 });
  h.media.start();
  h.media.updateBufferedRange(0, 60_000, 60_000);
  h.media.notifyDataAvailable();
  h.clock.advance(1000); // 媒体位置 1000，边缘 60000

  h.engine.tick();
  const catchUp = h.sink.entries().filter((entry) => entry.event === 'catchUp' && entry.phase === 'applied');
  assert.equal(catchUp.length, 1);
  assert.equal(catchUp[0]?.detail.targetMediaMs, 2000);
});

test('迟到帧被跳帧并释放载荷，日志记录负误差', () => {
  const h = setup();
  h.media.start();
  h.media.updateBufferedRange(0, 100_000, 100_000);
  h.media.notifyDataAvailable();
  h.clock.advance(500);

  h.engine.enqueue(frame('video', 400)); // 已迟到 100ms，超过默认 60ms 容忍
  h.engine.tick();
  assert.equal(h.videoRenderer.released.length, 1);
  const skip = h.sink.entries().find((entry) => entry.event === 'videoSkip');
  assert.ok(skip && skip.errorMs < 0);
});

test('停滞看门狗：抖动缓冲耗尽超时后自动进入 underrun 缓冲，补帧后可恢复', () => {
  const h = setup();
  h.media.start();
  h.media.updateBufferedRange(0, 100_000, 100_000);
  h.media.notifyDataAvailable();
  h.clock.advance(100);

  // 先渲染一帧建立基线
  h.engine.enqueue(frame('video', 100));
  h.engine.tick();
  assert.equal(h.videoRenderer.rendered.length, 1);

  // 之后没有新帧：250ms 内仍在播放，超过阈值自动缓冲
  h.clock.advance(200);
  h.engine.tick();
  assert.equal(h.media.getState(), 'playing');
  h.clock.advance(60);
  h.engine.tick();
  assert.equal(h.media.getState(), 'buffering');
  assert.equal(
    h.sink.entries().filter((entry) => entry.event === 'bufferStart').at(-1)?.detail.reason,
    'underrun',
  );

  // 数据恢复后从冻结位置继续
  h.engine.enqueue(frame('audio', h.media.getMediaMs()));
  h.media.updateBufferedRange(0, 100_000, 100_000);
  h.engine.notifyDataAvailable();
  assert.equal(h.media.getState(), 'playing');
});
