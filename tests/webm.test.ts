import { test } from "node:test";
import assert from "node:assert/strict";

import { WebmWriter } from "../src/core/muxer.ts";
import {
  EBML,
  buildCues,
  buildHeader,
  element,
  encodeId,
  encodeVintSize,
  simpleBlock,
} from "../src/core/webm.ts";

test("EBML id 与 VINT 尺寸编码符合规范字节", () => {
  assert.deepEqual(Array.from(encodeId(EBML.SimpleBlock)), [0xa3]);
  assert.deepEqual(Array.from(encodeVintSize(0)), [0x80]);
  assert.deepEqual(Array.from(encodeVintSize(126)), [0xfe]);
  // 127（全 1）是 VINT 保留未知值，普通尺寸 127 升级双字节。
  assert.deepEqual(Array.from(encodeVintSize(128)), [0x40, 0x80]);
  const el = element(0xa3, Uint8Array.of(1, 2, 3));
  assert.deepEqual(Array.from(el), [0xa3, 0x83, 1, 2, 3]);
});

test("simpleBlock 包含轨道、相对时间戳与关键帧标记", () => {
  const block = simpleBlock(1, 250, true, Uint8Array.of(9, 9));
  // a3 size(=6) 81 00 fa 80 09 09
  assert.deepEqual(Array.from(block), [0xa3, 0x86, 0x81, 0x00, 0xfa, 0x80, 9, 9]);
});

test("WebmWriter 输出含 EBML 头、Cluster 与 Cues 的完整字节", () => {
  const writer = new WebmWriter(
    { width: 320, height: 180, frameRate: 30 },
    { sampleRate: 48000, channels: 1, codecPrivate: Uint8Array.of(1, 2, 3) },
    200,
  );
  writer.start();
  const headerLen = writer.byteLength;
  for (let i = 0; i < 10; i++) {
    writer.addChunk({
      kind: "video",
      timestampUs: i * 33333,
      data: Uint8Array.of(i % 256),
      keyframe: i % 5 === 0,
    });
    writer.addChunk({
      kind: "audio",
      timestampUs: i * 20000,
      data: Uint8Array.of(100 + i),
      keyframe: true,
    });
  }
  const bytes = writer.finish();
  assert.ok(bytes.length > headerLen);
  // 文件以 EBML 头 1A 45 DF A3 开头，DocType 为 webm。
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes("webm"));
  assert.ok(text.includes("V_VP9"));
  assert.ok(text.includes("A_OPUS"));
  const cues = buildCues([{ timeMs: 0, clusterPosition: headerLen }]);
  assert.ok(cues.length > 0);
});
