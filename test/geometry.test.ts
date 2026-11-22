import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  coveredFraction,
  intersectRect,
  lerp,
  lerpRect,
  rectArea,
  rectsEqual,
  smoothstep,
} from '../src/shared/geometry.ts';

test('clamp and lerp behave at boundaries', () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(20, 0, 10), 10);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(lerp(0, 10, 0.5), 5);
});

test('smoothstep is monotonic with eased endpoints', () => {
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  assert.ok(smoothstep(0.25) < 0.25);
  assert.ok(smoothstep(0.75) > 0.75);
  assert.ok(smoothstep(0.5) === 0.5);
});

test('rect intersection and area math', () => {
  const overlap = intersectRect(
    { x: 0, y: 0, w: 0.5, h: 0.5 },
    { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  );
  assert.deepEqual(overlap, { x: 0.25, y: 0.25, w: 0.25, h: 0.25 });
  assert.equal(rectArea(overlap), 0.0625);
  assert.equal(
    intersectRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }),
    null,
  );
});

test('coveredFraction reports relative occlusion', () => {
  const zone = { x: 0, y: 0, w: 1, h: 1 };
  const half = { x: 0.5, y: 0, w: 0.5, h: 1 };
  assert.equal(coveredFraction(zone, half), 0.5);
  assert.equal(
    coveredFraction(zone, { x: 2, y: 2, w: 1, h: 1 }),
    0,
  );
});

test('lerpRect and rectsEqual', () => {
  const a = { x: 0, y: 0, w: 1, h: 1 };
  const b = { x: 10, y: 20, w: 2, h: 4 };
  assert.deepEqual(lerpRect(a, b, 0.5), { x: 5, y: 10, w: 1.5, h: 2.5 });
  assert.equal(rectsEqual(a, { ...a }), true);
});
