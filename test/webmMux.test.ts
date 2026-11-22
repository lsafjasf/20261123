import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebmMuxer } from '../src/client/webmMux.ts';

function findSubarray(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

test('initial segment starts with the EBML magic and declares webm/vp9', () => {
  const mux = new WebmMuxer(640, 360, 'V_VP9');
  const head = mux.initialSegment();
  assert.deepEqual([...head.slice(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  assert.ok(findSubarray(head, [0x18, 0x53, 0x80, 0x67]) > 0, 'Segment element present');
  assert.ok(findSubarray(head, [...new TextEncoder().encode('webm')]) > 0);
  assert.ok(findSubarray(head, [...new TextEncoder().encode('V_VP9')]) > 0);
  // dimensions
  assert.ok(findSubarray(head, [0xb0, 0x82, 0x02, 0x80]) > 0, 'PixelWidth 640');
  assert.ok(findSubarray(head, [0xba, 0x82, 0x01, 0x68]) > 0, 'PixelHeight 360');
});

test('frames become SimpleBlocks with cluster-relative timestamps', () => {
  const mux = new WebmMuxer(320, 240, 'V_VP9');
  mux.initialSegment();
  const payload = new Uint8Array([1, 2, 3, 4]);
  const first = mux.addFrame(payload, 0, true);
  // New cluster: Cluster id + unknown size + Timestamp element.
  assert.ok(findSubarray(first, [0x1f, 0x43, 0xb6, 0x75]) === 0);
  assert.ok(findSubarray(first, [0xe7, 0x84, 0, 0, 0, 0]) > 0, 'cluster Timestamp 0');
  // SimpleBlock: id, size, track 1 (0x81), rel ts 0, keyframe flag 0x80.
  const blockAt = findSubarray(first, [0xa3]);
  assert.ok(blockAt > 0);
  assert.equal(first[blockAt + 2], 0x81);
  assert.equal(first[blockAt + 5], 0x80, 'keyframe flag set');
  // Non-keyframe in the same cluster carries a relative timestamp.
  const second = mux.addFrame(payload, 41, false);
  const at = findSubarray(second, [0xa3]);
  assert.ok(at >= 0);
  assert.equal(second[at + 3] * 256 + second[at + 4], 41, 'relative timestamp 41 ms');
  assert.equal(second[at + 5], 0x00, 'no keyframe flag');
  // A keyframe opens a fresh cluster with a new absolute Timestamp.
  const third = mux.addFrame(payload, 2000, true);
  assert.ok(findSubarray(third, [0x1f, 0x43, 0xb6, 0x75]) === 0);
  assert.ok(findSubarray(third, [0xe7, 0x84, 0, 0, 0x07, 0xd0]) > 0, 'cluster Timestamp 2000');
});
