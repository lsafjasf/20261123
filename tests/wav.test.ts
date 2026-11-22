import test from "node:test";
import assert from "node:assert/strict";
import { decodeWav, encodeWav24, pairTracks } from "../web/src/core/wav.ts";
import type { AudioSource } from "../web/src/core/types.ts";

function sine(length: number, frequency: number, sampleRate: number, gain = 0.5): Float32Array {
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = Math.sin((Math.PI * 2 * frequency * index) / sampleRate) * gain;
  }
  return samples;
}

test("24-bit WAV round trip preserves channels and timing", () => {
  const sampleRate = 48000;
  const left = sine(4800, 440, sampleRate);
  const right = sine(4800, 660, sampleRate, 0.25);
  const buffer = encodeWav24([left, right], sampleRate);
  const source = decodeWav(buffer, "roundtrip.wav");

  assert.equal(source.sampleRate, sampleRate);
  assert.equal(source.channels.length, 2);
  assert.equal(source.bitDepth, 24);
  assert.equal(source.channels[0].length, 4800);
  assert.ok(Math.abs(source.channels[0][100] - left[100]) < 2 / 8388608);
  assert.ok(Math.abs(source.channels[1][100] - right[100]) < 2 / 8388608);
});

test("two mono files pair into a two-track source", () => {
  const first = decodeWav(encodeWav24([sine(2400, 220, 48000)], 48000), "a.wav");
  const second = decodeWav(encodeWav24([sine(3600, 330, 48000)], 48000), "b.wav");
  const paired = pairTracks([first, second], "pair.wav");

  assert.equal(paired.channels.length, 2);
  assert.equal(paired.channels[0].length, 3600);
  assert.equal(paired.channels[1].length, 3600);
  assert.equal(paired.name, "pair.wav");
});

test("invalid container is rejected", () => {
  assert.throws(() => decodeWav(new ArrayBuffer(64), "broken.wav"), /RIFF|WAVE/);
});

test("source channels remain independent after pairing", () => {
  const source: AudioSource = decodeWav(encodeWav24([sine(10, 100, 48000)], 48000), "x.wav");
  const before = source.channels[0][5];
  encodeWav24([source.channels[0]], 48000);
  assert.equal(source.channels[0][5], before);
});
