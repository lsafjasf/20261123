/**
 * Migration engine: orchestrates clip conversion with per-clip error
 * isolation, incremental reuse via the state store, total-duration
 * tolerance checks, and the auditable migration report.
 */

import {
  type Rational,
  parseRational,
  fromNumber,
  rational,
  mul as mulRational,
  div as divRational,
  cmp as cmpRational,
  roundToInt,
  toNumber as ratToNumber,
} from "../core/rational.ts";
import {
  type TimeGrid,
  type Tolerance,
  videoGrid,
  audioGrid,
  defaultTolerance,
} from "../core/time.ts";
import {
  validateLegacyProject,
  type LegacyProject,
  type LegacyClip,
  type LegacyMedia,
} from "../legacy/schema.ts";
import type {
  ProjectV2,
  SequenceV2,
  TrackV2,
  MediaV2,
  ClipV2,
} from "../model/schema.ts";
import { convertTrack, type ConvertContext } from "./convert.ts";
import {
  type MigrationReport,
  type ApproximateEntry,
  type QuarantineEntry,
  type SequenceDurationCheck,
} from "./report.ts";
import { hashOf } from "./hash.ts";
import { type MigrationState, clipKey } from "./state.ts";

export interface EngineOptions {
  readonly runId: string;
  readonly now: string; // ISO timestamp, injected for testability
  readonly tolerance?: Partial<Tolerance>;
  /** When false, ignores the incremental cache and re-converts everything. */
  readonly incremental?: boolean;
}

export interface EngineResult {
  readonly project: ProjectV2;
  readonly report: MigrationReport;
  readonly state: MigrationState;
}

function parseFps(frameRate: number | string): Rational {
  const fps = typeof frameRate === "number" ? fromNumber(frameRate) : parseRational(frameRate);
  if (fps.num <= 0n) throw new Error(`invalid project frame rate ${frameRate}`);
  return fps;
}

function clipInputHash(
  clip: LegacyClip,
  media: LegacyMedia | undefined,
  video: TimeGrid,
  audioRate: number,
  tolerance: Tolerance,
  prevClip?: LegacyClip,
): string {
  return hashOf({
    clip,
    media,
    // A transition's validity depends on the previous clip's extent,
    // so neighbor edits must invalidate the cache entry too.
    prevClip: clip.transitionIn ? prevClip : undefined,
    fps: `${video.ticksPerSecond.num}/${video.ticksPerSecond.den}`,
    audioRate,
    tolerance,
    converter: 1, // bump when conversion semantics change
  });
}

export function migrateProject(
  legacy: LegacyProject,
  state: MigrationState,
  opts: EngineOptions,
): EngineResult {
  const structuralErrors = validateLegacyProject(legacy);
  if (structuralErrors.length > 0) {
    const summary = structuralErrors
      .slice(0, 10)
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`legacy project failed structural validation: ${summary}`);
  }

  const fps = parseFps(legacy.frameRate);
  const video = videoGrid(fps);
  const tolerance: Tolerance = {
    ...defaultTolerance(video, audioGrid(legacy.audioSampleRate)),
    ...opts.tolerance,
  };
  const incremental = opts.incremental !== false;
  const mediaById = new Map<string, LegacyMedia>(legacy.media.map((m) => [m.id, m]));

  const approximate: ApproximateEntry[] = [];
  const quarantined: QuarantineEntry[] = [];
  const durationChecks: SequenceDurationCheck[] = [];
  let migrated = 0;
  let reused = 0;

  const nextClips: MigrationState["clips"] = {};
  const sequences: SequenceV2[] = [];

  for (const seq of legacy.sequences) {
    const tracks: TrackV2[] = [];
    let seqEndSeconds = rational(0n); // exact max across tracks and rates
    let legacyEndMs = 0;

    for (const track of seq.tracks) {
      const gridFor = (clip: LegacyClip): TimeGrid => {
        if (track.kind === "video") return video;
        const media = mediaById.get(clip.mediaId);
        return audioGrid(media?.sampleRate ?? legacy.audioSampleRate);
      };
      const sortedLegacy = [...track.clips].sort(
        (a, b) => a.timelineStartMs - b.timelineStartMs,
      );
      const prevOf = new Map<string, LegacyClip>();
      for (let i = 1; i < sortedLegacy.length; i++) {
        prevOf.set(sortedLegacy[i].id, sortedLegacy[i - 1]);
      }
      const inputHashFor = (clip: LegacyClip): string =>
        clipInputHash(clip, mediaById.get(clip.mediaId), video,
          legacy.audioSampleRate, tolerance, prevOf.get(clip.id));
      const makeCtx = (clip: LegacyClip): ConvertContext => ({
        sequenceId: seq.id,
        trackId: track.id,
        grid: gridFor(clip),
        tolerance,
        sourceHash: inputHashFor(clip),
      });

      // Incremental reuse is decided per clip before conversion.
      const reusable = new Map<string, ClipV2>();
      if (incremental) {
        for (const clip of track.clips) {
          const entry = state.clips[clipKey(seq.id, track.id, clip.id)];
          if (!entry || entry.status !== "migrated" || !entry.result) continue;
          if (entry.inputHash === inputHashFor(clip)) reusable.set(clip.id, entry.result);
        }
      }

      const pending = track.clips.filter((c) => !reusable.has(c.id));
      const conversion = convertTrack({ ...track, clips: pending }, mediaById, makeCtx);

      const clips: ClipV2[] = [];
      for (const legacyClip of track.clips) {
        const key = clipKey(seq.id, track.id, legacyClip.id);
        const cached = reusable.get(legacyClip.id);
        if (cached) {
          clips.push(cached);
          nextClips[key] = {
            inputHash: inputHashFor(legacyClip),
            status: "migrated",
            result: cached,
            runId: opts.runId,
          };
          reused++;
          continue;
        }
        const fresh = conversion.clips.find((c) => c.id === legacyClip.id);
        if (fresh) {
          clips.push(fresh);
          nextClips[key] = {
            inputHash: fresh.provenance.sourceHash,
            status: "migrated",
            result: fresh,
            runId: opts.runId,
          };
          migrated++;
        } else {
          const failure = conversion.failures.find((f) => f.clipId === legacyClip.id);
          const reason = failure?.reason ?? "conversion failed";
          quarantined.push({
            sequenceId: seq.id,
            trackId: track.id,
            clipId: legacyClip.id,
            reason,
            legacyClip,
          });
          nextClips[key] = {
            inputHash: inputHashFor(legacyClip),
            status: "quarantined",
            reason,
            runId: opts.runId,
          };
        }
      }

      for (const r of conversion.rounded) {
        const maxAbsErrorMs = Math.max(...r.cuts.map((c) => Math.abs(c.errorMs)));
        approximate.push({
          sequenceId: seq.id,
          trackId: track.id,
          clipId: r.clipId,
          roundedCuts: r.cuts,
          maxAbsErrorMs,
        });
      }

      clips.sort((a, b) => a.timelineStart - b.timelineStart);
      tracks.push({ id: track.id, kind: track.kind, clips });

      const migratedIds = new Set(clips.map((c) => c.id));
      for (const clip of clips) {
        const end = clip.timelineStart + clip.duration;
        const grid = track.kind === "video"
          ? video
          : audioGrid(clip.sampleRate ?? legacy.audioSampleRate);
        const endSeconds = divRational(rational(BigInt(end)), grid.ticksPerSecond);
        if (cmpRational(endSeconds, seqEndSeconds) > 0) seqEndSeconds = endSeconds;
      }
      for (const legacyClip of track.clips) {
        // Quarantined clips are absent from the output, so they must
        // not count toward the legacy duration baseline either.
        if (!migratedIds.has(legacyClip.id)) continue;
        // Legacy end is speed-aware: timeline end = start + source span / rate.
        const spanMs = legacyClip.speedSegments
          ? legacyClip.speedSegments.reduce(
              (acc, s) => acc + (s.sourceOutMs - s.sourceInMs) / s.rate,
              0,
            )
          : (legacyClip.sourceOutMs - legacyClip.sourceInMs) / (legacyClip.speed ?? 1);
        legacyEndMs = Math.max(legacyEndMs, legacyClip.timelineStartMs + spanMs);
      }
    }

    const migratedMs = ratToNumber(seqEndSeconds) * 1000;
    const seqEndFrames = Number(
      roundToInt(mulRational(seqEndSeconds, video.ticksPerSecond)).value,
    );
    const seqEndSamples = Number(
      roundToInt(
        mulRational(seqEndSeconds, audioGrid(legacy.audioSampleRate).ticksPerSecond),
      ).value,
    );
    const driftMs = Math.abs(migratedMs - legacyEndMs);
    durationChecks.push({
      sequenceId: seq.id,
      legacyDurationMs: legacyEndMs,
      migratedDurationMs: migratedMs,
      driftMs,
      toleranceMs: tolerance.maxDurationDriftMs,
      withinTolerance: driftMs <= tolerance.maxDurationDriftMs,
    });

    sequences.push({
      id: seq.id,
      name: seq.name,
      tracks,
      durationFrames: seqEndFrames,
      durationSamples: seqEndSamples,
    });
  }

  const media: MediaV2[] = legacy.media.map((m) => {
    if (m.kind === "audio") {
      const rate = m.sampleRate ?? legacy.audioSampleRate;
      const samples = Math.round((m.durationMs / 1000) * rate);
      return { id: m.id, path: m.path, kind: m.kind, durationSamples: samples,
        sampleRate: rate };
    }
    const seconds = ratToNumber(rational(BigInt(m.durationMs), 1000n));
    const frames = Math.round(seconds * ratToNumber(fps));
    return { id: m.id, path: m.path, kind: m.kind, durationFrames: frames };
  });

  const project: ProjectV2 = {
    formatVersion: 2,
    id: legacy.id,
    name: legacy.name,
    frameRate: { num: Number(fps.num), den: Number(fps.den) },
    audioSampleRate: legacy.audioSampleRate,
    media,
    sequences,
    migration: {
      tool: "cutline-migrator/0.1",
      migratedAt: opts.now,
      sourceFormatVersion: 1,
      sourceHash: hashOf(legacy),
      runId: opts.runId,
    },
  };

  const report: MigrationReport = {
    runId: opts.runId,
    startedAt: opts.now,
    finishedAt: opts.now,
    projectId: legacy.id,
    totals: {
      clipsMigrated: migrated,
      clipsReusedFromCache: reused,
      clipsApproximate: approximate.length,
      clipsQuarantined: quarantined.length,
    },
    approximate,
    quarantined,
    durationChecks,
  };

  const nextState: MigrationState = {
    version: 1,
    projectId: legacy.id,
    clips: nextClips,
    lastRunId: opts.runId,
  };

  return { project, report, state: nextState };
}
