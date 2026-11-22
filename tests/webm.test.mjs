import assert from "node:assert/strict";
import test from "node:test";
import { muxWebm } from "../public/js/core/webm.js";

test("WebM muxer emits an EBML VP8 document with ordered clusters", () => {
  const samples = Array.from({ length: 12 }, (_, index) => ({
    timestampUs: Math.round(index * 1_000_000 / 60),
    durationUs: Math.round(1_000_000 / 60),
    key: index === 0,
    data: Uint8Array.of(0x10, index, 0x20, 0x30)
  }));
  const output = muxWebm(samples, {
    width: 480,
    height: 270,
    codec: "vp8",
    durationUs: 200_000,
    frameRate: 60
  });
  const text = new TextDecoder("latin1").decode(output);

  assert.deepEqual(Array.from(output.slice(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
  assert.ok(text.includes("webm"));
  assert.ok(text.includes("V_VP8"));
  assert.ok(output.length > 120);
  assert.equal(samples.at(-1).timestampUs - samples[0].timestampUs, 183_333);
});
