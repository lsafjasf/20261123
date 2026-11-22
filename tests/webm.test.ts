import { test } from 'node:test';
import assert from 'node:assert/strict';
import { muxWebM, type EncodedChunkLike } from '../src/shared/webm.ts';

function fakeChunks(n: number): EncodedChunkLike[] {
  const out: EncodedChunkLike[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      type: i % 30 === 0 ? 'key' : 'delta',
      timestamp: i * 33333, // 微秒，约 30fps
      duration: 33333,
      data: new Uint8Array([i & 0xff, 1, 2, 3]),
    });
  }
  return out;
}

test('WebM 封装：EBML 头与结构完整', () => {
  const buf = muxWebM(fakeChunks(90), { codec: 'V_VP9', width: 320, height: 240 });
  // EBML magic
  assert.deepEqual([...buf.slice(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  const text = Buffer.from(buf).toString('latin1');
  assert.ok(text.includes('webm'));
  assert.ok(text.includes('V_VP9'));
  assert.ok(text.includes('pad-video-sync'));
  // Segment ID 0x18538067 存在
  const segIdx = buf.indexOf(0x18);
  assert.ok(segIdx > 0);
  assert.equal(buf[segIdx + 1], 0x53);
  assert.equal(buf[segIdx + 2], 0x80);
  assert.equal(buf[segIdx + 3], 0x67);
});

test('WebM 封装：首块非关键帧报错', () => {
  const chunks = fakeChunks(10);
  chunks[0] = { ...chunks[0], type: 'delta' };
  assert.throws(() => muxWebM(chunks, { codec: 'V_VP9', width: 64, height: 64 }));
});

test('WebM 封装：时长写入 Info', () => {
  const chunks = fakeChunks(60); // 约 2s
  const buf = muxWebM(chunks, { codec: 'V_VP8', width: 64, height: 64 });
  // Duration 元素 ID 0x4489，8 字节 double
  let pos = -1;
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0x44 && buf[i + 1] === 0x89) { pos = i; break; }
  }
  assert.ok(pos > 0);
  assert.equal(buf[pos + 2], 0x88); // size=8
  const dv = new DataView(buf.buffer, buf.byteOffset + pos + 3, 8);
  const dur = dv.getFloat64(0);
  assert.ok(Math.abs(dur - 2000) < 40, `duration=${dur}`);
});
