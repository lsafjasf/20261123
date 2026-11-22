import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JitterBuffer } from '../src/media/jitter-buffer.ts';
import type { MediaFrame } from '../src/media/media-types.ts';

let sourceSeq = 0;

function frame(kind: 'audio' | 'video', ptsMs: number, durationMs = 20): MediaFrame {
  sourceSeq += 1;
  return { kind, ptsMs, durationMs, payload: { id: sourceSeq }, sourceSeq };
}

test('乱序入队后按 PTS 排序，同 PTS 音频在视频之前', () => {
  const buffer = new JitterBuffer();
  buffer.push(frame('video', 40));
  buffer.push(frame('audio', 20));
  buffer.push(frame('video', 20));
  buffer.push(frame('audio', 0));

  const ordered = [];
  while (buffer.size > 0) {
    const next = buffer.drainDue(Number.POSITIVE_INFINITY);
    if (next) {
      ordered.push(`${next.kind}@${next.ptsMs}`);
    }
  }
  assert.deepEqual(ordered, ['audio@0', 'audio@20', 'video@20', 'video@40']);
});

test('drainDue 只弹出到期帧，未到期保留', () => {
  const buffer = new JitterBuffer();
  buffer.push(frame('audio', 100));
  buffer.push(frame('video', 120));
  assert.equal(buffer.drainDue(90), null);
  const due = buffer.drainDue(100);
  assert.equal(due?.ptsMs, 100);
  assert.equal(buffer.size, 1);
});

test('跳转后 prune 丢弃区间外帧并保留目标窗口', () => {
  const buffer = new JitterBuffer();
  buffer.push(frame('audio', 0));
  buffer.push(frame('video', 500));
  buffer.push(frame('audio', 1000));
  buffer.push(frame('video', 1500));
  const dropped = buffer.prune(900, 1200);
  assert.deepEqual(dropped.map((frameItem) => frameItem.ptsMs).sort((a, b) => a - b), [0, 500, 1500]);
  assert.equal(buffer.size, 1);
  assert.equal(buffer.peek()?.ptsMs, 1000);
});

test('健康度基于缓冲深度，clear 可整体清空', () => {
  const buffer = new JitterBuffer(800);
  assert.equal(buffer.isHealthy(), false);
  buffer.push(frame('audio', 0));
  buffer.push(frame('video', 900));
  assert.equal(buffer.isHealthy(), true);
  assert.equal(buffer.stats().audioFrames, 1);
  assert.equal(buffer.stats().videoFrames, 1);
  assert.equal(buffer.clear().length, 2);
  assert.equal(buffer.size, 0);
});
