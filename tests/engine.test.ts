import test from "node:test";
import assert from "node:assert/strict";
import { CAMERAS, type CameraId, type ChannelMetrics } from "../src/domain.ts";
import { RecommendationEngine } from "../src/engine.ts";

function channels(focus: CameraId, focusDb = -24, floorDb = -40, onset = 0.8): ChannelMetrics[] {
  return CAMERAS.map((camera) => ({
    camera: camera.id,
    energyDb: camera.id === focus ? focusDb : floorDb,
    onset: camera.id === focus ? onset : 0.02,
  }));
}

test("respects confirmation, minimum dwell, and switches once", () => {
  const engine = new RecommendationEngine(1, {
    minDwellMs: 2000,
    confirmMs: 500,
    hysteresisDb: 4,
    mode: "auto",
  });

  assert.equal(engine.tick(channels(3), 0).decision, null);
  assert.equal(engine.tick(channels(3), 400).decision, null);
  const blocked = engine.tick(channels(3), 1000);
  assert.equal(blocked.decision, null);
  assert.equal(blocked.snapshot.phase, "dwell");
  assert.equal(blocked.snapshot.dwellRemainingMs, 1000);

  const switched = engine.tick(channels(3), 2000);
  assert.ok(switched.decision);
  assert.equal(switched.decision.kind, "auto");
  assert.equal(switched.decision.from, 1);
  assert.equal(switched.decision.to, 3);
  assert.equal(engine.programCamera, 3);

  assert.equal(engine.tick(channels(3), 2400).decision, null);
});

test("ignores a short transient even when it has a strong onset", () => {
  const engine = new RecommendationEngine(1, {
    minDwellMs: 0,
    confirmMs: 650,
    hysteresisDb: 4,
    mode: "auto",
  });

  engine.tick(channels(1), 0);
  engine.tick(channels(4, -18, -42, 1), 100);
  engine.tick(channels(4, -18, -42, 1), 500);
  engine.tick(channels(1), 800);
  engine.tick(channels(1), 1200);
  assert.equal(engine.programCamera, 1);
});

test("hysteresis blocks a candidate that only slightly beats program", () => {
  const engine = new RecommendationEngine(1, {
    minDwellMs: 0,
    confirmMs: 100,
    hysteresisDb: 5,
    mode: "auto",
  });

  engine.tick(channels(2, -36, -40, 0), 0);
  engine.tick(channels(2, -36, -40, 0), 200);
  engine.tick(channels(2, -36, -40, 0), 400);
  assert.equal(engine.programCamera, 1);
});

test("requires the candidate to sustain an energy lead, not just a score spike", () => {
  const engine = new RecommendationEngine(1, {
    minDwellMs: 0,
    confirmMs: 100,
    hysteresisDb: 4,
    leaderMarginDb: 3,
    onsetBoost: 20,
    mode: "auto",
  });

  const spiky = channels(2, -26, -20, 1);
  spiky[0] = { camera: 1, energyDb: -21, onset: 0 };
  for (let t = 0; t <= 500; t += 100) {
    assert.equal(engine.tick(spiky, t).decision, null);
  }
  assert.equal(engine.programCamera, 1);
});

test("assist mode suggests without cutting and only prompts once", () => {
  const engine = new RecommendationEngine(1, {
    minDwellMs: 0,
    confirmMs: 100,
    hysteresisDb: 4,
    mode: "assist",
  });

  const first = engine.tick(channels(5), 0);
  const ready = engine.tick(channels(5), 200);
  const repeated = engine.tick(channels(5), 400);
  assert.equal(first.decision, null);
  assert.equal(ready.decision?.kind, "suggestion");
  assert.equal(ready.decision?.to, 5);
  assert.equal(repeated.decision, null);
  assert.equal(engine.programCamera, 1);
  assert.equal(engine.snapshot.phase, "ready");
});

test("manual takeover pauses automatic decisions and resets dwell", () => {
  const engine = new RecommendationEngine(1, {
    minDwellMs: 1800,
    confirmMs: 100,
    hysteresisDb: 4,
    mode: "auto",
  });

  engine.setPaused(true);
  for (let t = 0; t <= 2500; t += 250) {
    assert.equal(engine.tick(channels(3), t).decision, null);
  }
  engine.setPaused(false);
  engine.manualTake(2, 3000);
  assert.equal(engine.programCamera, 2);
  assert.equal(engine.tick(channels(4), 3200).decision, null);
  assert.equal(engine.tick(channels(4), 4900).decision?.to, 4);
});

test("auto decisions carry a compact audio-evidence frame", () => {
  const engine = new RecommendationEngine(1, {
    minDwellMs: 0,
    confirmMs: 50,
    hysteresisDb: 2,
    mode: "auto",
  });
  engine.tick(channels(6, -19, -45, 1), 0);
  const tick = engine.tick(channels(6, -19, -45, 1), 100);
  assert.ok(tick.decision);
  assert.equal(tick.decision.frame.leader, 6);
  assert.equal(tick.decision.frame.channels.length, 6);
  assert.ok(tick.decision.frame.leadMarginDb > 10);
  assert.match(tick.decision.reason, /迟滞/);
  assert.ok(tick.decision.onsetPeak >= 0.9);
  assert.ok(tick.decision.sustainedMs >= 50);
});
