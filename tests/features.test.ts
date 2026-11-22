import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeMonoFeatures } from "../src/analysis/features.ts";

const RATE = 8000;

function synthTone(frequency: number, seconds: number): Float32Array {
  const output = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < output.length; i++) {
    const phase = (2 * Math.PI * frequency * i) / RATE;
    output[i] =
      0.36 * Math.sin(phase) +
      0.18 * Math.sin(phase * 2) +
      0.09 * Math.sin(phase * 3) +
      0.05 * Math.sin(phase * 4);
  }
  return output;
}

function seededNoise(seconds: number): Float32Array {
  const output = new Float32Array(Math.round(RATE * seconds));
  let seed = 123456789;
  for (let i = 0; i < output.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    output[i] = (seed / 0xffffffff - 0.5) * 0.7;
  }
  return output;
}

test("estimates the pitch of a harmonic vocal-like tone", () => {
  const features = analyzeMonoFeatures(
    synthTone(440, 2),
    RATE,
    2,
  );
  const active = Array.from(features.voiced).filter(Boolean).length;
  const pitches = Array.from(features.midi).filter(Number.isFinite);
  const average = pitches.reduce((sum, value) => sum + value, 0) / pitches.length;
  assert.ok(active > features.frameCount * 0.9);
  assert.ok(Math.abs(average - 69) < 0.8, `average midi was ${average}`);
});

test("rejects silence and broadband noise", () => {
  const silence = analyzeMonoFeatures(new Float32Array(RATE * 2), RATE, 2);
  const noise = analyzeMonoFeatures(seededNoise(2), RATE, 2);
  const silentVoiced = Array.from(silence.voiced).filter(Boolean).length;
  const noisyVoiced = Array.from(noise.voiced).filter(Boolean).length;
  assert.equal(silentVoiced, 0);
  assert.ok(noisyVoiced < noise.frameCount * 0.08);
});
