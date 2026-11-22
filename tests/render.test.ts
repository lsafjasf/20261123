import test from "node:test";
import assert from "node:assert/strict";
import { renderProject, timeStretch } from "../web/src/core/render.ts";
import type { AudioSource, DetectedPause } from "../web/src/core/types.ts";

const SAMPLE_RATE = 48000;

function sourceOf(seconds: number, frequency = 440): AudioSource {
  const length = Math.round(seconds * SAMPLE_RATE);
  const channels = [new Float32Array(length), new Float32Array(length)];
  for (let index = 0; index < length; index += 1) {
    const value = Math.sin((Math.PI * 2 * frequency * index) / SAMPLE_RATE) * 0.2;
    channels[0][index] = value;
    channels[1][index] = value * 0.75;
  }
  return {
    name: "test.wav",
    sampleRate: SAMPLE_RATE,
    channels,
    bitDepth: 24,
    format: "pcm",
    originalBytes: length * 6,
    isDemo: false,
  };
}

function pause(start: number, duration: number): DetectedPause {
  return {
    id: "pause-1",
    sourceStart: start,
    sourceEnd: start + duration,
    duration,
    confidence: 90,
    levelDb: -72,
    spectralTilt: 0.1,
    state: "active",
    targetMs: 250,
    kind: "clean",
  };
}

test("pause compression targets the requested duration", () => {
  const source = sourceOf(4);
  const result = renderProject(source, { speed: 1, targetMs: 250, segments: [pause(1, 1.5)] });
  assert.equal(result.channels[0].length, Math.round(4 * SAMPLE_RATE) - Math.round(1.25 * SAMPLE_RATE));
  assert.ok(Math.abs(result.duration - 2.75) < 0.001);
  assert.ok(Math.abs(result.removedSeconds - 1.25) < 0.001);
  assert.equal(result.timeline.length, 1);
});

test("bypassed pause and undone pause keep their source duration", () => {
  const source = sourceOf(4);
  for (const state of ["bypassed", "undone"] as const) {
    const segment = { ...pause(1, 1.5), state };
    const result = renderProject(source, { speed: 1, targetMs: 250, segments: [segment] });
    assert.equal(result.channels[0].length, 4 * SAMPLE_RATE);
  }
});

test("phase vocoder changes duration without shifting a sine pitch", () => {
  const source = sourceOf(2, 440);
  const stretched = timeStretch(source.channels, SAMPLE_RATE, 1.5);
  assert.ok(Math.abs(stretched[0].length - (2 * SAMPLE_RATE) / 1.5) < 3);

  const start = Math.round(0.2 * SAMPLE_RATE);
  const end = Math.round(1.2 * SAMPLE_RATE);
  let crossings = 0;
  let previous = stretched[0][start];
  for (let index = start + 1; index < end; index += 1) {
    const current = stretched[0][index];
    if ((current >= 0) !== (previous >= 0)) crossings += 1;
    previous = current;
  }
  const estimatedFrequency = crossings / 2 / ((end - start) / SAMPLE_RATE);
  assert.ok(estimatedFrequency > 425 && estimatedFrequency < 455, `estimated ${estimatedFrequency}`);
});

test("speed and target pause are expressed in final timeline units", () => {
  const source = sourceOf(4);
  const result = renderProject(source, { speed: 1.5, targetMs: 250, segments: [pause(1, 1.5)] });
  assert.ok(Math.abs(result.timeline[0].outputEnd - result.timeline[0].outputStart - 0.25) < 0.01);
  assert.ok(Math.abs(result.duration - (4 / 1.5 - 1.125 / 1.5)) < 0.01);
});
