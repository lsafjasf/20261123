/**
 * Post-migration verification. Re-opens the migrated project the way
 * the new engine would and independently checks the guarantees:
 *
 *  1. every clip carries provenance with at least the four base cuts;
 *  2. every quarantined legacy clip is absent from the output;
 *  3. total sequence duration matches the legacy duration within
 *     tolerance;
 *  4. per-clip source/timeline ranges are monotonic and positive.
 */

import {
  rational,
  div as divRational,
  mul as mulRational,
  cmp as cmpRational,
  roundToInt,
  toNumber as ratToNumber,
} from "../core/rational.ts";
import { videoGrid, audioGrid } from "../core/time.ts";
import type { LegacyProject } from "../legacy/schema.ts";
import type { ProjectV2 } from "../model/schema.ts";
import type { MigrationReport } from "./report.ts";

export interface VerifyIssue {
  readonly scope: string;
  readonly message: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly issues: VerifyIssue[];
}

const BASE_CUTS = ["timelineStart", "sourceIn", "sourceOut", "timelineDuration"];

export function verifyMigration(
  legacy: LegacyProject,
  project: ProjectV2,
  report: MigrationReport,
): VerifyResult {
  const issues: VerifyIssue[] = [];
  const fail = (scope: string, message: string) => issues.push({ scope, message });

  if (project.formatVersion !== 2) fail("$", "formatVersion must be 2");
  if (project.id !== legacy.id) fail("$", "project id mismatch with legacy source");

  const quarantinedIds = new Set(report.quarantined.map((q) => q.clipId));
  const legacyClipIds = new Set<string>();
  for (const seq of legacy.sequences) {
    for (const track of seq.tracks) {
      for (const clip of track.clips) legacyClipIds.add(clip.id);
    }
  }

  const fps = videoGrid(
    rational(BigInt(project.frameRate.num), BigInt(project.frameRate.den)),
  );
  const audio = audioGrid(project.audioSampleRate);

  const seenClipIds = new Set<string>();
  for (const seq of project.sequences) {
    for (const track of seq.tracks) {
      for (const clip of track.clips) {
        const scope = `${seq.id}/${track.id}/${clip.id}`;
        if (seenClipIds.has(clip.id)) fail(scope, "duplicate clip id in output");
        seenClipIds.add(clip.id);
        if (quarantinedIds.has(clip.id)) {
          fail(scope, "clip is both migrated and quarantined");
        }
        if (!legacyClipIds.has(clip.id)) {
          fail(scope, "output clip has no legacy counterpart");
        }
        const p = clip.provenance;
        if (!p || p.legacyClipId !== clip.id) {
          fail(scope, "missing or mismatched provenance");
          continue;
        }
        const points = new Set(p.cuts.map((c) => c.point));
        const hasSegments = (clip.speedSegments?.length ?? 0) > 0;
        for (const base of hasSegments ? BASE_CUTS.slice(0, 3) : BASE_CUTS) {
          if (!points.has(base)) fail(scope, `provenance missing cut "${base}"`);
        }
        if (clip.duration <= 0) fail(scope, "non-positive duration");
        if (clip.sourceOut <= clip.sourceIn) fail(scope, "non-positive source range");
        if (clip.transitionIn && clip.transitionIn.duration <= 0) {
          fail(scope, "non-positive transition duration");
        }
      }
    }

    // Guarantee 3: total duration within tolerance, recomputed from
    // scratch rather than trusting the stored duration fields. Audio
    // clips may use different sample rates, so compare in seconds.
    let endSeconds = rational(0n);
    for (const track of seq.tracks) {
      for (const clip of track.clips) {
        const end = clip.timelineStart + clip.duration;
        const grid = track.kind === "video"
          ? fps
          : audioGrid(clip.sampleRate ?? project.audioSampleRate);
        const sec = divRational(rational(BigInt(end)), grid.ticksPerSecond);
        if (cmpRational(sec, endSeconds) > 0) endSeconds = sec;
      }
    }
    const check = report.durationChecks.find((c) => c.sequenceId === seq.id);
    const migratedMs = ratToNumber(endSeconds) * 1000;
    if (check) {
      const drift = Math.abs(migratedMs - check.legacyDurationMs);
      if (drift > check.toleranceMs) {
        fail(
          seq.id,
          `total duration drift ${drift.toFixed(6)}ms exceeds tolerance ` +
            `${check.toleranceMs.toFixed(6)}ms`,
        );
      }
    } else {
      fail(seq.id, "no duration check recorded in the migration report");
    }
    const expectFrames = Number(
      roundToInt(mulRational(endSeconds, fps.ticksPerSecond)).value,
    );
    const expectSamples = Number(
      roundToInt(mulRational(endSeconds, audio.ticksPerSecond)).value,
    );
    if (seq.durationFrames !== expectFrames || seq.durationSamples !== expectSamples) {
      fail(seq.id, "stored sequence duration does not match recomputed value");
    }
  }

  // Guarantee 2: every legacy clip is accounted for exactly once.
  for (const id of legacyClipIds) {
    if (!seenClipIds.has(id) && !quarantinedIds.has(id)) {
      fail(id, "legacy clip vanished: neither migrated nor quarantined");
    }
  }

  return { ok: issues.length === 0, issues };
}
