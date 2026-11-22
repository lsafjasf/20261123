import { test } from "node:test";
import assert from "node:assert/strict";
import { stft, istft } from "../src/dsp/stft.ts";
import { convolve } from "../src/dsp/fft.ts";
import { encodeWav, decodeWav } from "../src/dsp/wav.ts";
import { mulberry32 } from "../src/dsp/synth.ts";

test("stft/istft roundtrip is near-perfect (COLA)", () => {
  const sr = 16000;
  const n = sr;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr) + 0.2 * Math.sin((2 * Math.PI * 1237 * i) / sr);
  }
  const spec = stft(x, 1024, 256, sr);
  const y = istft(spec, n);
  let err = 0;
  let ref = 0;
  for (let i = 512; i < n - 512; i++) {
    err += (x[i] - y[i]) ** 2;
    ref += x[i] * x[i];
  }
  assert.ok(err / ref < 1e-10, `relative reconstruction error ${err / ref}`);
});

test("fft convolve matches direct convolution", () => {
  const rand = mulberry32(3);
  const a = Float32Array.from({ length: 300 }, () => rand() * 2 - 1);
  const b = Float32Array.from({ length: 120 }, () => rand() * 2 - 1);
  const fast = convolve(a, b);
  assert.equal(fast.length, a.length + b.length - 1);
  let maxErr = 0;
  for (let i = 0; i < fast.length; i++) {
    let direct = 0;
    for (let j = 0; j < b.length; j++) {
      const k = i - j;
      if (k >= 0 && k < a.length) direct += a[k] * b[j];
    }
    maxErr = Math.max(maxErr, Math.abs(direct - fast[i]));
  }
  assert.ok(maxErr < 1e-4, `max conv error ${maxErr}`);
});

test("wav encode/decode roundtrip (PCM16)", () => {
  const sr = 16000;
  const x = Float32Array.from({ length: 4000 }, (_, i) =>
    0.6 * Math.sin((2 * Math.PI * 220 * i) / sr));
  const buf = encodeWav(x, sr);
  const dec = decodeWav(buf);
  assert.equal(dec.sampleRate, sr);
  assert.equal(dec.samples.length, x.length);
  let maxErr = 0;
  for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(x[i] - dec.samples[i]));
  assert.ok(maxErr < 2 / 32768 + 1e-6, `max pcm error ${maxErr}`);
});
