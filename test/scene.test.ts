import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sceneEvents,
  eventFrame,
  ballSim,
  doorAngle,
  walkerX,
  SCENE_DURATION,
  CREAK_START_T,
  DOOR_THUD_T,
} from '../src/shared/scene.ts';

test('scene events are deterministic, ordered, and inside the scene', () => {
  const a = sceneEvents();
  const b = sceneEvents();
  assert.deepEqual(a, b);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].t >= a[i - 1].t);
  for (const e of a) assert.ok(e.t >= 0 && e.t <= SCENE_DURATION);
});

test('walker produces 10 alternating footsteps', () => {
  const steps = sceneEvents().filter((e) => e.kind.startsWith('footstep'));
  assert.equal(steps.length, 10);
  assert.equal(steps[0].kind, 'footstep-l');
  assert.equal(steps[1].kind, 'footstep-r');
});

test('ball physics yields multiple impacts, ball stays on floor between', () => {
  const sim = ballSim();
  assert.ok(sim.impacts.length >= 3, `expected several bounces, got ${sim.impacts.length}`);
  for (const t of sim.impacts) {
    const h = sim.heightAt(t);
    assert.ok(h !== null && h < 0.01, `impact at ${t}s should be at floor level, got ${h}`);
  }
});

test('door only moves during the creak and rests after the thud', () => {
  assert.equal(doorAngle(CREAK_START_T - 0.5), 0);
  assert.ok(doorAngle(CREAK_START_T + 0.5) > 0);
  assert.equal(doorAngle(DOOR_THUD_T + 0.5), doorAngle(DOOR_THUD_T));
});

test('event frames track the event time within half a frame at any fps', () => {
  for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
    for (const e of sceneEvents()) {
      const f = eventFrame(e, fps);
      assert.ok(Number.isInteger(f));
      assert.ok(Math.abs(f / fps - e.t) <= 0.5 / fps + 1e-9, `${e.label} @ ${fps}fps`);
    }
  }
});

test('walker crosses the stage exactly during act 1', () => {
  assert.equal(walkerX(-1), 0);
  assert.equal(walkerX(0), 0);
  assert.equal(walkerX(2.5), 0.5);
  assert.equal(walkerX(5), 1);
  assert.equal(walkerX(6), 1);
});
