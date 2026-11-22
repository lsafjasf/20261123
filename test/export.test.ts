import assert from "node:assert/strict";
import test from "node:test";
import { buildReport, framesToCsv, summaryToCsv } from "../src/core/export.ts";
import type { FrameAnalysis, FrameClass } from "../src/core/types.ts";

function frame(index: number, classification: FrameClass, score: number): FrameAnalysis {
  return {
    index,
    timestampMs: index * 40,
    width: 960,
    height: 540,
    classification,
    confidence: score,
    tearScore: classification === "tear" ? score : 0.1,
    encodeScore: classification === "encode-block" ? score : 0.1,
    vfxScore: classification === "vfx-glitch" ? score : 0.1,
    seam:
      classification === "tear"
        ? {
            y: 180,
            yRatio: 1 / 3,
            shift: 72,
            shiftRatio: 0.075,
            boundary: 18,
            matchGain: 0.3,
            seamGain: 0.38,
            seamResidual: 8,
            seamBaseline: 17,
            support: 0.7,
            confidence: score,
            temporalSkew: 0.6,
          }
        : null,
    metrics: {
      lineDensity: 0.02,
      lineBurst: 0,
      lineRecurrence: 0.2,
      blockGrid: 0.1,
      blockAnomaly: 0.1,
      crossFrameSkew: 0.1,
      chromaShift: 0,
    },
    tags: classification === "tear" ? ["seam-shift", "cross-time-skew"] : [],
    note: "test",
  };
}

test("exports one CSV row per frame with a UTF-8 BOM", () => {
  const frames = [
    frame(0, "tear", 0.8),
    frame(1, "encode-block", 0.7),
  ];
  const csv = framesToCsv(frames);
  assert.ok(csv.startsWith("\uFEFFframe,"));
  assert.match(csv, /0,0,tear,0\.8000/);
  assert.match(csv, /1,40,encode-block,0\.7000/);
  assert.equal(csv.split("\r\n").filter(Boolean).length, 3);
});

test("exports stable classification buckets and JSON report metadata", () => {
  const frames = [
    frame(0, "tear", 0.8),
    frame(1, "encode-block", 0.7),
    frame(2, "vfx-glitch", 0.6),
    frame(3, "normal", 0.9),
  ];
  const report = buildReport(frames, {
    sourceName: "clip.mp4",
    sourceKind: "video",
    durationMs: 120,
    sampledFps: 24,
    analyzedAt: "2026-11-23T00:00:00.000Z",
    settings: { analysisWidth: 384, minShiftPx: 2, minSupport: 0.42 },
  });
  assert.equal(report.schema, "seamlab.report.v1");
  assert.equal(report.summary.frames, 4);
  assert.equal(report.summary.counts.normal, 1);
  const stats = summaryToCsv(report.summary);
  assert.match(stats, /tear,1,0\.250000/);
  assert.match(stats, /normal,1,0\.250000/);
});
