import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWavPcm16, decodeWav } from "../src/shared/wav.ts";

test("wav pcm16 roundtrip", () => {
  const sr = 24000;
  const x = new Float32Array(sr / 10);
  for (let i = 0; i < x.length; i++) x[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / sr);
  const buf = encodeWavPcm16([x], sr);
  const dec = decodeWav(buf);
  assert.equal(dec.sampleRate, sr);
  assert.equal(dec.channels.length, 1);
  assert.equal(dec.channels[0].length, x.length);
  let maxErr = 0;
  for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(dec.channels[0][i] - x[i]));
  assert.ok(maxErr < 2 / 32768 + 1e-6, `quantization error ${maxErr}`);
});

test("decodeWav rejects non-wav", () => {
  assert.throws(() => decodeWav(new ArrayBuffer(64)));
});
