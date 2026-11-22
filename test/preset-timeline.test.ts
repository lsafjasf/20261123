import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayoutEngine } from '../src/shared/layout.ts';
import { OcclusionMonitor } from '../src/shared/occlusion.ts';
import {
  DEFAULT_FRAME_RATE,
  defaultHudZones,
  defaultKeyframes,
} from '../src/shared/preset.ts';

test('full timeline yields the authored layout-change frame list', () => {
  const engine = new LayoutEngine(DEFAULT_FRAME_RATE, defaultKeyframes());
  const changeFrames: number[] = [];
  for (let frame = 0; frame < 600; frame += 1) {
    const event = engine.emitLayoutEvent(frame);
    if (event) changeFrames.push(event.frame);
  }
  assert.deepEqual(changeFrames, [0, 150, 330, 480]);
});

test('HUD occlusion edges fire and clear across the moving layout', () => {
  const engine = new LayoutEngine(DEFAULT_FRAME_RATE, defaultKeyframes());
  const monitor = new OcclusionMonitor(defaultHudZones());
  const fired = { alert: 0, clear: 0 };
  for (let frame = 0; frame < 600; frame += 1) {
    const sample = engine.sample(frame);
    const { events } = monitor.evaluate(
      sample.rects,
      frame,
      DEFAULT_FRAME_RATE,
    );
    for (const event of events) {
      if (event.type === 'occlusion') fired.alert += 1;
      if (event.type === 'occlusion-clear') fired.clear += 1;
    }
  }
  assert.ok(fired.alert > 0, 'expected at least one occlusion alert');
  assert.ok(
    fired.clear <= fired.alert,
    'every clear must correspond to a prior alert',
  );
});

test('all sampled panels stay inside the normalized canvas', () => {
  const engine = new LayoutEngine(DEFAULT_FRAME_RATE, defaultKeyframes());
  for (let frame = 0; frame < 600; frame += 1) {
    const { rects } = engine.sample(frame);
    for (const rect of Object.values(rects)) {
      assert.ok(rect.x >= -1e-9 && rect.y >= -1e-9);
      assert.ok(rect.x + rect.w <= 1 + 1e-9);
      assert.ok(rect.y + rect.h <= 1 + 1e-9);
    }
  }
});
