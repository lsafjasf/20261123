/**
 * FCPXML parser -> ingest intermediate. Handles: format frame rates,
 * asset-clip/clip/video/audio/gap, connected clips (lanes), transitions,
 * conform-rate retiming and timeMap/timeRamp speed ramps.
 */

import { rat, div, add, sub, mul } from "../core/rational.ts";
import type { Rational } from "../core/rational.ts";
import { rateFromRational, rateFromNumber } from "../core/timecode.ts";
import type { FrameRate } from "../core/timecode.ts";
import type { IngestClip, IngestResult, IngestSpeedSegment, IngestTransition } from "../core/ingest.ts";
import { parseXml, attr, children, firstChild } from "./xml.ts";
import type { XmlElement } from "./xml.ts";
import type { TrackKind, TransitionKind } from "../core/model.ts";

/** Parse FCPXML time values: "1001/24000s", "5s", "0s", "1/25s". */
export function parseFcpxTime(value: string | null): Rational {
  if (value === null) return rat(0);
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(value.trim());
  if (!m) throw new Error(`invalid FCPXML time: "${value}"`);
  return rat(BigInt(m[1]), m[2] ? BigInt(m[2]) : 1n);
}

interface AssetInfo {
  readonly src: string | null;
  readonly name: string;
  readonly start: Rational;
  readonly rate: FrameRate | null;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

function transitionKindOf(name: string): TransitionKind {
  const n = name.toLowerCase();
  if (n.includes("dissolve")) return "dissolve";
  if (n.includes("wipe")) return "wipe";
  if (n.includes("dip")) return "dip";
  return "other";
}

export function parseFcpxml(text: string, sourceFile: string): IngestResult {
  const root = parseXml(text);
  if (root.name !== "fcpxml") throw new Error("not an FCPXML document");
  const warnings: string[] = [];

  const formats = new Map<string, FrameRate>();
  const assets = new Map<string, AssetInfo>();
  const resources = firstChild(root, "resources");
  if (resources) {
    for (const fmt of children(resources, "format")) {
      const id = attr(fmt, "id");
      const frameDuration = attr(fmt, "frameDuration");
      if (!id || !frameDuration) continue;
      const fd = parseFcpxTime(frameDuration);
      const fps = div(rat(1), fd);
      formats.set(id, rateFromRational(Number(fps.num), Number(fps.den)));
    }
    for (const asset of children(resources, "asset")) {
      const id = attr(asset, "id");
      if (!id) continue;
      const fmtId = attr(asset, "format");
      assets.set(id, {
        src: attr(asset, "src"),
        name: attr(asset, "name") ?? id,
        start: parseFcpxTime(attr(asset, "start")),
        rate: fmtId ? formats.get(fmtId) ?? null : null,
        hasVideo: attr(asset, "hasVideo") === "1",
        hasAudio: attr(asset, "hasAudio") === "1",
      });
    }
  }

  const sequence = findFirst(root, "sequence");
  if (!sequence) throw new Error("FCPXML contains no <sequence>");
  const seqFormatId = attr(sequence, "format");
  const seqRate = (seqFormatId && formats.get(seqFormatId)) || null;
  if (!seqRate) warnings.push("sequence format missing or unknown; rates may be wrong");
  const tcStart = parseFcpxTime(attr(sequence, "tcStart"));
  const tcFormat = attr(sequence, "tcFormat");
  let timelineRate = seqRate;
  if (timelineRate && tcFormat === "DF") {
    timelineRate = rateFromRational(Number(timelineRate.fps.num), Number(timelineRate.fps.den), true);
  }

  const project = findFirst(root, "project");
  const title = (project && attr(project, "name")) || sourceFile;
  const clips: IngestClip[] = [];
  const pendingTransitions: IngestTransition[] = [];
  const spine = firstChild(sequence, "spine");
  if (spine) walkStoryElement(spine, 0, "video");

  function findFirst(el: XmlElement, name: string): XmlElement | null {
    if (el.name === name) return el;
    for (const c of el.children) {
      const hit = findFirst(c, name);
      if (hit) return hit;
    }
    return null;
  }

  function walkStoryElement(parent: XmlElement, lane: number, parentKind: TrackKind): void {
    for (const el of parent.children) {
      if (el.name === "gap") {
        walkStoryElement(el, lane, parentKind);
        continue;
      }
      if (el.name === "transition") {
        // Standalone transition between two spine clips.
        const at = add(tcStart, parseFcpxTime(attr(el, "offset")));
        const name = attr(el, "name") ?? "transition";
        pendingTransitions.push({
          kind: transitionKindOf(name),
          name,
          duration: parseFcpxTime(attr(el, "duration")),
          at,
        });
        continue;
      }
      if (el.name === "asset-clip" || el.name === "clip" || el.name === "video" || el.name === "audio" || el.name === "title") {
        const elLane = Number(attr(el, "lane") ?? lane);
        emitClip(el, el.name === "title" ? parentKind : kindOf(el), elLane);
        // Connected clips sit on their own lanes.
        for (const kid of el.children) {
          if (["asset-clip", "clip", "video", "audio", "title", "gap"].includes(kid.name)) {
            const kidLane = Number(attr(kid, "lane") ?? "0");
            if (kid.name === "gap") walkStoryElement(kid, kidLane, parentKind);
            else emitClip(kid, kindOf(kid), kidLane);
          }
        }
      }
    }
  }

  function kindOf(el: XmlElement): TrackKind {
    if (el.name === "audio") return "audio";
    if (el.name === "video" || el.name === "title") return "video";
    const ref = attr(el, "ref");
    const asset = ref ? assets.get(ref) : null;
    if (asset) return asset.hasVideo ? "video" : "audio";
    return "video";
  }

  function emitClip(el: XmlElement, kind: TrackKind, lane: number): void {
    const ref = attr(el, "ref");
    const asset = ref ? assets.get(ref) : null;
    const offset = parseFcpxTime(attr(el, "offset"));
    const duration = parseFcpxTime(attr(el, "duration"));
    const start = attr(el, "start") !== null ? parseFcpxTime(attr(el, "start")) : asset?.start ?? rat(0);
    const recordIn = add(tcStart, offset);
    const recordOut = add(recordIn, duration);
    const sourceRate = asset?.rate ?? timelineRate ?? rateFromNumber(25);

    const capabilities: string[] = [];
    if (el.name === "title") capabilities.push("title");
    if (kind === "video" && lane > 0) capabilities.push(`connected-clip:lane${lane}`);

    const speedSegments: IngestSpeedSegment[] = [];
    const conform = firstChild(el, "conform-rate");
    const timeMap = firstChild(el, "timeMap");
    if (timeMap) {
      const ramp = firstChild(timeMap, "timeRamp");
      if (ramp) {
        buildRampSegments(ramp, duration, speedSegments, warnings);
      } else {
        warnings.push(`timeMap without timeRamp on "${attr(el, "name") ?? ref}"; treated as normal speed`);
      }
    }
    if (speedSegments.length === 0 && conform && attr(conform, "speedEnabled") === "1") {
      const multiplier = Number(attr(conform, "speedMultiplier") ?? "1");
      const srcRate = attr(conform, "srcFrameRate");
      speedSegments.push({
        timelineStart: rat(0),
        timelineDuration: duration,
        sourceStart: start,
        speed: multiplier,
        ramp: false,
      });
      capabilities.push(`retime:${multiplier}x${srcRate ? ` (src ${srcRate}fps)` : ""}`);
    }
    if (speedSegments.length === 0) {
      speedSegments.push({
        timelineStart: rat(0),
        timelineDuration: duration,
        sourceStart: start,
        speed: 1,
        ramp: false,
      });
    }

    const transitions: IngestTransition[] = [];
    for (const t of children(el, "transition")) {
      const name = attr(t, "name") ?? "transition";
      transitions.push({
        kind: transitionKindOf(name),
        name,
        duration: parseFcpxTime(attr(t, "duration")),
        at: add(tcStart, parseFcpxTime(attr(t, "offset"))),
      });
    }

    const mediaPath = asset?.src ? decodeURIComponent(asset.src.replace(/^file:\/\//, "")) : null;
    clips.push({
      name: attr(el, "name") ?? asset?.name ?? ref ?? "clip",
      reel: ref ?? "",
      mediaPath,
      sourceRate,
      sourceIn: start,
      sourceOut: add(start, mul(duration, rat(Math.round(Math.abs(speedSegments[0]?.speed ?? 1) * 1000), 1000))),
      recordIn,
      recordOut,
      speedSegments,
      transitions,
      capabilities,
      kind,
      lane: kind === "audio" ? Math.abs(lane) : lane,
    });
  }

  // Attach standalone spine transitions to the nearest following clip.
  for (const t of pendingTransitions) {
    let best: IngestClip | null = null;
    for (const c of clips) {
      if (c.kind !== "video") continue;
      if (c.recordIn.num * t.at.den >= t.at.num * c.recordIn.den) {
        if (!best || c.recordIn.num * best.recordIn.den < best.recordIn.num * c.recordIn.den) best = c;
      }
    }
    if (best) best.transitions.push(t);
  }

  return { title, sourceFile, declaredRate: timelineRate, clips, warnings };
}

function buildRampSegments(
  ramp: XmlElement,
  clipDuration: Rational,
  out: IngestSpeedSegment[],
  warnings: string[],
): void {
  const points: Array<{ time: Rational; value: Rational }> = [];
  for (const p of ramp.children) {
    if (p.name !== "time") continue;
    points.push({ time: parseFcpxTime(attr(p, "time")), value: parseFcpxTime(attr(p, "value")) });
  }
  if (points.length < 2) {
    warnings.push("timeRamp with fewer than 2 points; treated as normal speed");
    return;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const tlDur = sub(b.time, a.time);
    const srcDur = sub(b.value, a.value);
    const speedNum = Number(srcDur.num) / Number(srcDur.den);
    const speedDen = Number(tlDur.num) / Number(tlDur.den);
    out.push({
      timelineStart: a.time,
      timelineDuration: tlDur,
      sourceStart: a.value,
      speed: speedDen === 0 ? 0 : speedNum / speedDen,
      ramp: true,
    });
  }
}
