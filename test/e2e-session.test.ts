import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog, MemoryLogSink } from '../src/core/event-log.ts';
import { MediaClock } from '../src/core/media-clock.ts';
import { VirtualClock } from '../src/core/virtual-clock.ts';
import { SyntheticSource } from '../src/media/synthetic-source.ts';
import { LiveSession } from '../src/browser/live-session.ts';
import type { FrameRenderer } from '../src/media/sync-engine.ts';
import type { MediaFrame } from '../src/media/media-types.ts';

class RendererSpy implements FrameRenderer {
  renderedPts: number[] = [];
  freezeEvents: string[] = [];
  released = 0;

  render(frame: MediaFrame): void {
    this.renderedPts.push(frame.ptsMs);
  }
  release(): void {
    this.released += 1;
  }
  freeze(reason: string): void {
    this.freezeEvents.push(reason);
  }
}

function createSession() {
  const clock = new VirtualClock();
  const sink = new MemoryLogSink(10_000);
  const log = new EventLog(sink);
  const mediaClock = new MediaClock({ clock, log });
  const source = new SyntheticSource({ clock, jitterMs: 0 });
  const audio = new RendererSpy();
  const video = new RendererSpy();
  const session = new LiveSession({
    clock,
    log,
    mediaClock,
    audioRenderer: audio,
    videoRenderer: video,
    transport: source,
    pullFrames: () => source.pull(),
    tickIntervalMs: 20,
    catchUpPolicy: { thresholdMs: Number.POSITIVE_INFINITY, stepMs: 1000, withinMs: 200 },
  });
  return { clock, sink, log, mediaClock, source, session, audio, video };
}

test('端到端：起播-暂停-蓝牙切换-切后台-恢复，声画始终共享同一媒体位置', () => {
  const h = createSession();
  h.session.start();

  // 初始缓冲并积累 2 秒数据
  h.clock.advance(2000);
  h.mediaClock.updateBufferedRange(0, 2000, 2000);
  h.session.reportDataAvailable();

  // 推进 1 秒播放
  h.clock.advance(1000);
  h.session.reportBufferedRange(0, 3000, 3000);
  h.session.getEngine().tick();
  assert.equal(h.mediaClock.getState(), 'playing');

  // 用户暂停
  h.session.pause();
  const pausedAt = h.mediaClock.getMediaMs();
  h.clock.advance(3000);
  h.session.getEngine().tick();
  assert.equal(h.mediaClock.getMediaMs(), pausedAt);
  assert.ok(h.audio.freezeEvents.includes('paused'));
  assert.ok(h.video.freezeEvents.includes('paused'));

  // 暂停期间接入蓝牙耳机，延迟从 0 变为 210ms
  h.session.reportLatency({ baseLatencyMs: 40, outputLatencyMs: 210, perfMs: h.clock.now() });
  assert.equal(h.mediaClock.getOutputLatencyMs(), 210);
  assert.equal(h.mediaClock.getMediaMs(), pausedAt, '延迟变化不改变媒体位置');

  // 用户恢复，随后切后台
  h.session.resume();
  h.clock.advance(500);
  h.session.getEngine().tick();
  h.session.reportBufferedRange(0, 4000, 4000);

  // 切后台：进入 background 缓冲
  h.mediaClock.beginBuffering('background');
  h.clock.advance(4000);
  h.session.getEngine().tick();
  assert.equal(h.mediaClock.getState(), 'buffering');
  const frozenAt = h.mediaClock.getMediaMs();

  // 回前台且数据就绪
  h.mediaClock.updateBufferedRange(0, 9000, 9000);
  h.session.reportDataAvailable();
  h.session.getEngine().tick();
  assert.equal(h.mediaClock.getState(), 'playing');
  assert.equal(h.mediaClock.getMediaMs(), frozenAt, '从冻结的同一位置继续');

  // 日志完整：关键事件均存在且带状态/误差
  const names = h.sink.entries().map((entry) => entry.event);
  for (const expected of ['start', 'bufferStart', 'bufferEnd', 'pause', 'resume', 'latencyChange']) {
    assert.ok(names.includes(expected), `missing event ${expected}`);
  }
  const latency = h.sink.entries().find((entry) => entry.event === 'latencyChange');
  assert.equal(latency?.errorMs, 210);
  assert.equal(latency?.state, 'paused');
});

test('端到端：缓冲期用户拖动与自动追直播冲突时，用户意图确定生效', () => {
  const h = createSession();
  h.session.start();
  h.clock.advance(1000);
  h.mediaClock.updateBufferedRange(0, 5000, 5000);
  h.session.reportDataAvailable();
  h.clock.advance(1000);

  // 进入欠载缓冲，排队一个追直播，再被用户拖动抢占
  h.mediaClock.beginBuffering('underrun');
  h.mediaClock.catchUp(4500);
  h.session.seek(2500);
  assert.deepEqual(
    h.mediaClock.pendingCommands().map((command) => command.kind),
    ['userSeek'],
  );

  // 数据覆盖到拖动目标后解冻，落点必须是用户位置
  h.clock.advance(300);
  h.mediaClock.updateBufferedRange(0, 6000, 6000);
  h.session.reportDataAvailable();
  assert.equal(h.mediaClock.getState(), 'playing');
  assert.equal(h.mediaClock.getMediaMs(), 2500);

  const applied = h.sink
    .entries()
    .filter((entry) => entry.event === 'userSeek' && entry.phase === 'applied');
  assert.equal(applied.length, 1);
  const rejected = h.sink
    .entries()
    .filter((entry) => entry.event === 'catchUp' && entry.phase === 'rejected');
  assert.equal(rejected.length, 1);
});

test('端到端：日志 seq 全局单调，缓冲耗时与跳转误差均可复盘', () => {
  const h = createSession();
  h.session.start();
  h.clock.advance(500);
  h.mediaClock.updateBufferedRange(0, 500, 500);
  h.session.reportDataAvailable();
  h.clock.advance(1200); // 制造欠载
  h.session.reportBufferedRange(0, 500, 500);
  h.clock.advance(800);
  h.mediaClock.updateBufferedRange(0, 4000, 4000);
  h.session.reportDataAvailable();

  const entries = h.sink.entries();
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok((entries[i]?.seq ?? 0) > (entries[i - 1]?.seq ?? -1));
  }
  const underrunStart = entries.find(
    (entry) => entry.event === 'bufferStart' && entry.detail.reason === 'underrun',
  );
  assert.ok(underrunStart);
  const bufferEnd = entries.filter((entry) => entry.event === 'bufferEnd').at(-1);
  assert.ok(bufferEnd && (bufferEnd.detail.frozenMs as number) >= 0);
});
