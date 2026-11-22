import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpusHead,
  buildSimpleBlock,
  WebmMuxer,
} from '../src/client/mux/webm-muxer.ts';
import { encodeVint, vintLength } from '../src/client/mux/ebml.ts';

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

test('OpusHead 魔数与字段', () => {
  const head = buildOpusHead({ sampleRate: 48000, channels: 1 });
  assert.equal(new TextDecoder().decode(head.subarray(0, 8)), 'OpusHead');
  assert.equal(head[8], 1);
  assert.equal(head[9], 1);
  assert.equal(
    new DataView(head.buffer).getUint32(12, true),
    48000,
  );
});

test('VINT 宽度选择与长度标记位', () => {
  assert.equal(vintLength(0), 1);
  assert.equal(vintLength(100), 1);
  assert.equal(vintLength(126), 2);
  const one = encodeVint(2);
  assert.equal(one.length, 1);
  assert.equal(one[0], 0x82);
  const two = encodeVint(200);
  assert.equal(two.length, 2);
  assert.ok((two[0] & 0x40) !== 0);
});

test('初始化分片包含 EBML 头与音轨', () => {
  const muxer = new WebmMuxer({ sampleRate: 48000, channels: 1 });
  const init = muxer.initializationSegment();
  const hex = Array.from(init.subarray(0, 4))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  assert.equal(hex, '1a 45 df a3');
  assert.ok(contains(init, new TextEncoder().encode('webm')));
  assert.ok(contains(init, new TextEncoder().encode('A_OPUS')));
});

test('首个包开启 Cluster，后续包复用同一 Cluster', () => {
  const muxer = new WebmMuxer({ sampleRate: 48000, channels: 1 });
  muxer.initializationSegment();
  const first = muxer.appendPacket({
    data: new Uint8Array([0xaa, 0xbb]),
    timestampMs: 0,
    keyframe: true,
  });
  assert.ok(first.subarray(0, 4).every((b, i) => b === [0x1f, 0x43, 0xb6, 0x75][i]));
  const second = muxer.appendPacket({
    data: new Uint8Array([0xcc]),
    timestampMs: 20,
    keyframe: false,
  });
  assert.notDeepEqual(
    Array.from(second.subarray(0, 4)),
    [0x1f, 0x43, 0xb6, 0x75],
  );
});

test('超过 500ms 切换到新 Cluster', () => {
  const muxer = new WebmMuxer({ sampleRate: 48000, channels: 1 });
  muxer.initializationSegment();
  muxer.appendPacket({
    data: new Uint8Array([1]),
    timestampMs: 0,
    keyframe: true,
  });
  const next = muxer.appendPacket({
    data: new Uint8Array([2]),
    timestampMs: 600,
    keyframe: true,
  });
  assert.deepEqual(Array.from(next.subarray(0, 4)), [
    0x1f,
    0x43,
    0xb6,
    0x75,
  ]);
});

test('SimpleBlock 结构正确', () => {
  const block = buildSimpleBlock(1, 120, true, new Uint8Array([1, 2, 3]));
  assert.equal(block[0], 0xa3);
  const bodyStart = 2;
  assert.equal(block[bodyStart], 0x81);
  assert.equal(block[bodyStart + 1], 0x00);
  assert.equal(block[bodyStart + 2], 120);
  assert.equal(block[bodyStart + 3], 0x80);
});
