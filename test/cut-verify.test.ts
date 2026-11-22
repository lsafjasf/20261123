import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cutEvent,
  decideCut,
  meanAbsoluteDifference,
} from '../src/shared/cut.ts';
import { compareSnapshots, type FrameSnapshot } from '../src/shared/verify.ts';

test('cut threshold and manifest event', () => {
  assert.equal(decideCut(0.1, 0.25).isCut, false);
  assert.equal(decideCut(0.4, 0.25).isCut, true);
  const event = cutEvent('cams', 120, 30, 0.5);
  assert.equal(event.type, 'cut');
  assert.equal(event.frame, 120);
  assert.match(event.detail, /layout position retained/);
});

test('mean absolute difference normalizes to 0..1', () => {
  const a = new Uint8ClampedArray([0, 0, 0, 0]);
  const b = new Uint8ClampedArray([255, 255, 255, 255]);
  assert.equal(meanAbsoluteDifference(a, b), 1);
  assert.equal(meanAbsoluteDifference(a, a), 0);
  assert.equal(meanAbsoluteDifference(a, new Uint8ClampedArray(2)), 1);
});

function snapshot(frame: number, fill: number): FrameSnapshot {
  const pixels = new Uint8ClampedArray(4 * 4);
  pixels.fill(fill);
  return { frame, pixels };
}

test('identical snapshots pass verification', () => {
  const preview = [snapshot(0, 10), snapshot(1, 20)];
  const exported = [snapshot(0, 10), snapshot(1, 20)];
  const result = compareSnapshots(preview, exported, 24);
  assert.equal(result.passed, true);
  assert.equal(result.comparedFrames, 2);
  assert.equal(result.maxChannelDelta, 0);
});

test('divergent frames fail with per-frame deltas', () => {
  const preview = [snapshot(0, 0), snapshot(1, 0)];
  const exported = [snapshot(0, 10), snapshot(1, 200)];
  const result = compareSnapshots(preview, exported, 24);
  assert.equal(result.passed, false);
  assert.equal(result.mismatchedFrames, 1);
  assert.equal(result.maxChannelDelta, 200);
});

test('missing exported frame counts as mismatch', () => {
  const result = compareSnapshots([snapshot(5, 0)], [], 24);
  assert.equal(result.passed, false);
  assert.equal(result.mismatchedFrames, 1);
});
