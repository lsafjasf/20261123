/**
 * New project format ("v2"): frame-accurate video, sample-accurate
 * audio, rational speed factors, and full per-cut-point provenance so
 * every migrated cut can be traced back to its legacy millisecond
 * position and its rounding error.
 */

export interface ProjectV2 {
  readonly formatVersion: 2;
  readonly id: string;
  readonly name: string;
  readonly frameRate: { readonly num: number; readonly den: number };
  readonly audioSampleRate: number;
  readonly media: readonly MediaV2[];
  readonly sequences: readonly SequenceV2[];
  readonly migration: MigrationMeta;
}

export interface MigrationMeta {
  readonly tool: string;
  readonly migratedAt: string; // ISO 8601
  readonly sourceFormatVersion: 1;
  readonly sourceHash: string; // sha256 of canonical legacy JSON
  readonly runId: string;
}

export interface MediaV2 {
  readonly id: string;
  readonly path: string;
  readonly kind: "video" | "audio" | "image";
  readonly durationFrames?: number; // video/image, on the project grid
  readonly durationSamples?: number; // audio, on its own sample rate
  readonly sampleRate?: number;
}

export interface SequenceV2 {
  readonly id: string;
  readonly name: string;
  readonly tracks: readonly TrackV2[];
  /** Total duration derived from converted clips; authoritative value. */
  readonly durationFrames: number;
  readonly durationSamples: number;
}

export interface TrackV2 {
  readonly id: string;
  readonly kind: "video" | "audio";
  readonly clips: readonly ClipV2[];
}

/**
 * Positions are integers in the track's unit: frames on video tracks,
 * samples (at the clip's sampleRate) on audio tracks. Speed segments
 * map source ticks to timeline ticks through a rational rate.
 */
export interface ClipV2 {
  readonly id: string;
  readonly mediaId: string;
  readonly timelineStart: number;
  readonly duration: number;
  readonly sourceIn: number;
  readonly sourceOut: number;
  /** Audio clips carry their own sample rate; video clips omit it. */
  readonly sampleRate?: number;
  readonly speed?: { readonly num: number; readonly den: number };
  readonly speedSegments?: readonly SpeedSegmentV2[];
  readonly transitionIn?: TransitionV2;
  readonly enabled: boolean;
  readonly provenance: Provenance;
}

export interface SpeedSegmentV2 {
  readonly sourceIn: number;
  readonly sourceOut: number;
  readonly timelineStart: number;
  readonly timelineDuration: number;
  readonly rate: { readonly num: number; readonly den: number };
}

export interface TransitionV2 {
  readonly type: "crossfade" | "dip" | "wipe";
  readonly duration: number; // in the track's unit
  readonly overlapWithClipId: string;
}

export interface CutPointTrace {
  /** e.g. "timelineStart", "sourceIn", "speedSegment[2].sourceOut" */
  readonly point: string;
  readonly legacyMs: number;
  readonly converted: number;
  readonly unit: "frames" | "samples";
  readonly exact: boolean;
  readonly errorMs: number;
}

export interface Provenance {
  readonly legacyClipId: string;
  readonly legacySequenceId: string;
  readonly legacyTrackId: string;
  readonly sourceHash: string; // sha256 of the legacy clip + its media
  readonly cuts: readonly CutPointTrace[];
}
