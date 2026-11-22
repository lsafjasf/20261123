import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayoutEngine } from '../src/shared/layout.ts';
import type { LayoutKeyframe, PanelRects } from '../src/shared/types.ts';

function rects(main: [number, number, number, number]): PanelRects {
  const toRect = (v: [number, number, number, number]) => ({
    x: v[0],
    y: v[1],
    w: v[2],
    h: v[3],
  });
  return {
    main: toRect(main),
    cams: toRect([0, 0, 0.2, 0.2]),
    map: toRect([0, 0, 0.1, 0.1]),
  };
}

function keyframes(): LayoutKeyframe[] {
  return [
    { frame: 0, label: 'a', rects: rects([0, 0, 1, 1]) },
    { frame: 100, label: 'b', rects: rects([0.5, 0.5, 0.5, 0.5]) },
    { frame: 200, label: 'c', rects: rects([0.2, 0.2, 0.8, 0.8]) },
  ];
}

test('requires at least one keyframe and valid frame rate', () => {
  assert.throws(() => new LayoutEngine(30, []));
  assert.throws(() => new LayoutEngine(0, keyframes()));
});

test('holds first keyframe before any transition', () => {
  const engine = new LayoutEngine(30, keyframes());
  const sample = engine.sample(0);
  assert.equal(sample.transitioning, false);
  assert.equal(sample.segmentIndex, 0);
  assert.deepEqual(sample.rects.main, { x: 0, y: 0, w: 1, h: 1 });
});

test('smoothly interpolates between keyframes', () => {
  const engine = new LayoutEngine(30, keyframes());
  const mid = engine.sample(50);
  assert.equal(mid.transitioning, true);
  assert.equal(mid.segmentIndex, 0);
  // smoothstep(0.5) = 0.5, so linear midpoint values apply
  assert.equal(mid.rects.main.x, 0.25);
  assert.equal(mid.rects.main.w, 0.75);

  const eased = engine.sample(25);
  const expected = 0 * (1 - 0.15625) + 0.5 * 0.15625;
  assert.ok(Math.abs(eased.rects.main.x - expected) < 1e-9);
});

test('lands exactly on later keyframes and reports segments', () => {
  const engine = new LayoutEngine(30, keyframes());
  const atB = engine.sample(100);
  assert.equal(atB.transitioning, false);
  assert.equal(atB.segmentIndex, 1);
  assert.deepEqual(atB.rects.main, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.equal(engine.segments.length, 3);
});

test('layout events are edge-triggered on segment change only', () => {
  const engine = new LayoutEngine(30, keyframes());
  const initial = engine.emitLayoutEvent(0);
  assert.ok(initial);
  assert.equal(initial?.frame, 0);
  assert.equal(engine.emitLayoutEvent(10), null);
  assert.equal(engine.emitLayoutEvent(99), null);
  const changed = engine.emitLayoutEvent(100);
  assert.ok(changed);
  assert.equal(changed?.type, 'layout-change');
  assert.equal(changed?.frame, 100);
  assert.equal(engine.emitLayoutEvent(101), null);
});

test('manual upsert inserts and replaces without resetting head', () => {
  const engine = new LayoutEngine(30, keyframes());
  engine.upsertKeyframe({
    frame: 50,
    label: 'manual',
    rects: rects([0.1, 0.1, 0.9, 0.9]),
  });
  assert.equal(engine.timeline.length, 4);
  engine.upsertKeyframe({
    frame: 50,
    label: 'manual-2',
    rects: rects([0.11, 0.11, 0.9, 0.9]),
  });
  assert.equal(engine.timeline.length, 4);
  assert.equal(engine.sample(50).rects.main.x, 0.11);
});

test('clampRect keeps panels inside the canvas', () => {
  const clamped = LayoutEngine.clampRect({
    x: 0.95,
    y: 0.95,
    w: 0.5,
    h: 0.5,
  });
  assert.ok(clamped.x + clamped.w <= 1 + 1e-9);
  assert.ok(clamped.y + clamped.h <= 1 + 1e-9);
});
