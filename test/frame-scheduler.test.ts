import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameScheduler } from '../src/media/frame-scheduler.ts';
import type { MediaFrame } from '../src/media/media-types.ts';

function frame(kind: 'audio' | 'video', ptsMs: number): MediaFrame {
  return { kind, ptsMs, durationMs: kind === 'audio' ? 20 : 33, payload: {}, sourceSeq: 1 };
}

test('无帧时等待', () => {
  const scheduler = new FrameScheduler();
  assert.deepEqual(scheduler.decide(null, 0, 0), { action: 'wait' });
});

test('音频按蓝牙输出延迟提前调度，视频不提前', () => {
  const scheduler = new FrameScheduler();
  const audio = frame('audio', 100);
  const decision = scheduler.decide(audio, 0, 180);
  // PTS 在 100ms 后，输出延迟 180ms => 现在就要入队（dueIn=0）
  assert.equal(decision.action, 'render');
  if (decision.action === 'render') {
    assert.equal(decision.dueInMs, 0);
  }

  const video = frame('video', 100);
  assert.equal(scheduler.decide(video, 0, 180).action, 'wait');
  const videoDue = scheduler.decide(frame('video', 100), 95, 180);
  assert.equal(videoDue.action, 'render');
});

test('迟到超过容忍阈值的帧被跳帧', () => {
  const scheduler = new FrameScheduler({ lateToleranceMs: 60 });
  const lateFrame = frame('video', 100);
  const decision = scheduler.decide(lateFrame, 200, 0);
  assert.equal(decision.action, 'skip');
  if (decision.action === 'skip') {
    assert.equal(decision.reason, 'late');
  }
});

test('呈现误差符号约定：正为偏早、负为迟到', () => {
  const scheduler = new FrameScheduler();
  assert.equal(scheduler.presentationError(frame('video', 150), 100), 50);
  assert.equal(scheduler.presentationError(frame('video', 80), 100), -20);
});
