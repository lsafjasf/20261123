import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebmMuxer, concat } from '../web/webmMuxer.ts';

test('build 产出以 EBML 头开头的完整 WebM', () => {
  const muxer = new WebmMuxer({ id: 1, kind: 'video', codec: 'vp9', width: 16, height: 8 });
  muxer.muxVideo({ data: new Uint8Array([1, 2, 3]), timestampMicros: 0, isKey: true });
  const out = muxer.build();
  assert.ok(out.length > 20);
  assert.deepEqual(Array.from(out.slice(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
});

test('build 包含定长 Segment 与 Tracks（无未知长度 0xff 占位）', () => {
  const muxer = new WebmMuxer({ id: 1, kind: 'video', codec: 'vp9', width: 3840, height: 2160 });
  muxer.muxVideo({ data: new Uint8Array([1]), timestampMicros: 0, isKey: true });
  const out = muxer.build();
  const hex = Array.from(out).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  assert.ok(hex.includes('18 53 80 67'), '应含 Segment 元素 ID');
  assert.ok(hex.includes('16 54 ae 6b'), '应含 Tracks 元素 ID');
  // 定长编码不应出现 8 字节保留长度占位
  assert.ok(!hex.includes('01 ff ff ff ff ff ff ff'));
  // Segment 声明长度应与实际字节吻合
  const segIdx = out.findIndex((_, i) =>
    out[i] === 0x18 && out[i + 1] === 0x53 && out[i + 2] === 0x80 && out[i + 3] === 0x67);
  const first = out[segIdx + 4];
  const lenBytes = Math.clz32(first) - 23; // 8 位中的前导零数 + 1
  let declared = first & (0xff >> lenBytes);
  for (let i = 1; i < lenBytes; i++) declared = declared * 256 + out[segIdx + 4 + i];
  assert.equal(declared, out.length - segIdx - 4 - lenBytes);
});

test('视频块写入：关键帧开 Cluster，增量帧复用', () => {
  const muxer = new WebmMuxer({ id: 1, kind: 'video', codec: 'vp9', width: 16, height: 8 });
  const key = muxer.muxVideo({ data: new Uint8Array([1, 2, 3]), timestampMicros: 0, isKey: true });
  const delta = muxer.muxVideo({ data: new Uint8Array([4, 5]), timestampMicros: 41000, isKey: false });
  const key2 = muxer.muxVideo({ data: new Uint8Array([6]), timestampMicros: 82000, isKey: true });
  // 关键帧分片以 Cluster ID 开头
  assert.deepEqual(Array.from(key.slice(0, 4)), [0x1f, 0x43, 0xb6, 0x75]);
  // 增量帧不含新 Cluster 头，直接是 SimpleBlock(0xa3)
  assert.equal(delta[0], 0xa3);
  assert.deepEqual(Array.from(key2.slice(0, 4)), [0x1f, 0x43, 0xb6, 0x75]);
  // SimpleBlock 内可找到原始负载
  assert.ok(key.includes(3));
});

test('音频轨道在 header 中生成且 muxAudio 不报错', () => {
  const muxer = new WebmMuxer(
    { id: 1, kind: 'video', codec: 'vp9', width: 16, height: 8 },
    { id: 2, kind: 'audio', codec: 'opus', sampleRate: 48000, channels: 2 },
  );
  muxer.muxVideo({ data: new Uint8Array([9]), timestampMicros: 0, isKey: true });
  const audio = muxer.muxAudio({ data: new Uint8Array([10, 11]), timestampMicros: 20000, isKey: false });
  assert.equal(audio[0], 0xa3);
  assert.ok(muxer.build().length > 0);
});

test('concat 拼接保持字节序', () => {
  const out = concat(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5]));
  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5]);
});

test('flush 可重复调用且幂等', () => {
  const muxer = new WebmMuxer({ id: 1, kind: 'video', codec: 'vp9', width: 8, height: 8 });
  muxer.muxVideo({ data: new Uint8Array([1]), timestampMicros: 0, isKey: true });
  muxer.flush();
  const again = muxer.flush();
  assert.equal(again.length, 0);
});
