import test from "node:test";
import assert from "node:assert/strict";
import { masterAudio, measureLoudness } from "../web/src/core/loudness.ts";

const SAMPLE_RATE = 48000;

function tone(seconds: number, frequency = 440, amplitude = 0.08): Float32Array[] {
  const length = Math.round(seconds * SAMPLE_RATE);
  const channel = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    channel[index] = Math.sin((Math.PI * 2 * frequency * index) / SAMPLE_RATE) * amplitude;
  }
  return [channel, channel.slice()];
}

test("integrated loudness is stable for a steady stereo tone", () => {
  const result = measureLoudness(tone(4), SAMPLE_RATE);
  assert.ok(Number.isFinite(result.integratedLufs));
  assert.ok(result.truePeakDb > -25 && result.truePeakDb < -20);
});

test("mastering reaches -14 LUFS and respects -1 dBTP", () => {
  const mastered = masterAudio(tone(4), SAMPLE_RATE, -14, -1);
  assert.ok(Math.abs(mastered.integratedLufs - -14) < 0.45, `LUFS ${mastered.integratedLufs}`);
  assert.ok(mastered.truePeakDb <= -0.9, `peak ${mastered.truePeakDb}`);
  assert.ok(mastered.channels[0].length === 4 * SAMPLE_RATE);
});

test("peak limiter protects a hot transient", () => {
  const channels = tone(2, 220, 0.018);
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += SAMPLE_RATE / 2) {
      channel[index] = index % 4 === 0 ? -0.98 : 0.98;
    }
  }
  const mastered = masterAudio(channels, SAMPLE_RATE, -9, -1);
  assert.ok(mastered.truePeakDb <= -0.9, `peak ${mastered.truePeakDb}`);
  assert.ok(mastered.limitedSamples > 0);
});
