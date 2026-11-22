import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentSpeech } from "../src/dsp/segment.ts";
import { synthVoice } from "../src/dsp/synth.ts";
import { rmsDb } from "../src/dsp/metrics.ts";

test("segmentation covers the speech region", () => {
  const sr = 16000;
  const { samples, speechEndSec } = synthVoice(sr);
  const segs = segmentSpeech(samples, sr);
  assert.ok(segs.length >= 1 && segs.length <= 4, `segments: ${segs.length}`);
  assert.ok(segs[0].startSec < 0.2, `first start ${segs[0].startSec}`);
  const lastEnd = segs[segs.length - 1].endSec;
  assert.ok(Math.abs(lastEnd - speechEndSec) < 0.4, `last end ${lastEnd} vs ${speechEndSec}`);
  // segments actually contain the loud material
  const inSeg = rmsDb(samples, Math.floor(segs[0].startSec * sr),
    Math.floor(Math.min(segs[0].endSec, segs[0].startSec + 0.5) * sr));
  assert.ok(inSeg > -40, `segment level ${inSeg.toFixed(1)} dB`);
});

test("silence yields no segments", () => {
  const segs = segmentSpeech(new Float32Array(16000), 16000);
  assert.equal(segs.length, 0);
});
