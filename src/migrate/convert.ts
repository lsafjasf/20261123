/**
 * Per-clip and per-track conversion. All functions are pure: no I/O,
 * no clock, no randomness. Hard data problems throw ClipMigrationError
 * so the engine can quarantine exactly one clip and keep going.
 */

import {
  type Rational,
  rational,
  fromNumber,
  mul,
  div,
  add,
  roundToInt,
  cmp,
  toNumber,
} from "../core/rational.ts";
import {
  type TimeGrid,
  type ConvertedTime,
  type Tolerance,
  msToGrid,
} from "../core/time.ts";
import type {
  LegacyClip,
  LegacyMedia,
  LegacyTrack,
} from "../legacy/schema.ts";
import type {
  ClipV2,
  CutPointTrace,
  SpeedSegmentV2,
} from "../model/schema.ts";
import { ClipMigrationError } from "./report.ts";

export interface ConvertContext {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly grid: TimeGrid;
  readonly tolerance: Tolerance;
  readonly sourceHash: string;
}

export interface ConvertedClip {
  readonly clip: ClipV2;
  /** Subset of provenance cuts that required rounding. */
  readonly roundedCuts: readonly CutPointTrace[];
}

function toSafeInt(value: bigint, what: string, clipId: string): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const v = value < 0n ? -value : value;
  if (v > max) {
    throw new ClipMigrationError(clipId, `${what} exceeds safe integer range`);
  }
  return Number(value);
}

class CutRecorder {
  readonly cuts: CutPointTrace[] = [];
  private readonly clipId: string;
  private readonly unit: "frames" | "samples";
  private readonly requireExact: boolean;
  constructor(clipId: string, unit: "frames" | "samples", requireExact: boolean) {
    this.clipId = clipId;
    this.unit = unit;
    this.requireExact = requireExact;
  }

  record(point: string, legacyMs: number, converted: ConvertedTime): number {
    if (!converted.exact && this.requireExact) {
      throw new ClipMigrationError(
        this.clipId,
        `cut "${point}" at ${legacyMs}ms is not exactly representable ` +
          `(off by ${converted.errorMs.toFixed(6)}ms)`,
      );
    }
    const ticks = toSafeInt(converted.ticks, `cut "${point}"`, this.clipId);
    this.cuts.push({
      point,
      legacyMs,
      converted: ticks,
      unit: this.unit,
      exact: converted.exact,
      errorMs: converted.errorMs,
    });
    return ticks;
  }
}

function rateToRational(rate: number, clipId: string): Rational {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new ClipMigrationError(clipId, `invalid playback rate ${rate}`);
  }
  const r = fromNumber(rate);
  if (cmp(r, rational(0n)) <= 0) {
    throw new ClipMigrationError(clipId, `invalid playback rate ${rate}`);
  }
  return r;
}

function rationalToSpeed(r: Rational): { num: number; den: number } {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (r.num > max || r.den > max) {
    throw new ClipMigrationError("", "speed factor exceeds safe integer range");
  }
  return { num: Number(r.num), den: Number(r.den) };
}

/** Ticks spanned by a legacy ms range on the grid, as an exact rational. */
function exactSpanTicks(fromMs: number, toMs: number, grid: TimeGrid): Rational {
  const spanMs = rational(BigInt(toMs - fromMs), 1000n);
  return mul(spanMs, grid.ticksPerSecond);
}

export function convertClip(
  legacy: LegacyClip,
  media: LegacyMedia,
  ctx: ConvertContext,
): ConvertedClip {
  const id = legacy.id;
  const grid = ctx.grid;
  const rec = new CutRecorder(id, grid.unit, ctx.tolerance.requireExactCuts);

  if (legacy.sourceOutMs <= legacy.sourceInMs) {
    throw new ClipMigrationError(
      id,
      `empty or reversed source range [${legacy.sourceInMs}, ${legacy.sourceOutMs})`,
    );
  }
  if (media.kind !== "image" && legacy.sourceOutMs > media.durationMs) {
    throw new ClipMigrationError(
      id,
      `sourceOutMs ${legacy.sourceOutMs} exceeds media duration ${media.durationMs}`,
    );
  }

  const timelineStart = rec.record(
    "timelineStart",
    legacy.timelineStartMs,
    msToGrid(legacy.timelineStartMs, grid),
  );
  const sourceIn = rec.record("sourceIn", legacy.sourceInMs, msToGrid(legacy.sourceInMs, grid));
  const sourceOut = rec.record(
    "sourceOut",
    legacy.sourceOutMs,
    msToGrid(legacy.sourceOutMs, grid),
  );

  let duration: number;
  let speed: ClipV2["speed"];
  let speedSegments: SpeedSegmentV2[] | undefined;

  if (legacy.speedSegments && legacy.speedSegments.length > 0) {
    const segs = legacy.speedSegments;
    if (segs[0].sourceInMs !== legacy.sourceInMs) {
      throw new ClipMigrationError(id, "speed segments must start at sourceInMs");
    }
    if (segs[segs.length - 1].sourceOutMs !== legacy.sourceOutMs) {
      throw new ClipMigrationError(id, "speed segments must end at sourceOutMs");
    }
    speedSegments = [];
    let exactCursor = rational(0n); // exact timeline ticks since clip head
    let roundedCursor = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.sourceOutMs <= seg.sourceInMs) {
        throw new ClipMigrationError(id, `speed segment ${i} has empty source range`);
      }
      if (i > 0 && seg.sourceInMs !== segs[i - 1].sourceOutMs) {
        throw new ClipMigrationError(id, `speed segment ${i} is not contiguous`);
      }
      const rate = rateToRational(seg.rate, id);
      const segSourceIn = rec.record(
        `speedSegment[${i}].sourceIn`,
        seg.sourceInMs,
        msToGrid(seg.sourceInMs, grid),
      );
      const segSourceOut = rec.record(
        `speedSegment[${i}].sourceOut`,
        seg.sourceOutMs,
        msToGrid(seg.sourceOutMs, grid),
      );
      const exactSpan = div(mul(exactSpanTicks(seg.sourceInMs, seg.sourceOutMs, grid), rational(1n)), rate);
      exactCursor = add(exactCursor, exactSpan);
      const rounded = roundToInt(exactCursor);
      const segEnd = toSafeInt(rounded.value, `speedSegment[${i}] timeline end`, id);
      if (!rounded.exact) {
        // Record the synthetic boundary so the drift stays auditable.
        rec.cuts.push({
          point: `speedSegment[${i}].timelineEnd`,
          legacyMs: seg.sourceOutMs,
          converted: timelineStart + segEnd,
          unit: grid.unit,
          exact: false,
          errorMs: toNumber(div(rounded.error, grid.ticksPerSecond)) * 1000,
        });
      }
      speedSegments.push({
        sourceIn: segSourceIn,
        sourceOut: segSourceOut,
        timelineStart: timelineStart + roundedCursor,
        timelineDuration: segEnd - roundedCursor,
        rate: rationalToSpeed(rate),
      });
      roundedCursor = segEnd;
    }
    duration = roundedCursor;
    if (duration <= 0) {
      throw new ClipMigrationError(id, "speed-mapped timeline duration rounds to zero");
    }
  } else {
    const rate = rateToRational(legacy.speed ?? 1, id);
    const exactSpan = div(exactSpanTicks(legacy.sourceInMs, legacy.sourceOutMs, grid), rate);
    const rounded = roundToInt(exactSpan);
    duration = toSafeInt(rounded.value, "timeline duration", id);
    if (duration <= 0) {
      throw new ClipMigrationError(id, "timeline duration rounds to zero");
    }
    rec.cuts.push({
      point: "timelineDuration",
      legacyMs: legacy.sourceOutMs - legacy.sourceInMs,
      converted: duration,
      unit: grid.unit,
      exact: rounded.exact,
      errorMs: toNumber(div(rounded.error, grid.ticksPerSecond)) * 1000,
    });
    if (cmp(rate, rational(1n)) !== 0) speed = rationalToSpeed(rate);
  }

  let transitionIn: ClipV2["transitionIn"];
  if (legacy.transitionIn) {
    if (legacy.transitionIn.durationMs <= 0) {
      throw new ClipMigrationError(id, "transition duration must be positive");
    }
    const t = rec.record(
      "transitionIn.duration",
      legacy.transitionIn.durationMs,
      msToGrid(legacy.transitionIn.durationMs, grid),
    );
    transitionIn = {
      type: legacy.transitionIn.type,
      duration: t,
      overlapWithClipId: "", // resolved at track level
    };
  }

  const clip: ClipV2 = {
    id: legacy.id,
    mediaId: legacy.mediaId,
    timelineStart,
    duration,
    sourceIn,
    sourceOut,
    ...(grid.unit === "samples"
      ? { sampleRate: Number(grid.ticksPerSecond.num / grid.ticksPerSecond.den) }
      : {}),
    ...(speed ? { speed } : {}),
    ...(speedSegments ? { speedSegments } : {}),
    ...(transitionIn ? { transitionIn } : {}),
    enabled: legacy.enabled !== false,
    provenance: {
      legacyClipId: legacy.id,
      legacySequenceId: ctx.sequenceId,
      legacyTrackId: ctx.trackId,
      sourceHash: ctx.sourceHash,
      cuts: rec.cuts,
    },
  };

  return { clip, roundedCuts: rec.cuts.filter((c) => !c.exact) };
}

export interface TrackConversion {
  readonly clips: ClipV2[];
  readonly rounded: { clipId: string; cuts: readonly CutPointTrace[] }[];
  readonly failures: { clipId: string; reason: string }[];
}

/**
 * Converts every clip on a track, isolating failures per clip and
 * resolving transition overlaps against the previous migrated clip.
 */
export function convertTrack(
  track: LegacyTrack,
  mediaById: ReadonlyMap<string, LegacyMedia>,
  makeCtx: (clip: LegacyClip) => ConvertContext,
): TrackConversion {
  const clips: ClipV2[] = [];
  const rounded: TrackConversion["rounded"][number][] = [];
  const failures: TrackConversion["failures"][number][] = [];

  const sorted = [...track.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  for (const legacy of sorted) {
    const media = mediaById.get(legacy.mediaId);
    if (!media) {
      failures.push({ clipId: legacy.id, reason: `unknown media "${legacy.mediaId}"` });
      continue;
    }
    if (track.kind === "audio" && media.kind === "video") {
      failures.push({ clipId: legacy.id, reason: "video media on an audio track" });
      continue;
    }
    let converted: ConvertedClip;
    try {
      converted = convertClip(legacy, media, makeCtx(legacy));
    } catch (err) {
      failures.push({
        clipId: legacy.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const clip = converted.clip;
    if (clip.transitionIn) {
      const prev = clips[clips.length - 1];
      if (!prev) {
        failures.push({ clipId: clip.id, reason: "transitionIn on the first clip of a track" });
        continue;
      }
      const prevEnd = prev.timelineStart + prev.duration;
      const overlap = prevEnd - clip.timelineStart;
      if (overlap <= 0) {
        failures.push({
          clipId: clip.id,
          reason: `transition declared but clips do not overlap (gap ${-overlap})`,
        });
        continue;
      }
      if (clip.transitionIn.duration > overlap) {
        failures.push({
          clipId: clip.id,
          reason:
            `transition duration ${clip.transitionIn.duration} exceeds ` +
            `overlap ${overlap} with clip "${prev.id}"`,
        });
        continue;
      }
      clip.transitionIn.overlapWithClipId = prev.id;
    }
    clips.push(clip);
    if (converted.roundedCuts.length > 0) {
      rounded.push({ clipId: clip.id, cuts: converted.roundedCuts });
    }
  }
  return { clips, rounded, failures };
}
