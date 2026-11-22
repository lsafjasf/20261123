/**
 * Normalizes ingest results onto a single project frame grid, producing the
 * unified per-frame Timeline model. All rounding happens here, exactly once,
 * using rational arithmetic.
 */

import { rat, mul, round, toNumber } from "./rational.ts";
import type { Rational } from "./rational.ts";
import type { FrameRate } from "./timecode.ts";
import { RATE_25 } from "./timecode.ts";
import type { Clip, SpeedSegment, Timeline, Track, Transition } from "./model.ts";
import type { IngestClip, IngestResult } from "./ingest.ts";

function secondsToFrames(seconds: Rational, rate: FrameRate): number {
  return Number(round(mul(seconds, rate.fps)));
}

export function pickProjectRate(inputs: IngestResult[], override: FrameRate | null): FrameRate {
  if (override) return override;
  const counts = new Map<string, { rate: FrameRate; n: number }>();
  for (const input of inputs) {
    if (!input.declaredRate) continue;
    const key = input.declaredRate.label;
    const entry = counts.get(key) ?? { rate: input.declaredRate, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  let best: { rate: FrameRate; n: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.n > best.n) best = entry;
  }
  return best ? best.rate : RATE_25;
}

function normalizeClip(raw: IngestClip, projectRate: FrameRate, id: string): Clip {
  const speedSegments: SpeedSegment[] = raw.speedSegments.map((s) => ({
    timelineStart: secondsToFrames(s.timelineStart, projectRate),
    timelineDuration: secondsToFrames(s.timelineDuration, projectRate),
    sourceStart: secondsToFrames(s.sourceStart, raw.sourceRate),
    speed: s.speed,
    ramp: s.ramp,
  }));
  const transitions: Transition[] = raw.transitions.map((t) => ({
    kind: t.kind,
    name: t.name,
    duration: secondsToFrames(t.duration, projectRate),
    at: secondsToFrames(t.at, projectRate),
  }));
  const clip: Clip = {
    id,
    name: raw.name,
    reel: raw.reel,
    mediaPath: raw.mediaPath,
    sourceRate: raw.sourceRate,
    sourceIn: secondsToFrames(raw.sourceIn, raw.sourceRate),
    sourceOut: secondsToFrames(raw.sourceOut, raw.sourceRate),
    recordIn: secondsToFrames(raw.recordIn, projectRate),
    recordOut: secondsToFrames(raw.recordOut, projectRate),
    speedSegments,
    transitionIn: null,
    transitionOut: null,
    capabilities: [...raw.capabilities],
  };
  for (const t of transitions) {
    // Head transition: starts at the clip's first frame. Tail transition:
    // ends at the clip's last frame. Anything else stays a capability note.
    if (Math.abs(t.at - clip.recordIn) <= 1) clip.transitionIn = t;
    else if (Math.abs(t.at + t.duration - clip.recordOut) <= 1) clip.transitionOut = t;
    else clip.capabilities.push(`transition:${t.name}@${t.at}`);
  }
  return clip;
}

export function normalizeOne(input: IngestResult, projectRate: FrameRate): Timeline {
  const trackMap = new Map<string, Track>();
  let clipCounter = 0;
  for (const raw of input.clips) {
    const key = `${raw.kind}:${raw.lane}`;
    let track = trackMap.get(key);
    if (!track) {
      track = { kind: raw.kind, index: raw.lane, clips: [] };
      trackMap.set(key, track);
    }
    track.clips.push(normalizeClip(raw, projectRate, `${input.sourceFile}#${clipCounter++}`));
  }
  const tracks = [...trackMap.values()].sort((a, b) =>
    a.kind === b.kind ? a.index - b.index : a.kind === "video" ? -1 : 1,
  );
  for (const track of tracks) {
    track.clips.sort((a, b) => a.recordIn - b.recordIn);
  }
  return {
    name: input.title || input.sourceFile,
    projectRate,
    tracks,
    sources: [input.sourceFile],
  };
}

/**
 * Stacks several normalized timelines into one master timeline for unified
 * inspection. Each source keeps its own tracks (suffixed by source) and its
 * original record placement on the shared project grid.
 */
export function combineTimelines(timelines: Timeline[], projectRate: FrameRate): Timeline {
  const tracks: Track[] = [];
  const sources: string[] = [];
  for (const tl of timelines) {
    sources.push(...tl.sources);
    for (const track of tl.tracks) {
      tracks.push({ kind: track.kind, index: tracks.length, clips: track.clips });
    }
  }
  return { name: "combined", projectRate, tracks, sources };
}

export function frameRateNote(clip: Clip, projectRate: FrameRate): string | null {
  const src = toNumber(clip.sourceRate.fps);
  const dst = toNumber(projectRate.fps);
  if (Math.abs(src - dst) < 1e-9) return null;
  return `conform ${clip.sourceRate.label} -> ${projectRate.label}`;
}
