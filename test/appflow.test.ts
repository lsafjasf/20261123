// Integration smoke test mirroring the UI data flow: load demo material,
// segment into sentences, process with per-sentence strengths (one bypassed),
// verify export codecs accept the result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeWav, encodeWav } from "../src/dsp/wav.ts";
import { segmentSpeech } from "../src/dsp/segment.ts";
import { dereverb } from "../src/dsp/dereverb.ts";
import { muxOpusWebm } from "../src/app/webm.ts";
import { tailRatioDb } from "../src/dsp/metrics.ts";

test("UI flow: load -> segment -> per-sentence process -> export", () => {
  const buf = readFileSync("public/demo-interview.wav");
  const { samples, sampleRate } = decodeWav(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  const segs = segmentSpeech(samples, sampleRate);
  assert.ok(segs.length >= 1, "found sentence segments");
  const controls = segs.map((s, i) => ({
    ...s,
    strength: 0.85,
    bypass: i === 0, // first sentence bypassed by the "user"
  }));
  const result = dereverb(samples, {
    sampleRate,
    t60: 0.8,
    strength: (t) => {
      for (const c of controls) {
        if (t >= c.startSec && t < c.endSec) return c.bypass ? 0 : c.strength;
      }
      return 0.85;
    },
  });
  assert.equal(result.output.length, samples.length);
  assert.equal(result.residual.length, samples.length);
  // bypassed first sentence stays close to the input
  const n = Math.floor(Math.min(controls[0].endSec - 0.1, controls[0].startSec + 1) * sampleRate);
  const off = Math.floor(controls[0].startSec * sampleRate);
  let maxDiff = 0;
  for (let i = 0; i < n; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(samples[off + i] - result.output[off + i]));
  }
  assert.ok(maxDiff < 0.02, `bypassed sentence max diff ${maxDiff}`);
  // tail still suppressed overall
  const speechEnd = controls[controls.length - 1].endSec;
  const before = tailRatioDb(samples, sampleRate, speechEnd);
  const after = tailRatioDb(result.output, sampleRate, speechEnd);
  assert.ok(before - after > 4, `tail reduced ${(before - after).toFixed(1)} dB`);
  // export codecs
  const wav = encodeWav(result.output, sampleRate);
  assert.ok(wav.byteLength > 44);
  const webm = muxOpusWebm(
    [{ data: new Uint8Array([0xf8, 0xff, 0xfe]), timestampMs: 0 }],
    sampleRate, 1, new Uint8Array(19),
  );
  assert.ok(webm.length > 100);
});
