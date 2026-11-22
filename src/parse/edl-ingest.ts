/**
 * Converts a parsed CMX3600 document into the ingest intermediate.
 * EDL carries no explicit frame rate, so the caller supplies one
 * (CLI flag, or derived from the FCM line: drop -> 29.97 DF).
 */

import { rat } from "../core/rational.ts";
import type { FrameRate } from "../core/timecode.ts";
import { parseTimecode, framesToSeconds, RATE_2997_DF, RATE_25 } from "../core/timecode.ts";
import type { IngestClip, IngestResult } from "../core/ingest.ts";
import type { EdlDocument, EdlEvent } from "./edl.ts";
import type { TrackKind } from "../core/model.ts";

function trackOf(code: string): { kind: TrackKind; lane: number } {
  if (code === "V" || code === "B" || code === "VB" || code === "AA/V") return { kind: "video", lane: 0 };
  if (code === "A") return { kind: "audio", lane: 0 };
  if (code === "AA") return { kind: "audio", lane: 0 };
  const m = /^A(\d+)$/.exec(code);
  if (m) return { kind: "audio", lane: Number(m[1]) - 1 };
  return { kind: "video", lane: 0 };
}

function eventToClip(ev: EdlEvent, rate: FrameRate): IngestClip {
  const { kind, lane } = trackOf(ev.trackCode);
  const sourceIn = parseTimecode(ev.sourceInTc, rate);
  const sourceOut = parseTimecode(ev.sourceOutTc, rate);
  const recordIn = parseTimecode(ev.recordInTc, rate);
  const recordOut = parseTimecode(ev.recordOutTc, rate);

  const speedSegments: IngestClip["speedSegments"] = [];
  const capabilities: string[] = [];
  if (ev.motion) {
    const speed = ev.motion.speedPercent / 100;
    const motionStart = parseTimecode(ev.motion.sourceStartTc, rate);
    speedSegments.push({
      timelineStart: rat(0),
      timelineDuration: framesToSeconds(recordOut - recordIn, rate),
      sourceStart: framesToSeconds(motionStart, rate),
      speed,
      ramp: false,
    });
    if (speed === 0) capabilities.push("freeze-frame");
    if (speed < 0) capabilities.push("reverse");
  } else {
    speedSegments.push({
      timelineStart: rat(0),
      timelineDuration: framesToSeconds(recordOut - recordIn, rate),
      sourceStart: framesToSeconds(sourceIn, rate),
      speed: 1,
      ramp: false,
    });
  }

  const transitions: IngestClip["transitions"] = [];
  if (ev.editCode === "D" && ev.transitionFrames > 0) {
    transitions.push({
      kind: "dissolve",
      name: "Cross Dissolve",
      duration: framesToSeconds(ev.transitionFrames, rate),
      at: framesToSeconds(recordIn, rate),
    });
  } else if (ev.editCode === "W") {
    transitions.push({
      kind: "wipe",
      name: ev.wipeCode ?? "Wipe",
      duration: framesToSeconds(ev.transitionFrames, rate),
      at: framesToSeconds(recordIn, rate),
    });
  } else if (ev.editCode === "K") {
    capabilities.push("key-event");
  }

  return {
    name: ev.clipName ?? `${ev.reel} event ${ev.number}`,
    reel: ev.reel,
    mediaPath: null,
    sourceRate: rate,
    sourceIn: framesToSeconds(sourceIn, rate),
    sourceOut: framesToSeconds(sourceOut, rate),
    recordIn: framesToSeconds(recordIn, rate),
    recordOut: framesToSeconds(recordOut, rate),
    speedSegments,
    transitions,
    capabilities,
    kind,
    lane,
  };
}

export function edlToIngest(doc: EdlDocument, sourceFile: string, rate: FrameRate | null): IngestResult {
  const effective = rate ?? (doc.dropFrame ? RATE_2997_DF : RATE_25);
  const warnings = [...doc.warnings];
  if (!rate && doc.dropFrame === null) {
    warnings.push(`no FCM line and no --rate given; assuming ${effective.label}`);
  }
  return {
    title: doc.title,
    sourceFile,
    declaredRate: effective,
    clips: doc.events.map((ev) => eventToClip(ev, effective)),
    warnings,
  };
}
