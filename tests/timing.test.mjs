import assert from "node:assert/strict";
import test from "node:test";
import { buildFrameSchedule, summarizeTiming } from "../public/js/core/timeline.js";

test("all emitted timestamps are strictly increasing over a long clip", () => {
  const schedule = buildFrameSchedule({
    sourceFps: 24,
    targetFps: 60,
    sourceFrameCount: 24 * 20
  });
  const timing = summarizeTiming(schedule, 60);
  assert.equal(timing.count, 1200);
  assert.equal(timing.ordered, true);
  assert.equal(timing.duplicateTimestamps, 0);
  assert.ok(timing.maxTimestampErrorUs <= 0.5);
  assert.equal(schedule[1].timestampUs - schedule[0].timestampUs, 16667);
});
