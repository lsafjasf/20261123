import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OcclusionMonitor } from '../src/shared/occlusion.ts';
import type { HudZone, PanelRects } from '../src/shared/types.ts';

const zones: HudZone[] = [
  {
    id: 'scoreboard',
    label: 'Top scoreboard',
    rect: { x: 0, y: 0, w: 0.5, h: 0.2 },
    tolerance: 0.1,
  },
];

function rects(cams: [number, number, number, number]): PanelRects {
  return {
    main: { x: 0, y: 0, w: 1, h: 1 },
    cams: { x: cams[0], y: cams[1], w: cams[2], h: cams[3] },
    map: { x: 0, y: 0, w: 0.01, h: 0.01 },
  };
}

test('clear when no occluder overlaps the HUD', () => {
  const monitor = new OcclusionMonitor(zones);
  const { results, events } = monitor.evaluate(
    rects([0.8, 0.8, 0.2, 0.2]),
    0,
    30,
  );
  assert.equal(results[0]?.level, 'clear');
  assert.equal(events.length, 0);
});

test('partial occlusion above tolerance emits a single edge event', () => {
  const monitor = new OcclusionMonitor(zones);
  const first = monitor.evaluate(rects([0.25, 0, 0.5, 0.2]), 5, 30);
  assert.equal(first.results[0]?.level, 'partial');
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0]?.type, 'occlusion');
  const again = monitor.evaluate(rects([0.25, 0, 0.5, 0.2]), 6, 30);
  assert.equal(again.events.length, 0);
});

test('blocked then clear transitions are both recorded', () => {
  const monitor = new OcclusionMonitor(zones);
  monitor.evaluate(rects([0, 0, 1, 1]), 1, 30);
  assert.equal(monitor.currentLevels.get('scoreboard'), 'blocked');
  const cleared = monitor.evaluate(rects([0.9, 0.9, 0.1, 0.1]), 9, 30);
  assert.equal(cleared.events[0]?.type, 'occlusion-clear');
  assert.equal(cleared.events[0]?.frame, 9);
});

test('HUD coordinates track the moving main panel', () => {
  const monitor = new OcclusionMonitor(zones);
  const moved: PanelRects = {
    main: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    cams: { x: 0.65, y: 0.5, w: 0.25, h: 0.1 },
    map: { x: 0, y: 0, w: 0.01, h: 0.01 },
  };
  const { results } = monitor.evaluate(moved, 0, 30);
  const covered = results[0]?.covered ?? 0;
  assert.ok(covered > 0.3 && covered < 0.5, `covered=${covered}`);
});
