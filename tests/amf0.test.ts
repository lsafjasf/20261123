import assert from "node:assert/strict";
import test from "node:test";
import { decodeAmf0All, encodeAmf0 } from "../src/amf0.ts";

test("AMF0 command round-trips object properties", () => {
  const values = [
    "onStatus",
    0,
    null,
    { level: "status", code: "NetStream.Publish.Start", description: "LAN relay ready" },
  ] as const;
  const encoded = encodeAmf0([...values]);
  assert.deepEqual(decodeAmf0All(encoded), values);
});

test("AMF0 decodes ffmpeg-style connect object", () => {
  const encoded = encodeAmf0([
    "connect",
    1,
    { app: "live", type: "nonprivate", flashVer: "FMLE/3.0", tcUrl: "rtmp://127.0.0.1/live" },
  ]);
  const decoded = decodeAmf0All(encoded);
  assert.equal(decoded[0], "connect");
  assert.deepEqual(decoded[2], {
    app: "live",
    type: "nonprivate",
    flashVer: "FMLE/3.0",
    tcUrl: "rtmp://127.0.0.1/live",
  });
});
