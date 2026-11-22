import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  advanceMainline,
  chooseOption,
  createInitialState,
  evaluateDecisionReadiness,
  finishBranch,
  getDecisionPreloadIds,
  returnToDecision,
  type PlayerState,
  type PreloadMap,
} from "../src/core/engine.ts";
import {
  getDecisionAt,
  getMainlineDurationMs,
  getMainlinePlacements,
  getPlacementAt,
  normalizeManifest,
} from "../src/core/manifest.ts";
import type { BranchManifest } from "../src/core/types.ts";
import { validateManifest } from "../src/core/validation.ts";

const demo = normalizeManifest(
  JSON.parse(
    await readFile(new URL("../data/demo-manifest.json", import.meta.url), "utf8"),
  ),
);

function readyPreloads(manifest: BranchManifest): PreloadMap {
  const decision = manifest.decisions[0];
  assert.ok(decision);
  return Object.fromEntries(
    getDecisionPreloadIds(manifest, decision).map((id) => [id, "ready"]),
  );
}

function playingAt(timeMs: number): PlayerState {
  return { ...createInitialState(), status: "playing", mainTimeMs: timeMs };
}

test("demo manifest is valid and exposes editable decision ranges", () => {
  const validation = validateManifest(demo);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(demo.segments.length, 5);
  assert.equal(getMainlineDurationMs(demo), 18_400);
  assert.equal(demo.decisions[0]?.timelineStartMs, 4_200);
  assert.equal(demo.decisions[0]?.pauseAtMs, 5_000);
  assert.equal(demo.decisions[0]?.options[0]?.targetSegmentId, "seg_check");
  assert.equal(demo.decisions[0]?.options[0]?.returnToMs, 6_400);
});

test("mainline clips resolve to deterministic project time", () => {
  const placements = getMainlinePlacements(demo);
  assert.deepEqual(
    placements.map((placement) => [placement.startMs, placement.endMs]),
    [
      [0, 6_400],
      [6_400, 14_400],
      [14_400, 18_400],
    ],
  );
  assert.equal(getPlacementAt(demo, 0)?.segment.id, "seg_intro");
  assert.equal(getPlacementAt(demo, 6_400)?.segment.id, "seg_continue");
  assert.equal(getPlacementAt(demo, 18_400)?.segment.id, "seg_debrief");
  assert.equal(getDecisionAt(demo, 5_000)?.id, "decision_breathing");
  assert.equal(getDecisionAt(demo, 6_001), undefined);
});

test("mainline playback pauses exactly at the configured choice point", () => {
  const state = advanceMainline(demo, playingAt(4_100), 1_200);
  assert.equal(state.status, "choice");
  assert.equal(state.mode, "main");
  assert.equal(state.mainTimeMs, 5_000);
  assert.equal(state.activeDecisionId, "decision_breathing");
});

test("preload failure blocks option entry without mutating playback", () => {
  const decision = demo.decisions[0];
  assert.ok(decision);
  const preloads = readyPreloads(demo);
  preloads.seg_move = "failed";
  const state: PlayerState = {
    ...createInitialState(),
    status: "choice",
    mainTimeMs: 5_000,
    activeDecisionId: decision.id,
  };
  const readiness = evaluateDecisionReadiness(demo, decision, preloads);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockers, [
    { segmentId: "seg_move", status: "failed" },
  ]);
  const result = chooseOption(
    demo,
    state,
    decision.id,
    "option_move",
    preloads,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "preload-not-ready");
  assert.equal(result.state, state);
  assert.equal(result.state.mode, "main");
});

test("correct branch plays target clip and returns to configured mainline position", () => {
  const decision = demo.decisions[0];
  assert.ok(decision);
  const state: PlayerState = {
    ...createInitialState(),
    status: "choice",
    mainTimeMs: 5_000,
    activeDecisionId: decision.id,
  };
  const result = chooseOption(
    demo,
    state,
    decision.id,
    "option_check",
    readyPreloads(demo),
  );
  assert.equal(result.ok, true);
  assert.equal(result.state.mode, "branch");
  assert.equal(result.state.branch?.segmentId, "seg_check");
  assert.equal(result.state.branch?.endMs, 4_800);

  const completed = finishBranch(demo, {
    ...result.state,
    branch: {
      ...result.state.branch!,
      elapsedMs: 4_800,
    },
  });
  assert.equal(completed.mode, "main");
  assert.equal(completed.status, "playing");
  assert.equal(completed.mainTimeMs, 6_400);
});

test("wrong branch returns to the decision point and can be retried", () => {
  const decision = demo.decisions[0];
  assert.ok(decision);
  const result = chooseOption(
    demo,
    {
      ...createInitialState(),
      status: "choice",
      mainTimeMs: 5_000,
      activeDecisionId: decision.id,
    },
    decision.id,
    "option_move",
    readyPreloads(demo),
  );
  assert.equal(result.ok, true);
  const completed = finishBranch(demo, {
    ...result.state,
    branch: { ...result.state.branch!, elapsedMs: 4_100 },
  });
  assert.equal(completed.mode, "main");
  assert.equal(completed.status, "choice");
  assert.equal(completed.mainTimeMs, 4_200);
  assert.equal(completed.activeDecisionId, decision.id);

  const manual = returnToDecision(demo, result.state);
  assert.equal(manual.mainTimeMs, 4_200);
  assert.equal(manual.status, "choice");
});

test("manifest round-trip preserves every branch-defining field", () => {
  const roundTrip = normalizeManifest(JSON.parse(JSON.stringify(demo)));
  assert.deepEqual(roundTrip, demo);
});

test("validator rejects broken target and return references", () => {
  const broken = JSON.parse(JSON.stringify(demo)) as BranchManifest;
  const option = broken.decisions[0]?.options[0];
  assert.ok(option);
  option.targetSegmentId = "missing-segment";
  option.returnToMs = 99_999;
  const validation = validateManifest(broken);
  assert.equal(validation.valid, false);
  assert.ok(
    validation.issues.some((issue) => issue.path.includes("targetSegmentId")),
  );
  assert.ok(
    validation.issues.some((issue) => issue.path.includes("returnToMs")),
  );
});
