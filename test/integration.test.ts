// End-to-end pipeline test (everything except the browser decode/encode
// step): demux -> range selection -> reverse plan -> report -> WAV.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { demux, samplesForRange } from "../src/shared/mp4.ts";
import { buildReversePlan, frameIndexAt } from "../src/shared/timeline.ts";
import { reversePcmPlanar, encodeWav } from "../src/shared/wav.ts";

const SAMPLE = new URL("../media/sample.mp4", import.meta.url).pathname;

function load() {
  const buf = readFileSync(SAMPLE);
  return demux(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

test("last-2s pipeline: range, plan, report, audio", () => {
  const d = load();
  const dur = d.video!.durationSec;
  const start = dur - 2;
  const end = dur;

  // decode-order samples from the nearest keyframe at/before start
  const samples = samplesForRange(d.video!, start, end);
  assert.ok(samples[0].keyframe, "decode begins at a keyframe");
  assert.ok(samples[0].cts <= start + 1e-6);

  // frames that survive the start/end trim, in presentation order
  const frames = samples
    .filter(s => s.cts >= start - 1e-6 && s.cts < end)
    .sort((a, b) => a.cts - b.cts);
  const plan = buildReversePlan(
    frames.map(s => ({ cts: s.cts, duration: s.duration, keyframe: s.keyframe })),
    start, end,
  );
  assert.equal(plan.frames.length, 60);
  assert.ok(Math.abs(plan.totalDuration - 2) < 0.05);

  // output order is the exact reverse of the source presentation order
  for (let k = 0; k < plan.frames.length; k++) {
    assert.equal(plan.frames[k].sourceCts, frames[frames.length - 1 - k].cts);
  }
  assert.ok(plan.avError.maxAbsMs < 1, `planned av error ${plan.avError.maxAbsMs}ms`);

  // pause/resume: positions map to strictly forward frame indices
  const seen = new Set<number>();
  for (let t = 0; t < plan.totalDuration; t += 0.017) {
    const idx = frameIndexAt(plan, t);
    assert.ok(idx < plan.frames.length);
    seen.add(idx);
  }
  assert.ok(seen.size > 50, "playhead sweeps most frames without repeating");

  // audio reversal + WAV export of the same timeline
  const rate = 48000;
  const n = Math.round(plan.totalDuration * rate);
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = Math.sin((i / rate) * 440 * 2 * Math.PI);
  const [rev] = reversePcmPlanar([src]);
  assert.equal(rev.length, n);
  assert.ok(Math.abs(rev[0] - src[n - 1]) < 1e-7);
  const wav = encodeWav([rev], rate);
  assert.equal(wav.length, 44 + n * 2);

  // report shape
  const report = {
    originalRange: { startSec: plan.startSec, endSec: plan.endSec },
    output: { frameCount: plan.frames.length, durationSec: plan.totalDuration },
    frameOrder: plan.frames.map(f => ({
      outputIndex: f.outputIndex,
      outputTimeSec: f.outputTime,
      sourceCtsSec: f.sourceCts,
    })),
    avError: { planned: plan.avError },
  };
  assert.equal(report.frameOrder.length, 60);
  assert.equal(report.frameOrder[0].sourceCtsSec, frames[frames.length - 1].cts);
  assert.ok(report.originalRange.endSec - report.originalRange.startSec <= 2.001);
});

test("user-adjustable range: arbitrary start/end respected", () => {
  const d = load();
  const plan = buildReversePlan(
    samplesForRange(d.video!, 3.5, 6.25)
      .filter(s => s.cts >= 3.5 - 1e-6 && s.cts < 6.25)
      .map(s => ({ cts: s.cts, duration: s.duration, keyframe: s.keyframe })),
    3.5, 6.25,
  );
  assert.ok(plan.frames.length >= 80 && plan.frames.length <= 83,
    `frames=${plan.frames.length}`);
  assert.ok(plan.frames.every(f => f.sourceCts >= 3.5 - 1e-6 && f.sourceCts < 6.25));
});
