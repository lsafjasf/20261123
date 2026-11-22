/**
 * Unified per-frame timeline model. Every ingested EDL/FCPXML is normalized
 * into this structure on a single project frame grid. All positions are
 * integer frame numbers on the project grid unless noted otherwise.
 */

import type { FrameRate } from "./timecode.ts";

export type TrackKind = "video" | "audio";

export type TransitionKind = "dissolve" | "wipe" | "dip" | "other";

export interface SpeedSegment {
  /** Start on the clip's own timeline span (project frames, clip-relative). */
  readonly timelineStart: number;
  /** Duration on the timeline (project frames). */
  readonly timelineDuration: number;
  /** First source frame (source-rate grid) covered by this segment. */
  readonly sourceStart: number;
  /** Playback rate: 1 = normal, 0 = freeze frame, negative = reverse. */
  readonly speed: number;
  /** True when this segment comes from a ramp (interpolated) rather than constant speed. */
  readonly ramp: boolean;
}

export interface Transition {
  readonly kind: TransitionKind;
  readonly name: string;
  /** Duration in project frames. */
  readonly duration: number;
  /** Frame on the project grid where the transition is centered/starts. */
  readonly at: number;
}

export interface Clip {
  readonly id: string;
  readonly name: string;
  /** Reel / asset identifier from the source file. */
  readonly reel: string;
  /** Resolved media path when known; null when media is referenced but not found. */
  mediaPath: string | null;
  /** Native frame rate of the source material. */
  readonly sourceRate: FrameRate;
  /** Source in/out on the source-rate grid (out is exclusive). */
  readonly sourceIn: number;
  readonly sourceOut: number;
  /** Placement on the project grid (recordOut exclusive). */
  recordIn: number;
  recordOut: number;
  /** Constant speed = single segment; ramps produce multiple segments. */
  readonly speedSegments: SpeedSegment[];
  /** Transition attached to the head/tail of this clip, if any. */
  transitionIn: Transition | null;
  transitionOut: Transition | null;
  /** Free-form capability tags that may not survive EDL export. */
  readonly capabilities: string[];
}

export interface Track {
  readonly kind: TrackKind;
  readonly index: number;
  readonly clips: Clip[];
}

export interface Timeline {
  readonly name: string;
  /** Project frame grid everything is normalized onto. */
  readonly projectRate: FrameRate;
  readonly tracks: Track[];
  /** Provenance: which input files contributed. */
  readonly sources: string[];
}

export function clipDuration(clip: Clip): number {
  return clip.recordOut - clip.recordIn;
}

export function isSpeedAltered(clip: Clip): boolean {
  return clip.speedSegments.some((s) => s.speed !== 1 || s.ramp);
}

export function timelineDuration(timeline: Timeline): number {
  let end = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) end = Math.max(end, clip.recordOut);
  }
  return end;
}
