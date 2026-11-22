import test from "node:test";
import assert from "node:assert/strict";

import { KeyframeRingBuffer } from "../src/ring-buffer.ts";
import { muxReplaySnapshot } from "../src/webm-muxer.ts";

const SECOND = 1_000_000;

function buildSnapshot(): ReturnType<KeyframeRingBuffer["snapshot"]> {
  const ring = new KeyframeRingBuffer();
  for (let group = 0; group < 3; group += 1) {
    const start = group * 2 * SECOND;
    ring.appendVideo({
      type: "key",
      timestampUs: start,
      durationUs: 33_333,
      data: new Uint8Array([0x10 + group, 0x20, 0x30, 0x40]),
    });
    for (let frame = 1; frame < 30; frame += 1) {
      ring.appendVideo({
        type: "delta",
        timestampUs: start + frame * 33_333,
        durationUs: 33_333,
        data: new Uint8Array([0x50, frame]),
      });
    }
    for (let frame = 0; frame < 100; frame += 1) {
      ring.appendAudio({
        type: "key",
        timestampUs: start + frame * 20_000,
        durationUs: 20_000,
        data: new Uint8Array([0x60, frame]),
      });
    }
  }
  return ring.snapshot();
}

test("muxes video and Opus audio into a start-on-keyframe WebM", () => {
  const snapshot = buildSnapshot();
  assert.ok(snapshot);
  const result = muxReplaySnapshot(snapshot, { width: 1280, height: 720 });
  assert.ok(result.bytes.byteLength > snapshot.bytes);
  assert.deepEqual(Array.from(result.bytes.slice(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
  assert.match(result.mimeType, /vp8,opus/);
  assert.ok(result.clusterCount >= 1);
  assert.equal(result.videoFrameCount, 90);
  assert.ok(result.audioFrameCount > 0);
  assert.ok(result.durationMs >= 4_900);
});

test("omits the audio track when the ring has no audio yet", () => {
  const ring = new KeyframeRingBuffer();
  ring.appendVideo({ type: "key", timestampUs: 0, durationUs: 33_333, data: new Uint8Array([1, 2, 3]) });
  ring.appendVideo({ type: "delta", timestampUs: 33_333, durationUs: 33_333, data: new Uint8Array([4, 5]) });
  const snapshot = ring.snapshot();
  assert.ok(snapshot);
  const result = muxReplaySnapshot(snapshot, { width: 640, height: 360 });
  assert.equal(result.mimeType, 'video/webm; codecs="vp8"');
  assert.equal(result.audioFrameCount, 0);
});

test("rejects a non-keyframe snapshot instead of emitting a broken clip", () => {
  const snapshot = buildSnapshot();
  assert.ok(snapshot);
  const broken = { ...snapshot, videoFrames: snapshot.videoFrames.map((frame) => ({ ...frame, type: "delta" as const })) };
  assert.throws(() => muxReplaySnapshot(broken, { width: 640, height: 360 }), /keyframe/);
});
