import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebMMuxer } from '../src/client/webm-muxer.ts';

class FakeChunk {
  readonly byteLength: number;
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number;
  private readonly payload: Uint8Array;

  constructor(
    payload: Uint8Array,
    type: 'key' | 'delta',
    timestamp: number,
    duration: number,
  ) {
    this.payload = payload;
    this.type = type;
    this.timestamp = timestamp;
    this.duration = duration;
    this.byteLength = payload.length;
  }
  copyTo(target: Uint8Array): void {
    target.set(this.payload);
  }
}

test('muxer emits a well-formed WebM blob with tracks and cues', async () => {
  const muxer = new WebMMuxer();
  muxer.addTrack({ number: 1, codecId: 'V_VP9', width: 320, height: 180 });
  muxer.addTrack({
    number: 2,
    codecId: 'A_OPUS',
    sampleRate: 48000,
    channels: 2,
  });

  for (let frame = 0; frame < 10; frame += 1) {
    const chunk = new FakeChunk(
      new Uint8Array([1, 2, 3, 4, frame]),
      frame % 5 === 0 ? 'key' : 'delta',
      frame * 33333,
      33333,
    );
    muxer.addVideoChunk(1, chunk as unknown as EncodedVideoChunk, undefined);
    const audio = new FakeChunk(
      new Uint8Array([9, 8, 7]),
      'key',
      frame * 20000,
      20000,
    );
    muxer.addAudioChunk(2, audio as unknown as EncodedAudioChunk);
  }

  const blob = muxer.finalize();
  assert.equal(blob.type, 'video/webm');
  assert.ok(blob.size > 200);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hex = [...bytes.slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  assert.equal(hex, '1a45dfa3');

  const text = new TextDecoder().decode(bytes);
  assert.match(text, /webm/);
  assert.match(text, /V_VP9/);
  assert.match(text, /A_OPUS/);
  assert.ok(text.includes('Cues') || bytes.includes(0x1c));
});
