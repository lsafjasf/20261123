/**
 * Analysis pass over the unified timeline: speed changes, transitions,
 * missing media, and frame-rate conforms. Pure functions over the model;
 * filesystem checks are injected so this stays testable.
 */

import { existsSync } from "node:fs";
import type { Clip, Timeline } from "../core/model.ts";
import { isSpeedAltered } from "../core/model.ts";
import { toNumber } from "../core/rational.ts";

export interface SpeedFinding {
  readonly clipId: string;
  readonly clipName: string;
  readonly kind: "constant" | "ramp" | "freeze" | "reverse";
  readonly detail: string;
}

export interface TransitionFinding {
  readonly clipId: string;
  readonly clipName: string;
  readonly kind: string;
  readonly name: string;
  readonly durationFrames: number;
  readonly atFrame: number;
}

export interface MissingMediaFinding {
  readonly clipId: string;
  readonly clipName: string;
  readonly reel: string;
  readonly expectedPath: string | null;
  readonly reason: string;
}

export interface ConformFinding {
  readonly clipId: string;
  readonly clipName: string;
  readonly fromRate: string;
  readonly toRate: string;
}

export interface AnalysisReport {
  readonly timeline: string;
  readonly projectRate: string;
  readonly speed: SpeedFinding[];
  readonly transitions: TransitionFinding[];
  readonly missingMedia: MissingMediaFinding[];
  readonly conforms: ConformFinding[];
}

export function analyzeTimeline(
  timeline: Timeline,
  fileExists: (path: string) => boolean = existsSync,
): AnalysisReport {
  const speed: SpeedFinding[] = [];
  const transitions: TransitionFinding[] = [];
  const missingMedia: MissingMediaFinding[] = [];
  const conforms: ConformFinding[] = [];
  const projectFps = toNumber(timeline.projectRate.fps);

  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      collectSpeed(clip, speed);
      collectTransitions(clip, transitions);
      collectMedia(clip, missingMedia, fileExists);
      const srcFps = toNumber(clip.sourceRate.fps);
      if (Math.abs(srcFps - projectFps) > 1e-6) {
        conforms.push({
          clipId: clip.id,
          clipName: clip.name,
          fromRate: clip.sourceRate.label,
          toRate: timeline.projectRate.label,
        });
      }
    }
  }
  return {
    timeline: timeline.name,
    projectRate: timeline.projectRate.label,
    speed,
    transitions,
    missingMedia,
    conforms,
  };
}

function collectSpeed(clip: Clip, out: SpeedFinding[]): void {
  if (!isSpeedAltered(clip)) return;
  for (const seg of clip.speedSegments) {
    let kind: SpeedFinding["kind"] = "constant";
    if (seg.speed === 0) kind = "freeze";
    else if (seg.speed < 0) kind = "reverse";
    else if (seg.ramp) kind = "ramp";
    out.push({
      clipId: clip.id,
      clipName: clip.name,
      kind,
      detail: `${seg.speed}x over ${seg.timelineDuration} project frames from source frame ${seg.sourceStart}`,
    });
  }
}

function collectTransitions(clip: Clip, out: TransitionFinding[]): void {
  for (const t of [clip.transitionIn, clip.transitionOut]) {
    if (!t) continue;
    out.push({
      clipId: clip.id,
      clipName: clip.name,
      kind: t.kind,
      name: t.name,
      durationFrames: t.duration,
      atFrame: t.at,
    });
  }
}

function collectMedia(
  clip: Clip,
  out: MissingMediaFinding[],
  fileExists: (path: string) => boolean,
): void {
  if (clip.capabilities.includes("title")) return; // generated media, no file expected
  if (clip.mediaPath) {
    if (!fileExists(clip.mediaPath)) {
      out.push({
        clipId: clip.id,
        clipName: clip.name,
        reel: clip.reel,
        expectedPath: clip.mediaPath,
        reason: "referenced file not found on disk",
      });
    }
    return;
  }
  if (clip.reel && clip.reel !== "AX" && clip.reel !== "BL") {
    out.push({
      clipId: clip.id,
      clipName: clip.name,
      reel: clip.reel,
      expectedPath: null,
      reason: "no media path in source file; reel name only",
    });
  }
}
