import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameToSample,
  sampleToFrame,
  formatTimecode,
  FRAME_RATES,
} from '../src/shared/timebase.ts';

test('integer frame rates land on exact sample boundaries', () => {
  // 24 fps @ 48 kHz: every frame is exactly 2000 samples.
  assert.equal(frameToSample(0, { num: 24, den: 1 }, 48000), 0);
  assert.equal(frameToSample(1, { num: 24, den: 1 }, 48000), 2000);
  assert.equal(frameToSample(1000, { num: 24, den: 1 }, 48000), 2_000_000);
  // 30 fps @ 44.1 kHz: 1470 samples per frame.
  assert.equal(frameToSample(7, { num: 30, den: 1 }, 44100), 10290);
});

test('NTSC pull-down rates use exact rational math', () => {
  const ntsc = { num: 30000, den: 1001 };
  // Frame 1001 at 30000/1001 fps @ 48kHz: 1603201.6 -> first sample is 1603202.
  assert.equal(frameToSample(1001, ntsc, 48000), 1_603_202);
  // Frame 1: 48000 * 1001 / 30000 = 1601.6 -> first sample of frame is 1602.
  assert.equal(frameToSample(1, ntsc, 48000), 1602);
  // 23.976: frame 1 -> 48000 * 1001 / 24000 = 2002 exactly.
  assert.equal(frameToSample(1, { num: 24000, den: 1001 }, 48000), 2002);
});

test('rounding is drift-free over long timelines', () => {
  // 30000 frames at 29.97 fps = exactly 1001 s = 48_048_000 samples.
  assert.equal(frameToSample(30000, { num: 30000, den: 1001 }, 48000), 48_048_000);
  // One hour (107892 frames) = 172799827.2 samples -> ceil, no float drift.
  assert.equal(frameToSample(107892, { num: 30000, den: 1001 }, 48000), 172_799_828);
});

test('negative frames round symmetrically', () => {
  assert.equal(frameToSample(-1, { num: 24, den: 1 }, 48000), -2000);
  // ceil(-1601.6) = -1601: the first sample belonging to frame -1.
  assert.equal(frameToSample(-1, { num: 30000, den: 1001 }, 48000), -1601);
});

test('sampleToFrame inverts frameToSample at frame starts', () => {
  for (const { rate } of FRAME_RATES) {
    for (const frame of [0, 1, 2, 59, 1000, 107892]) {
      const s = frameToSample(frame, rate, 48000);
      assert.equal(sampleToFrame(s, rate, 48000), frame, `${rate.num}/${rate.den} frame ${frame}`);
    }
  }
});

test('rejects non-integer frames and bad rates', () => {
  assert.throws(() => frameToSample(1.5, { num: 24, den: 1 }, 48000), RangeError);
  assert.throws(() => frameToSample(1, { num: 0, den: 1 }, 48000), RangeError);
});

test('timecode display', () => {
  assert.equal(formatTimecode(0, { num: 24, den: 1 }), '00:00:00:00');
  assert.equal(formatTimecode(24 * 3600 + 61 * 24 + 3, { num: 24, den: 1 }), '01:01:01:03');
});
