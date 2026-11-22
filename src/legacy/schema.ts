/**
 * Legacy project format ("v1"): every position and duration is an
 * integer number of milliseconds. Speed segments and transitions are
 * optional per clip. This module only declares the shape and validates
 * it; conversion lives in src/migrate/.
 */

export interface LegacyProject {
  readonly formatVersion: 1;
  readonly id: string;
  readonly name: string;
  /** Frame rate of the timeline: number ("29.97") or fraction ("30000/1001"). */
  readonly frameRate: number | string;
  readonly audioSampleRate: number;
  readonly media: readonly LegacyMedia[];
  readonly sequences: readonly LegacySequence[];
}

export interface LegacyMedia {
  readonly id: string;
  readonly path: string;
  readonly kind: "video" | "audio" | "image";
  readonly durationMs: number;
  /** Per-file sample rate; falls back to the project rate for audio. */
  readonly sampleRate?: number;
}

export interface LegacySequence {
  readonly id: string;
  readonly name: string;
  readonly tracks: readonly LegacyTrack[];
}

export interface LegacyTrack {
  readonly id: string;
  readonly kind: "video" | "audio";
  readonly clips: readonly LegacyClip[];
}

export interface LegacyClip {
  readonly id: string;
  readonly mediaId: string;
  /** Absolute position of the clip head on the timeline. */
  readonly timelineStartMs: number;
  readonly sourceInMs: number;
  readonly sourceOutMs: number;
  /** Constant playback rate; ignored when speedSegments is present. */
  readonly speed?: number;
  /** Variable-speed segments, in source time, ordered and non-overlapping. */
  readonly speedSegments?: readonly LegacySpeedSegment[];
  /** Transition overlapping the previous clip on the same track. */
  readonly transitionIn?: LegacyTransition;
  readonly enabled?: boolean;
}

export interface LegacySpeedSegment {
  readonly sourceInMs: number;
  readonly sourceOutMs: number;
  /** Playback rate for this segment; must be > 0. */
  readonly rate: number;
}

export interface LegacyTransition {
  readonly type: "crossfade" | "dip" | "wipe";
  readonly durationMs: number;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIntMs(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Structural validation only. Semantic checks (overlap math, source
 * bounds, speed sanity) happen per clip during migration so that one
 * bad clip never blocks the rest of the project.
 */
export function validateLegacyProject(raw: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  const fail = (path: string, message: string) => errors.push({ path, message });

  if (!isRecord(raw)) {
    fail("$", "project must be an object");
    return errors;
  }
  if (raw.formatVersion !== 1) fail("$.formatVersion", "must be 1");
  if (typeof raw.id !== "string" || raw.id === "") fail("$.id", "must be a non-empty string");
  if (typeof raw.name !== "string") fail("$.name", "must be a string");
  const fr = raw.frameRate;
  const frOk =
    (typeof fr === "number" && Number.isFinite(fr) && fr > 0) ||
    (typeof fr === "string" && fr.trim() !== "");
  if (!frOk) fail("$.frameRate", "must be a positive number or fraction string");
  if (!isIntMs(raw.audioSampleRate) || (raw.audioSampleRate as number) === 0) {
    fail("$.audioSampleRate", "must be a positive integer");
  }
  if (!Array.isArray(raw.media)) fail("$.media", "must be an array");
  if (!Array.isArray(raw.sequences) || raw.sequences.length === 0) {
    fail("$.sequences", "must be a non-empty array");
    return errors;
  }

  const mediaIds = new Set<string>();
  if (Array.isArray(raw.media)) {
    raw.media.forEach((m, i) => {
      const p = `$.media[${i}]`;
      if (!isRecord(m)) return fail(p, "must be an object");
      if (typeof m.id !== "string" || m.id === "") fail(`${p}.id`, "must be a non-empty string");
      else if (mediaIds.has(m.id)) fail(`${p}.id`, `duplicate media id "${m.id}"`);
      else mediaIds.add(m.id);
      if (typeof m.path !== "string") fail(`${p}.path`, "must be a string");
      if (!["video", "audio", "image"].includes(m.kind as string)) {
        fail(`${p}.kind`, "must be video|audio|image");
      }
      if (!isIntMs(m.durationMs)) fail(`${p}.durationMs`, "must be a non-negative integer");
      if (m.sampleRate !== undefined && !isIntMs(m.sampleRate)) {
        fail(`${p}.sampleRate`, "must be a positive integer");
      }
    });
  }

  (raw.sequences as unknown[]).forEach((seq, si) => {
    const sp = `$.sequences[${si}]`;
    if (!isRecord(seq)) return fail(sp, "must be an object");
    if (typeof seq.id !== "string" || seq.id === "") fail(`${sp}.id`, "must be a non-empty string");
    if (!Array.isArray(seq.tracks)) return fail(`${sp}.tracks`, "must be an array");
    (seq.tracks as unknown[]).forEach((tr, ti) => {
      const tp = `${sp}.tracks[${ti}]`;
      if (!isRecord(tr)) return fail(tp, "must be an object");
      if (typeof tr.id !== "string" || tr.id === "") fail(`${tp}.id`, "must be a non-empty string");
      if (tr.kind !== "video" && tr.kind !== "audio") fail(`${tp}.kind`, "must be video|audio");
      if (!Array.isArray(tr.clips)) return fail(`${tp}.clips`, "must be an array");
      (tr.clips as unknown[]).forEach((cl, ci) => {
        const cp = `${tp}.clips[${ci}]`;
        if (!isRecord(cl)) return fail(cp, "must be an object");
        if (typeof cl.id !== "string" || cl.id === "") fail(`${cp}.id`, "must be a non-empty string");
        if (typeof cl.mediaId !== "string") fail(`${cp}.mediaId`, "must be a string");
        else if (mediaIds.size > 0 && !mediaIds.has(cl.mediaId)) {
          fail(`${cp}.mediaId`, `unknown media "${cl.mediaId}"`);
        }
        for (const f of ["timelineStartMs", "sourceInMs", "sourceOutMs"] as const) {
          if (!isIntMs(cl[f])) fail(`${cp}.${f}`, "must be a non-negative integer");
        }
        if (cl.speed !== undefined) {
          const ok = typeof cl.speed === "number" && Number.isFinite(cl.speed) && cl.speed > 0;
          if (!ok) fail(`${cp}.speed`, "must be a finite number > 0");
        }
        if (cl.speedSegments !== undefined && !Array.isArray(cl.speedSegments)) {
          fail(`${cp}.speedSegments`, "must be an array");
        }
        if (cl.transitionIn !== undefined) {
          const t = cl as Record<string, unknown>;
          const tr2 = cl.transitionIn;
          if (!isRecord(tr2)) fail(`${cp}.transitionIn`, "must be an object");
          else if (!isIntMs((tr2 as Record<string, unknown>).durationMs)) {
            fail(`${cp}.transitionIn.durationMs`, "must be a non-negative integer");
          }
          void t;
        }
      });
    });
  });

  return errors;
}
