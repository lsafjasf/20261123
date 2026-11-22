import { summarize } from "./analyzer.ts";
import type { AnalysisSummary, FrameAnalysis, FrameClass } from "./types.ts";

export interface ReportMeta {
  sourceName: string;
  sourceKind: "video" | "demo";
  durationMs: number;
  sampledFps: number;
  analyzedAt: string;
  settings: {
    analysisWidth: number;
    minShiftPx: number;
    minSupport: number;
  };
}

export interface AnalysisReport {
  schema: "seamlab.report.v1";
  meta: ReportMeta;
  summary: AnalysisSummary;
  frames: FrameAnalysis[];
}

export const CLASS_LABELS: Record<FrameClass, string> = {
  tear: "采集撕裂",
  "encode-block": "编码块错误",
  "vfx-glitch": "游戏故障特效",
  uncertain: "证据不足",
  normal: "正常",
};

export function buildReport(frames: FrameAnalysis[], meta: ReportMeta): AnalysisReport {
  return {
    schema: "seamlab.report.v1",
    meta,
    summary: summarize(frames),
    frames,
  };
}

export function framesToCsv(frames: FrameAnalysis[]): string {
  const header = [
    "frame",
    "timestamp_ms",
    "classification",
    "confidence",
    "tear_score",
    "encode_score",
    "vfx_score",
    "seam_y",
    "seam_shift_px",
    "seam_support",
    "seam_gain",
    "cross_frame_skew",
    "line_density",
    "line_burst",
    "block_grid",
    "block_anomaly",
    "tags",
    "note",
  ];
  const rows = frames.map((frame) => [
    frame.index,
    frame.timestampMs.toFixed(0),
    frame.classification,
    frame.confidence.toFixed(4),
    frame.tearScore.toFixed(4),
    frame.encodeScore.toFixed(4),
    frame.vfxScore.toFixed(4),
    frame.seam?.y ?? "",
    frame.seam?.shift ?? "",
    frame.seam?.support.toFixed(4) ?? "",
    frame.seam?.matchGain.toFixed(4) ?? "",
    frame.metrics.crossFrameSkew.toFixed(4),
    frame.metrics.lineDensity.toFixed(4),
    frame.metrics.lineBurst.toFixed(4),
    frame.metrics.blockGrid.toFixed(4),
    frame.metrics.blockAnomaly.toFixed(4),
    frame.tags.join("|"),
    escapeCsv(frame.note),
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.join(",")).join("\r\n")}\r\n`;
}

export function summaryToCsv(summary: AnalysisSummary): string {
  const rows: Array<[FrameClass | "flagged" | "frames", number]> = [
    ["frames", summary.frames],
    ["tear", summary.counts.tear],
    ["encode-block", summary.counts["encode-block"]],
    ["vfx-glitch", summary.counts["vfx-glitch"]],
    ["uncertain", summary.counts.uncertain],
    ["normal", summary.counts.normal],
    ["flagged", summary.flaggedFrames],
  ];
  return `\uFEFFbucket,count,ratio\r\n${rows
    .map(([bucket, count]) => {
      const ratio = bucket === "frames" || bucket === "flagged" ? "" : count / Math.max(1, summary.frames);
      return `${bucket},${count},${ratio === "" ? "" : ratio.toFixed(6)}`;
    })
    .join("\r\n")}\r\n`;
}

export function reportToJson(report: AnalysisReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function escapeCsv(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
