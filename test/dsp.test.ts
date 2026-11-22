import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { segmentSentences, envelope, ncc, pitchTrack, fft } from "../src/shared/dsp.ts";
import { alignTakes } from "../src/shared/align.ts";
import { computeMetrics } from "../src/shared/metrics.ts";
import { decodeWav } from "../src/shared/wav.ts";

function loadTake(n: number): { samples: Float32Array; sr: number } {
  const buf = readFileSync(`takes/take-${String(n).padStart(2, "0")}.wav`);
  const wav = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { samples: wav.channels[0], sr: wav.sampleRate };
}

test("segments demo take into 6 sentences with 7 cut points", () => {
  const { samples, sr } = loadTake(1);
  const seg = segmentSentences(samples, sr);
  assert.equal(seg.sentences.length, 6);
  assert.equal(seg.cutPoints.length, 7);
  for (let i = 0; i < seg.sentences.length; i++) {
    assert.ok(seg.cutPoints[i] <= seg.sentences[i].start + 1e-6, `cut ${i} before onset`);
    assert.ok(seg.cutPoints[i + 1] >= seg.sentences[i].end - 1e-6, `cut ${i + 1} after offset`);
  }
  // Noise floor estimate should be well below speech level.
  assert.ok(seg.noiseFloorDb < -40, `noise floor ${seg.noiseFloorDb}`);
});

test("cut points land in quiet regions (breath valleys)", () => {
  const { samples, sr } = loadTake(3);
  const seg = segmentSentences(samples, sr);
  for (const cp of seg.cutPoints) {
    const frame = Math.round(cp * seg.framesPerSecond);
    const lo = Math.max(0, frame - 2);
    const hi = Math.min(seg.frameDb.length - 1, frame + 2);
    let local = -Infinity;
    for (let i = lo; i <= hi; i++) local = Math.max(local, seg.frameDb[i]);
    assert.ok(local < seg.noiseFloorDb + 16, `cut at ${cp}s too loud: ${local} dB`);
  }
});

test("all 12 takes align 1:1 by sentence index", () => {
  const takes = Array.from({ length: 12 }, (_, i) => loadTake(i + 1));
  const segs = takes.map((t) => segmentSentences(t.samples, t.sr));
  for (const s of segs) assert.equal(s.sentences.length, 6);
  const aligned = alignTakes(segs, 0);
  for (const row of aligned) assert.deepEqual(row, [0, 1, 2, 3, 4, 5]);
});

test("metrics: rhythm high for same take, noise floors differ across takes", () => {
  const takes = [loadTake(1), loadTake(2), loadTake(12)];
  const segs = takes.map((t) => segmentSentences(t.samples, t.sr));
  const aligned = alignTakes(segs, 0);
  const m = computeMetrics(
    takes.map((t) => t.samples),
    takes[0].sr,
    segs,
    aligned,
    0,
  );
  assert.equal(m.length, 3);
  assert.equal(m[0].length, 6);
  assert.ok(m[0][0].rhythm > 0.99, "reference rhythm vs itself");
  assert.ok(m[1][0].rhythm > 0.5, `same script rhythm should correlate, got ${m[1][0].rhythm}`);
  // Take 12 was synthesized noisier than take 1.
  assert.ok(m[2][0].noiseDb > m[0][0].noiseDb, "noise floor ordering");
});

test("ncc of identical envelopes is 1; shifted envelope lower", () => {
  const sr = 1000;
  const x = new Float32Array(sr);
  for (let i = 100; i < 300; i++) x[i] = Math.sin((i / 300) * Math.PI);
  const a = envelope(x, sr, 0, 1, 32);
  assert.ok(ncc(a, a) > 0.999);
  const y = new Float32Array(sr);
  for (let i = 150; i < 350; i++) y[i] = Math.sin(((i - 50) / 300) * Math.PI);
  const b = envelope(y, sr, 0, 1, 32);
  assert.ok(ncc(a, b) < 0.99);
});

test("pitch track recovers synthetic f0", () => {
  const sr = 24000;
  const x = new Float32Array(sr);
  for (let i = 0; i < sr; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 150 * i) / sr);
  const p = pitchTrack(x, sr, 0, 1);
  assert.ok(Math.abs(p.meanHz - 150) < 3, `f0 ${p.meanHz}`);
  assert.ok(p.voicedRatio > 0.9);
});

test("fft of a cosine peaks at the right bin", () => {
  const n = 256;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const k = 7;
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k * i) / n);
  fft(re, im);
  let peak = 0;
  let peakV = 0;
  for (let i = 1; i < n / 2; i++) {
    const mag = Math.hypot(re[i], im[i]);
    if (mag > peakV) {
      peakV = mag;
      peak = i;
    }
  }
  assert.equal(peak, k);
});
