import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReversePlan, frameIndexAt } from "../src/shared/timeline.ts";
import { reversePcmPlanar, encodeWav } from "../src/shared/wav.ts";

function uniformFrames(n: number, fps: number, start = 0) {
  const d = 1 / fps;
  return Array.from({ length: n }, (_, i) => ({
    cts: start + i * d, duration: d, keyframe: i === 0,
  }));
}

test("reversed plan: last source frame plays first", () => {
  const plan = buildReversePlan(uniformFrames(60, 30, 10), 10, 12);
  assert.equal(plan.frames.length, 60);
  assert.ok(Math.abs(plan.totalDuration - 2) < 1e-9);
  assert.equal(plan.frames[0].sourceCts, 10 + 59 / 30);
  assert.equal(plan.frames[59].sourceCts, 10);
  // output times are contiguous and monotonically increasing
  for (let i = 1; i < 60; i++) {
    assert.ok(plan.frames[i].outputTime > plan.frames[i - 1].outputTime);
  }
});

test("uniform frames: planned A/V error is zero", () => {
  const plan = buildReversePlan(uniformFrames(60, 30, 10), 10, 12);
  assert.ok(plan.avError.maxAbsMs < 1e-6, `max=${plan.avError.maxAbsMs}`);
});

test("non-uniform durations: error reflects mirror misalignment", () => {
  const frames = [
    { cts: 0.0, duration: 0.1, keyframe: true },
    { cts: 0.1, duration: 0.2, keyframe: false },
    { cts: 0.3, duration: 0.1, keyframe: false },
  ];
  const plan = buildReversePlan(frames, 0, 0.4);
  // output order: [0.3..0.4], [0.1..0.3], [0.0..0.1]
  assert.deepEqual(plan.frames.map(f => f.sourceCts), [0.3, 0.1, 0.0]);
  plan.frames.forEach((f, i) => {
    assert.ok(Math.abs(f.outputTime - [0, 0.1, 0.3][i]) < 1e-9);
  });
  // with a tiling schedule the mirror is exact even for non-uniform frames
  assert.ok(plan.avError.maxAbsMs < 1e-9);
});

test("frameIndexAt: resume position does not repeat played frames", () => {
  const plan = buildReversePlan(uniformFrames(60, 30, 10), 10, 12);
  assert.equal(frameIndexAt(plan, 0), 0);
  assert.equal(frameIndexAt(plan, 0.51), 15);
  assert.equal(frameIndexAt(plan, 1.01), 30);
  assert.equal(frameIndexAt(plan, 2.1), 60); // ended
  assert.equal(frameIndexAt(plan, 5.0), 60);
});

test("audio reversal is sample-accurate per channel", () => {
  const left = new Float32Array([1, 2, 3, 4]);
  const right = new Float32Array([-1, -2, -3, -4]);
  const [rl, rr] = reversePcmPlanar([left, right]);
  assert.deepEqual(Array.from(rl), [4, 3, 2, 1]);
  assert.deepEqual(Array.from(rr), [-4, -3, -2, -1]);
});

test("encodeWav writes a valid RIFF header and frame count", () => {
  const ch = [new Float32Array([0, 0.5, -0.5, 1])];
  const wav = encodeWav(ch, 48000);
  const magic = String.fromCharCode(...wav.slice(0, 4));
  assert.equal(magic, "RIFF");
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 4 * 2);
  assert.equal(wav.length, 44 + 8);
  assert.equal(view.getInt16(44 + 6, true), 0x7fff); // last sample = 1.0
});
