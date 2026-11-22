import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTimeDomain, initialMetricState } from "../src/audio-metrics.ts";

test("measures RMS energy in dBFS", () => {
  const state = initialMetricState();
  const samples = new Float32Array(2048);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((index / 24_000) * Math.PI * 2 * 440) * 0.5;
  }
  const result = analyzeTimeDomain(samples, state);
  assert.ok(result.energyDb > -10.5);
  assert.ok(result.energyDb < -8.5);
  assert.ok(result.peak > 0.49);
});

test("flags a transient attack above the rolling floor", () => {
  const state = initialMetricState();
  const quiet = new Float32Array(1024);
  for (let index = 0; index < quiet.length; index += 1) {
    quiet[index] = Math.sin(index * 0.7) * 0.004;
  }
  analyzeTimeDomain(quiet, state);
  analyzeTimeDomain(quiet, state);

  const hit = new Float32Array(1024);
  for (let index = 0; index < hit.length; index += 1) {
    hit[index] = Math.sin(index * 1.3) * Math.exp(-index / 180) * 0.65;
  }
  const result = analyzeTimeDomain(hit, state);
  assert.ok(result.onset > 0.3);
  assert.ok(result.energyDb > -25);
});

test("reports very low energy for silence without NaN", () => {
  const state = initialMetricState();
  const result = analyzeTimeDomain(new Float32Array(512), state);
  assert.ok(Number.isFinite(result.energyDb));
  assert.ok(result.energyDb < -100);
  assert.equal(result.onset, 0);
});
