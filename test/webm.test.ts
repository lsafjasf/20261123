import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebmOpusMuxer } from '../src/browser/webm-muxer.ts';

test('WebM 头包含 EBML/docType=webm/Opus 轨道声明', () => {
  const muxer = new WebmOpusMuxer(48000, 2);
  const header = muxer.header(1.0);
  const text = new TextDecoder().decode(header);
  assert.ok(text.includes('webm'), 'docType 应为 webm');
  assert.ok(text.includes('A_OPUS'), '应声明 Opus 编码');
  assert.ok(text.includes('OpusHead'), '应含 OpusHead codec private');
  // EBML 魔数
  assert.deepEqual(
    [header[0], header[1], header[2], header[3]],
    [0x1a, 0x45, 0xdf, 0xa3],
  );
});

test('addChunk 首块带 Cluster 头，1 秒后滚动新簇，输出确定', () => {
  const a = new WebmOpusMuxer(48000, 2);
  const b = new WebmOpusMuxer(48000, 2);
  const chunks = [
    { data: new Uint8Array([1, 2, 3]), timestamp: 0, duration: 20000 },
    { data: new Uint8Array([4, 5, 6]), timestamp: 20000, duration: 20000 },
    { data: new Uint8Array([7, 8, 9]), timestamp: 1_020_000, duration: 20000 },
  ];
  const outA = chunks.map((c) => a.addChunk(c));
  const outB = chunks.map((c) => b.addChunk(c));
  outA.forEach((part, i) => assert.deepEqual(Array.from(part), Array.from(outB[i])));

  // 首块应包含 Cluster 元素 id 0x1f43b675
  const first = outA[0];
  assert.equal(first[0], 0x1f);
  assert.equal(first[1], 0x43);
  // 第三块跨越 1s，应再次出现新 Cluster 头
  const third = outA[2];
  assert.equal(third[0], 0x1f);
  assert.equal(third[1], 0x43);
  // 第二块只有 SimpleBlock(0xa3)，没有新簇头
  assert.equal(outA[1][0], 0xa3);
});

test('同输入两次封装字节完全一致', () => {
  const m1 = new WebmOpusMuxer(48000, 2);
  const m2 = new WebmOpusMuxer(48000, 2);
  const h1 = m1.header(2);
  const h2 = m2.header(2);
  assert.deepEqual(Array.from(h1), Array.from(h2));
  const chunk = { data: new Uint8Array(10).fill(0xab), timestamp: 0, duration: 20000 };
  assert.deepEqual(Array.from(m1.addChunk(chunk)), Array.from(m2.addChunk(chunk)));
});
