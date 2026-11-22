import { test } from "node:test";
import assert from "node:assert/strict";
import { muxOpusWebm } from "../src/app/webm.ts";

test("webm muxer emits valid EBML structure", () => {
  const packets = [
    { data: new Uint8Array([1, 2, 3, 4]), timestampMs: 0 },
    { data: new Uint8Array([5, 6, 7]), timestampMs: 20 },
  ];
  const head = new Uint8Array(19);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1]); // OpusHead
  const out = muxOpusWebm(packets, 48000, 1, head);
  // EBML magic
  assert.deepEqual(Array.from(out.subarray(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
  const text = Buffer.from(out).toString("latin1");
  assert.ok(text.includes("webm"), "doc type");
  assert.ok(text.includes("A_OPUS"), "codec id");
  assert.ok(text.includes("OpusHead"), "codec private");
  // segment uses unknown-size vint
  const segAt = text.indexOf("\x18\x53\x80\x67");
  assert.ok(segAt > 0, "segment present");
  assert.deepEqual(
    Array.from(out.subarray(segAt + 4, segAt + 12)),
    [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    "unknown segment size",
  );
});
