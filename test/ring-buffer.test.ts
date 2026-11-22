import test from "node:test";
import assert from "node:assert/strict";

import { KeyframeRingBuffer, type FrameInput } from "../src/ring-buffer.ts";

const MS = 1000;
const SECOND = 1_000_000;
const FRAME_US = 500_000;

function video(type: "key" | "delta", timestampUs: number, byteLength = 64): FrameInput {
  return { type, timestampUs, durationUs: FRAME_US, data: new Uint8Array(byteLength).fill(type === "key" ? 7 : 3) };
}

function audio(timestampUs: number, byteLength = 24): FrameInput {
  return { type: "key", timestampUs, durationUs: 20 * MS, data: new Uint8Array(byteLength).fill(9) };
}

function appendGop(buffer: KeyframeRingBuffer, startUs: number, frameCount = 3): void {
  buffer.appendVideo(video("key", startUs));
  for (let index = 1; index < frameCount; index += 1) {
    buffer.appendVideo(video("delta", startUs + index * FRAME_US));
  }
}

test("starts replay from a keyframe and returns the latest 90 seconds", () => {
  const buffer = new KeyframeRingBuffer({ maxDurationUs: 90 * SECOND });
  for (let second = 0; second <= 120; second += 2) {
    appendGop(buffer, second * SECOND);
    buffer.appendAudio(audio(second * SECOND));
  }

  const snapshot = buffer.snapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.videoFrames[0].type, "key");
  assert.equal(snapshot.anchorKeyframeUs, 30 * SECOND);
  assert.ok(snapshot.durationUs >= 90 * SECOND);
  assert.ok(snapshot.durationUs <= 92 * SECOND);
  assert.ok(snapshot.audioFrames[0].timestampUs >= 0);

  const stats = buffer.stats();
  assert.ok(stats.gopCount > 40);
  assert.ok(stats.durationUs <= 92 * SECOND);
});

test("eviction removes complete GOPs and never leaves a delta frame first", () => {
  const buffer = new KeyframeRingBuffer({ maxDurationUs: 20 * SECOND, maxBytes: 400 });
  appendGop(buffer, 0);
  appendGop(buffer, 2 * SECOND);
  appendGop(buffer, 4 * SECOND);
  appendGop(buffer, 6 * SECOND);

  const snapshot = buffer.snapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.videoFrames[0].type, "key");
  assert.equal(snapshot.videoFrames[0].timestampUs, 0);
  assert.ok(snapshot.videoFrames.every((frame, index) => index === 0 || frame.timestampUs > 0));
  assert.ok(buffer.stats().droppedGops >= 2);
});

test("an oversized active GOP is retained rather than corrupting the recording", () => {
  const buffer = new KeyframeRingBuffer({ maxBytes: 100 });
  buffer.appendVideo(video("key", 0, 200));
  buffer.appendVideo(video("delta", FRAME_US, 200));

  const snapshot = buffer.snapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.videoFrames.length, 2);
  assert.equal(snapshot.videoFrames[0].type, "key");
  assert.equal(buffer.stats().overBudget, true);
  assert.equal(buffer.stats().gopCount, 1);
});

test("snapshot bytes are isolated from later writes and evictions", () => {
  const buffer = new KeyframeRingBuffer({ maxDurationUs: 10 * SECOND, maxBytes: 256 });
  appendGop(buffer, 0);
  appendGop(buffer, 2 * SECOND);
  const snapshot = buffer.snapshot();
  assert.ok(snapshot);
  const firstData = snapshot.videoFrames[0].data.slice();

  for (let second = 4; second <= 20; second += 2) {
    appendGop(buffer, second * SECOND);
  }
  buffer.appendVideo(video("key", 24 * SECOND, 900));

  assert.deepEqual(snapshot.videoFrames[0].data, firstData);
  assert.equal(snapshot.videoFrames[0].type, "key");
  assert.equal(buffer.snapshot()?.videoFrames[0].type, "key");
});

test("repeated snapshots produce independent copies with identical ranges", () => {
  const buffer = new KeyframeRingBuffer();
  appendGop(buffer, 0);
  appendGop(buffer, 2 * SECOND);
  const first = buffer.snapshot();
  const second = buffer.snapshot();
  assert.ok(first && second);
  assert.equal(first.sourceStartUs, second.sourceStartUs);
  assert.equal(first.sourceEndUs, second.sourceEndUs);
  assert.notEqual(first.videoFrames[0].data, second.videoFrames[0].data);
  first.videoFrames[0].data[0] = 255;
  assert.notEqual(second.videoFrames[0].data[0], 255);
});

test("rejects a delta frame before the first keyframe and trims early audio", () => {
  const buffer = new KeyframeRingBuffer();
  assert.equal(buffer.appendVideo(video("delta", 0)), false);
  assert.equal(buffer.appendAudio(audio(0)), false);
  buffer.appendVideo(video("key", 1 * SECOND));
  assert.equal(buffer.appendAudio(audio(500 * MS)), true);
  assert.equal(buffer.appendAudio(audio(1_200 * MS)), true);
  assert.equal(buffer.stats().audioFrameCount, 1);
  assert.equal(buffer.stats().discardedFrames, 2);
});

test("a bitrate spike does not drop the active GOP or mutate existing snapshots", () => {
  const buffer = new KeyframeRingBuffer({ maxDurationUs: 20 * SECOND, maxBytes: 700 });
  appendGop(buffer, 0, 3);
  appendGop(buffer, 2 * SECOND, 3);
  appendGop(buffer, 4 * SECOND, 3);
  const beforeSpike = buffer.snapshot();
  assert.ok(beforeSpike);

  buffer.appendVideo(video("key", 6 * SECOND));
  for (let index = 1; index <= 40; index += 1) {
    buffer.appendVideo(video("delta", 6 * SECOND + index * FRAME_US, 512));
  }

  const latest = buffer.snapshot();
  assert.ok(latest);
  assert.equal(latest.videoFrames[0].type, "key");
  assert.equal(latest.videoFrames[0].timestampUs, 0);
  assert.ok(latest.videoFrames.length > 1);
  assert.equal(beforeSpike.videoFrames.length, 9);
});

test("clearing a ring resets counters but leaves prior snapshots reusable", () => {
  const buffer = new KeyframeRingBuffer({ maxBytes: 300 });
  appendGop(buffer, 0);
  appendGop(buffer, 2 * SECOND);
  const snapshot = buffer.snapshot();
  assert.ok(snapshot);
  buffer.clear();
  assert.equal(buffer.stats().gopCount, 0);
  assert.equal(buffer.stats().totalBytes, 0);
  assert.equal(snapshot.videoFrames[0].data.byteLength, 64);
  appendGop(buffer, 10 * SECOND);
  assert.equal(buffer.stats().keyframeOrdinal, 1);
});
