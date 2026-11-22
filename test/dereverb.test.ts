// Regression suite: proves the processor reduces reverb tails without hard
// gating and without dulling the voice, across dry, artificially-reverberant
// and realistic-room material.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dereverb } from "../src/dsp/dereverb.ts";
import { synthVoice, artificialIr, roomIr, applyReverb } from "../src/dsp/synth.ts";
import {
  tailRatioDb,
  spectralCentroid,
  logSpectralDistanceDb,
  estimateT60,
  longestZeroRun,
  rmsDb,
} from "../src/dsp/metrics.ts";

const SR = 16000;
const voice = synthVoice(SR);
const dry = voice.samples;
const speechEnd = voice.speechEndSec;

function process(x: Float32Array, strength = 0.8, t60 = 0.8) {
  return dereverb(x, { sampleRate: SR, strength, t60 });
}

test("dry voice passes through almost untouched", () => {
  const { output } = process(dry);
  const lsd = logSpectralDistanceDb(dry, output, SR);
  const cDry = spectralCentroid(dry, SR);
  const cOut = spectralCentroid(output, SR);
  const levelDrop = rmsDb(dry) - rmsDb(output);
  assert.ok(lsd < 2.0, `log-spectral distance ${lsd.toFixed(2)} dB`);
  assert.ok(Math.abs(cOut - cDry) / cDry < 0.05,
    `centroid shift ${(100 * (cOut - cDry) / cDry).toFixed(1)}%`);
  assert.ok(levelDrop < 1.5, `level drop ${levelDrop.toFixed(2)} dB`);
});

test("artificial reverb: tail suppressed, voice not dulled", () => {
  const wet = applyReverb(dry, artificialIr(SR, 0.8));
  const { output } = process(wet);
  const tailBefore = tailRatioDb(wet, SR, speechEnd);
  const tailAfter = tailRatioDb(output, SR, speechEnd);
  assert.ok(tailBefore - tailAfter > 6,
    `tail reduced by ${(tailBefore - tailAfter).toFixed(1)} dB`);
  // closer to the dry original than the wet input is
  const lsdWet = logSpectralDistanceDb(dry, wet.subarray(0, dry.length), SR);
  const lsdOut = logSpectralDistanceDb(dry, output.subarray(0, dry.length), SR);
  assert.ok(lsdOut < lsdWet, `LSD to dry: wet ${lsdWet.toFixed(2)} -> out ${lsdOut.toFixed(2)} dB`);
  // not muffled: no darker than the input, and moving toward the dry voice
  const cWet = spectralCentroid(wet, SR);
  const cDry = spectralCentroid(dry, SR);
  const cOut = spectralCentroid(output, SR);
  assert.ok(cOut >= cWet * 0.95,
    `centroid ${cWet.toFixed(0)} -> ${cOut.toFixed(0)} Hz (darker than input)`);
  assert.ok(Math.abs(cOut - cDry) <= Math.abs(cWet - cDry),
    `centroid ${cWet.toFixed(0)} -> ${cOut.toFixed(0)} (dry ${cDry.toFixed(0)})`);
});

test("realistic room: T60 shortened, word tails survive (no hard gate)", () => {
  const wet = applyReverb(dry, roomIr(SR));
  const { output, gains } = process(wet);
  const t60In = estimateT60(wet, SR, speechEnd + 0.05);
  const t60Out = estimateT60(output, SR, speechEnd + 0.05);
  assert.ok(t60In > 0.4, `input T60 ${t60In.toFixed(2)}s (sanity)`);
  assert.ok(t60Out < t60In * 0.72,
    `T60 ${t60In.toFixed(2)}s -> ${t60Out.toFixed(2)}s`);
  // no hard gating: every frame gain stays at or above the floor, and the
  // processed tail is attenuated but still audible (not muted to silence)
  let minGain = 1;
  for (const g of gains) for (const v of g) minGain = Math.min(minGain, v);
  assert.ok(minGain >= 0.11, `min gain ${minGain.toFixed(3)}`);
  const tailWet = rmsDb(wet, Math.floor((speechEnd + 0.15) * SR),
    Math.floor((speechEnd + 0.65) * SR));
  const tailOut = rmsDb(output, Math.floor((speechEnd + 0.15) * SR),
    Math.floor((speechEnd + 0.65) * SR));
  const suppression = tailWet - tailOut;
  assert.ok(suppression > 4 && suppression < 25,
    `tail suppression ${suppression.toFixed(1)} dB (soft, not gated)`);
  // a gate would zero long stretches of the tail; we must not
  const tailStart = Math.floor((speechEnd + 0.15) * SR);
  const tailSlice = output.subarray(tailStart, Math.floor((speechEnd + 0.6) * SR));
  const run = longestZeroRun(tailSlice);
  assert.ok(run < 0.02 * SR, `longest muted run in tail ${run} samples`);
  // not muffled: no meaningfully darker than the input
  const cWet = spectralCentroid(wet, SR);
  const cOut = spectralCentroid(output, SR);
  assert.ok(cOut >= cWet * 0.95,
    `centroid ${cWet.toFixed(0)} -> ${cOut.toFixed(0)} Hz (darker than input)`);
});

test("per-sentence strength: bypassed regions stay unprocessed", () => {
  const wet = applyReverb(dry, artificialIr(SR, 0.8));
  const boundary = 2.0; // seconds
  const { output } = dereverb(wet, {
    sampleRate: SR,
    t60: 0.8,
    strength: (t) => (t < boundary ? 0 : 0.9),
  });
  // first half: nearly identical to input
  const n = Math.floor(boundary * SR) - 1024;
  const lsdBypass = logSpectralDistanceDb(
    wet.subarray(0, n), output.subarray(0, n), SR);
  assert.ok(lsdBypass < 0.3, `bypassed region LSD ${lsdBypass.toFixed(2)} dB`);
  // second half: tail actually suppressed
  const tailWet = rmsDb(wet, Math.floor((speechEnd + 0.15) * SR),
    Math.floor((speechEnd + 0.65) * SR));
  const tailOut = rmsDb(output, Math.floor((speechEnd + 0.15) * SR),
    Math.floor((speechEnd + 0.65) * SR));
  assert.ok(tailWet - tailOut > 4,
    `processed region tail suppression ${(tailWet - tailOut).toFixed(1)} dB`);
});

test("residual carries the removed tail, not the voice", () => {
  const wet = applyReverb(dry, artificialIr(SR, 0.8));
  const { output, residual } = process(wet);
  const t0 = Math.floor((speechEnd + 0.15) * SR);
  const t1 = Math.floor((speechEnd + 0.65) * SR);
  // the residual captures most of the removed tail
  const tailWet = rmsDb(wet, t0, t1);
  const tailRes = rmsDb(residual, t0, t1);
  assert.ok(tailWet - tailRes < 6,
    `residual tail ${tailRes.toFixed(1)} dB vs wet tail ${tailWet.toFixed(1)} dB`);
  // but during speech the residual stays far below the signal: the voice
  // itself is not being eaten
  const s0 = Math.floor(0.5 * SR);
  const s1 = Math.floor(1.5 * SR);
  const speechWet = rmsDb(wet, s0, s1);
  const speechRes = rmsDb(residual, s0, s1);
  assert.ok(speechWet - speechRes > 12,
    `residual during speech ${speechRes.toFixed(1)} dB vs wet ${speechWet.toFixed(1)} dB`);
  // output + residual reconstructs the input
  let maxErr = 0;
  for (let i = 0; i < wet.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(wet[i] - (output[i] + residual[i])));
  }
  assert.ok(maxErr < 1e-5, `reconstruction error ${maxErr}`);
});
