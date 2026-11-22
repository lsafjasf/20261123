import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateProject } from "../src/migrate/engine.ts";
import { verifyMigration } from "../src/migrate/verify.ts";
import { emptyState, loadState, saveState, stateDirFor } from "../src/migrate/state.ts";
import {
  backupOutputs,
  rollback,
  writeJsonAtomic,
  OUTPUT_PROJECT,
  OUTPUT_REPORT,
} from "../src/migrate/rollback.ts";
import type { LegacyProject } from "../src/legacy/schema.ts";

const legacyPath = join(import.meta.dirname, "..", "examples", "legacy-project.json");
const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as LegacyProject;

function run(state = emptyState(legacy.id), runId = "run-1") {
  return migrateProject(legacy, state, { runId, now: "2026-11-23T00:00:00.000Z" });
}

test("bad clip is quarantined without failing the project", () => {
  const { project, report } = run();
  assert.equal(report.totals.clipsQuarantined, 1);
  assert.equal(report.quarantined[0].clipId, "c-broken");
  assert.match(report.quarantined[0].reason, /exceeds media duration/);
  const v1 = project.sequences[0].tracks.find((t) => t.id === "v1");
  assert.ok(v1);
  assert.deepEqual(v1.clips.map((c) => c.id), ["c-intro", "c-interview"]);
});

test("every migrated clip carries full cut provenance", () => {
  const { project } = run();
  for (const seq of project.sequences) {
    for (const track of seq.tracks) {
      for (const clip of track.clips) {
        const points = new Set(clip.provenance.cuts.map((c) => c.point));
        for (const p of ["timelineStart", "sourceIn", "sourceOut"]) {
          assert.ok(points.has(p), `${clip.id} missing ${p}`);
        }
        assert.equal(clip.provenance.legacyClipId, clip.id);
        assert.equal(clip.provenance.sourceHash.length, 64);
      }
    }
  }
});

test("inexact cuts are listed separately in the report", () => {
  const { report } = run();
  assert.ok(report.totals.clipsApproximate > 0);
  for (const entry of report.approximate) {
    assert.ok(entry.roundedCuts.length > 0);
    assert.ok(entry.roundedCuts.every((c) => !c.exact));
    assert.ok(entry.maxAbsErrorMs > 0);
  }
});

test("total duration stays within tolerance", () => {
  const { report } = run();
  for (const check of report.durationChecks) {
    assert.ok(
      check.withinTolerance,
      `${check.sequenceId} drift ${check.driftMs} > ${check.toleranceMs}`,
    );
  }
});

test("speed ramp clip maps segments onto the frame grid", () => {
  const { project } = run();
  const v2 = project.sequences[0].tracks.find((t) => t.id === "v2");
  const ramp = v2?.clips.find((c) => c.id === "c-speedramp");
  assert.ok(ramp?.speedSegments);
  assert.equal(ramp.speedSegments.length, 3);
  assert.deepEqual(ramp.speedSegments[1].rate, { num: 5, den: 2 });
  const total = ramp.speedSegments.reduce((a, s) => a + s.timelineDuration, 0);
  assert.equal(total, ramp.duration);
});

test("transition overlap is resolved against the previous clip", () => {
  const { project } = run();
  const v1 = project.sequences[0].tracks.find((t) => t.id === "v1");
  const interview = v1?.clips.find((c) => c.id === "c-interview");
  assert.equal(interview?.transitionIn?.overlapWithClipId, "c-intro");
  assert.ok((interview?.transitionIn?.duration ?? 0) > 0);
});

test("audio clips keep their own sample rate", () => {
  const { project } = run();
  const a1 = project.sequences[0].tracks.find((t) => t.id === "a1");
  const music = a1?.clips.find((c) => c.id === "c-music");
  assert.equal(music?.sampleRate, 44100);
  const vo = a1?.clips.find((c) => c.id === "c-vo");
  assert.equal(vo?.sampleRate, 48000);
});

test("verifyMigration passes on a fresh migration", () => {
  const { project, report } = run();
  const result = verifyMigration(legacy, project, report);
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
});

test("incremental run reuses unchanged clips and reconverts edited ones", () => {
  const first = run(emptyState(legacy.id), "run-1");
  const edited: LegacyProject = {
    ...legacy,
    sequences: legacy.sequences.map((s) => ({
      ...s,
      tracks: s.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === "c-vo" ? { ...c, sourceOutMs: 20000 } : c,
        ),
      })),
    })),
  };
  const second = migrateProject(edited, first.state, {
    runId: "run-2",
    now: "2026-11-23T01:00:00.000Z",
  });
  // c-vo changed; c-music depends on it through its transition, so it
  // is re-converted too. The other three clips come from the cache.
  assert.equal(second.report.totals.clipsReusedFromCache, 3);
  assert.equal(second.report.totals.clipsMigrated, 2);
  assert.equal(second.report.totals.clipsQuarantined, 1);
  const a1 = second.project.sequences[0].tracks.find((t) => t.id === "a1");
  const vo = a1?.clips.find((c) => c.id === "c-vo");
  assert.equal(vo?.sourceOut, 20000 * 48);
});

test("state persists and reloads; outputs roll back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cutline-"));
  try {
    const outDir = join(dir, "out");
    const stateDir = stateDirFor(outDir);
    const first = run(emptyState(legacy.id), "run-1");
    await writeJsonAtomic(join(outDir, OUTPUT_PROJECT), first.project);
    await writeJsonAtomic(join(outDir, OUTPUT_REPORT), first.report);
    await saveState(stateDir, first.state);

    const loaded = await loadState(stateDir, legacy.id);
    assert.equal(Object.keys(loaded.clips).length, 6);

    const second = run(loaded, "run-2");
    assert.equal(second.report.totals.clipsReusedFromCache, 5);
    await backupOutputs(outDir, stateDir, "run-2");
    await writeJsonAtomic(join(outDir, OUTPUT_PROJECT), second.project);

    const restored = await rollback(outDir, stateDir);
    assert.equal(restored.runId, "run-2");
    const restoredProject = JSON.parse(
      await readFile(join(outDir, OUTPUT_PROJECT), "utf8"),
    ) as { migration: { runId: string } };
    assert.equal(restoredProject.migration.runId, "run-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
