import { test } from "node:test";
import assert from "node:assert/strict";
import { demuxWebm, webmCodecString } from "../src/media/ebml.ts";
import { buildMinimalWebm } from "./helpers/webm.ts";

test("demuxWebm 解析轨道、时间戳、关键帧与 codecPrivate", () => {
  const bytes = buildMinimalWebm();
  const result = demuxWebm(bytes.buffer.slice(bytes.byteOffset));
  assert.equal(result.tracks.length, 2);
  assert.equal(result.tracks[0].number, 1);
  assert.equal(result.tracks[1].number, 2);
  assert.equal(result.tracks[0].codecId, "V_VP9");
  assert.equal(result.tracks[0].type, "video");
  assert.deepEqual(Array.from(result.tracks[0].codecPrivate ?? []), [1, 2, 3, 4]);
  assert.equal(result.tracks[1].type, "audio");
  assert.equal(result.packets.length, 3);
  assert.equal(result.packets[0].track, 1);
  assert.equal(result.packets[0].keyframe, true);
  assert.equal(result.packets[1].keyframe, false);
  assert.equal(result.packets[1].timestampUs, 33_000);
  assert.equal(result.packets[2].track, 2);
  assert.equal(result.durationMs, 1000);
});

test("webmCodecString 映射到 WebCodecs/MSE 可识别字符串", () => {
  const bytes = buildMinimalWebm();
  const result = demuxWebm(bytes.buffer.slice(bytes.byteOffset));
  assert.equal(webmCodecString(result.tracks[0]), "vp09.00.10.08");
  assert.equal(webmCodecString(result.tracks[1]), "opus");
});
