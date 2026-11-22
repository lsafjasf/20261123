import { test } from "node:test";
import assert from "node:assert/strict";
import { demuxWebm } from "../src/media/ebml.ts";
import { buildMinimalWebm } from "./helpers/webm.ts";

test("解封装结果包含全部包，且关键帧标记正确", () => {
  const bytes = buildMinimalWebm();
  const result = demuxWebm(bytes.buffer.slice(bytes.byteOffset));
  assert.equal(result.packets.length, 3);
  assert.equal(result.packets[0].keyframe, true);
  assert.equal(result.packets[1].keyframe, false);
  assert.ok(result.durationMs >= 0);
});

test("空输入返回空轨道与空包列表而不抛错", () => {
  const result = demuxWebm(new ArrayBuffer(0));
  assert.deepEqual(result.tracks, []);
  assert.deepEqual(result.packets, []);
});
