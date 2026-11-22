/**
 * CMX3600 EDL exporter with a capability-loss report. Everything in the
 * unified model that EDL cannot express is listed explicitly, per clip,
 * before the file is written.
 */

import type { Clip, Timeline } from "../core/model.ts";
import { isSpeedAltered } from "../core/model.ts";
import { formatTimecode } from "../core/timecode.ts";
import { toNumber } from "../core/rational.ts";

export interface LossEntry {
  readonly severity: "lost" | "degraded";
  readonly feature: string;
  readonly clips: string[];
  readonly reason: string;
}

export interface EdlExportResult {
  readonly edl: string;
  readonly losses: LossEntry[];
}

const MAX_AUDIO_TRACKS = 4;

export function exportEdl(timeline: Timeline): EdlExportResult {
  const rate = timeline.projectRate;
  const losses: LossEntry[] = [];
  const lines: string[] = [];
  lines.push(`TITLE: ${timeline.name.replace(/\s+/g, "_").slice(0, 40)}`);
  lines.push(rate.drop ? "FCM: DROP FRAME" : "FCM: NON-DROP FRAME");
  lines.push("");

  const videoTracks = timeline.tracks.filter((t) => t.kind === "video");
  const audioTracks = timeline.tracks.filter((t) => t.kind === "audio");
  if (videoTracks.length > 1) {
    losses.push({
      severity: "lost",
      feature: "multiple video tracks",
      clips: videoTracks.slice(1).flatMap((t) => t.clips.map((c) => c.name)),
      reason: "CMX3600 carries a single video track; upper lanes are dropped",
    });
  }
  if (audioTracks.length > MAX_AUDIO_TRACKS) {
    losses.push({
      severity: "lost",
      feature: `audio tracks beyond A${MAX_AUDIO_TRACKS}`,
      clips: audioTracks.slice(MAX_AUDIO_TRACKS).flatMap((t) => t.clips.map((c) => c.name)),
      reason: "CMX3600 supports at most 4 audio channels",
    });
  }

  let eventNo = 1;
  const emit = (clip: Clip, trackCode: string) => {
    const srcIn = formatTimecode(clip.sourceIn, clip.sourceRate);
    const srcOut = formatTimecode(clip.sourceOut, clip.sourceRate);
    const recIn = formatTimecode(clip.recordIn, rate);
    const recOut = formatTimecode(clip.recordOut, rate);
    const reel = clip.reel.slice(0, 8).padEnd(8, " ");
    const num = String(eventNo++).padStart(3, "0");
    const t = clip.transitionIn;
    let editField = "C        ";
    if (t && t.kind === "dissolve") editField = `D    ${String(t.duration).padStart(3, "0")}`;
    else if (t && t.kind === "wipe") editField = `W001 ${String(t.duration).padStart(3, "0")}`;
    lines.push(`${num}  ${reel} ${trackCode.padEnd(5)} ${editField} ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    lines.push(`* FROM CLIP NAME: ${clip.name}`);
    collectClipLosses(clip, timeline, losses);
    const seg = clip.speedSegments[0];
    if (isSpeedAltered(clip) && seg && !seg.ramp && clip.speedSegments.length === 1) {
      const pct = (seg.speed * 100).toFixed(1).padStart(6, " ");
      const motionTc = formatTimecode(seg.sourceStart, clip.sourceRate);
      lines.push(`M2   ${reel.trim().padEnd(8, " ")} ${pct}                ${motionTc}`);
    }
  };

  for (const clip of videoTracks[0]?.clips ?? []) emit(clip, "V");
  audioTracks.slice(0, MAX_AUDIO_TRACKS).forEach((track, i) => {
    for (const clip of track.clips) emit(clip, `A${i + 1}`);
  });

  return { edl: lines.join("\n") + "\n", losses: mergeLosses(losses) };
}

function collectClipLosses(clip: Clip, timeline: Timeline, losses: LossEntry[]): void {
  const projectFps = toNumber(timeline.projectRate.fps);
  if (Math.abs(toNumber(clip.sourceRate.fps) - projectFps) > 1e-6) {
    losses.push({
      severity: "degraded",
      feature: "mixed source frame rate",
      clips: [clip.name],
      reason: `source is ${clip.sourceRate.label} but EDL is written at ${timeline.projectRate.label}; source timecodes are conformed`,
    });
  }
  if (clip.speedSegments.some((s) => s.ramp)) {
    losses.push({
      severity: "lost",
      feature: "speed ramp",
      clips: [clip.name],
      reason: "EDL M2 records a single constant speed; ramp shape is lost",
    });
  } else if (clip.speedSegments.length > 1) {
    losses.push({
      severity: "lost",
      feature: "multiple speed segments",
      clips: [clip.name],
      reason: "EDL M2 supports one motion effect per event",
    });
  }
  for (const t of [clip.transitionIn, clip.transitionOut]) {
    if (t && t.kind !== "dissolve" && t.kind !== "wipe") {
      losses.push({
        severity: "lost",
        feature: `transition "${t.name}"`,
        clips: [clip.name],
        reason: "EDL only carries dissolve (D) and wipe (W); exported as a cut",
      });
    }
  }
  for (const cap of clip.capabilities) {
    if (cap.startsWith("retime:")) continue; // constant speed is exported via M2
    if (cap === "freeze-frame" || cap === "reverse") continue; // M2 can carry these
    losses.push({
      severity: "lost",
      feature: cap,
      clips: [clip.name],
      reason: "no CMX3600 representation",
    });
  }
}

function mergeLosses(losses: LossEntry[]): LossEntry[] {
  const map = new Map<string, { entry: LossEntry; clips: Set<string> }>();
  for (const loss of losses) {
    const key = `${loss.severity}|${loss.feature}|${loss.reason}`;
    const slot = map.get(key) ?? { entry: { ...loss, clips: [] }, clips: new Set<string>() };
    for (const c of loss.clips) slot.clips.add(c);
    map.set(key, slot);
  }
  return [...map.values()].map((slot) => ({
    severity: slot.entry.severity,
    feature: slot.entry.feature,
    reason: slot.entry.reason,
    clips: [...slot.clips],
  }));
}
