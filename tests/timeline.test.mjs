import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFrameSchedule,
  sourceTimeForEntry,
  summarizeTiming
} from "../public/js/core/timeline.js";

test("24 to 60 fps schedule keeps exact cadence and order", () => {
  const schedule = buildFrameSchedule({
    sourceFps: 24,
    targetFps: 60,
    sourceFrameCount: 240
  });
  const timing = summarizeTiming(schedule, 60);

  assert.equal(schedule.length, 600);
  assert.equal(timing.ordered, true);
  assert.equal(timing.duplicateTimestamps, 0);
  assert.ok(Math.abs(timing.averageIntervalMs - 1000 / 60) < 0.0005);
  assert.ok(timing.jitterMs <= 0.0011);
  assert.ok(timing.maxTimestampErrorUs <= 0.5);

  for (let index = 1; index < schedule.length; index += 1) {
    assert.ok(schedule[index].timestampUs > schedule[index - 1].timestampUs);
    assert.ok(schedule[index].sourceIndex >= schedule[index - 1].sourceIndex);
    assert.ok(schedule[index].sourcePhase >= 0 && schedule[index].sourcePhase < 1);
  }
});

test("source phase follows the 24 to 60 rational pattern", () => {
  const schedule = buildFrameSchedule({
    sourceFps: 24,
    targetFps: 60,
    sourceFrameCount: 48
  });
  const expected = [
    [0, 0],
    [0, 0.4],
    [0, 0.8],
    [1, 0.2],
    [1, 0.6],
    [2, 0]
  ];

  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(schedule[index].sourceIndex, expected[index][0]);
    assert.ok(Math.abs(schedule[index].sourcePhase - expected[index][1]) < 1e-9);
  }
  assert.equal(sourceTimeForEntry(schedule[4], 24), schedule[4].timeSec);
});

test("schedule clamps the final hold frame without reordering", () => {
  const schedule = buildFrameSchedule({
    sourceFps: 24,
    targetFps: 60,
    sourceFrameCount: 25
  });
  const last = schedule.at(-1);
  assert.ok(last);
  assert.ok(last.sourceIndex <= 24);
  assert.ok(last.nextSourceIndex <= 24);
  assert.equal(last.sourceIndex, last.nextSourceIndex);
  assert.equal(last.sourcePhase, 0);
});
