import type { AnalysisResult } from "./types.ts";
import { offsetAt } from "./analyze.ts";

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildSyncTableCsv(result: AnalysisResult): string {
  const header = [
    "window_index",
    "start_sec",
    "end_sec",
    "kind",
    "usable",
    "excluded",
    "offset_ms",
    "corr_z",
    "confidence",
  ];
  const rows = result.windows.map((w) =>
    [
      w.index,
      w.start.toFixed(3),
      w.end.toFixed(3),
      w.kind,
      w.usable ? 1 : 0,
      w.excluded ? 1 : 0,
      w.lagMs === null ? "" : w.lagMs.toFixed(3),
      w.corrZ.toFixed(3),
      w.confidence.toFixed(3),
    ].map(csvCell).join(","),
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

export function buildKeyframeCsv(result: AnalysisResult, intervalSec = 1): string {
  const header = ["time_sec", "timecode", "offset_ms", "stretch_factor", "curve_confidence"];
  const rows: string[] = [];
  for (let t = 0; t <= result.duration + 1e-9; t += intervalSec) {
    const segment = result.segments.find((s) => s.enabled && t >= s.start && t < s.end);
    const confidence = segment?.confidence ?? 0;
    const stretch = segment ? segment.stretchFactor : 1 + result.globalFit.slopeMsPerSec / 1000;
    rows.push(
      [t.toFixed(3), secondsToTimecode(t), offsetAt(result, t).toFixed(3), stretch.toFixed(6), confidence.toFixed(3)]
        .map(csvCell)
        .join(","),
    );
  }
  return [header.join(","), ...rows].join("\n") + "\n";
}

export function buildSegmentCsv(result: AnalysisResult): string {
  const header = [
    "segment",
    "start_sec",
    "end_sec",
    "offset_start_ms",
    "offset_end_ms",
    "slope_ms_per_sec",
    "stretch_factor",
    "confidence",
    "residual_ms",
    "anchors",
    "enabled",
  ];
  const rows = result.segments.map((s) =>
    [
      s.index,
      s.start.toFixed(3),
      s.end.toFixed(3),
      s.offsetMsAtStart.toFixed(3),
      s.offsetMsAtEnd.toFixed(3),
      s.slopeMsPerSec.toFixed(4),
      s.stretchFactor.toFixed(6),
      s.confidence.toFixed(3),
      s.residualMs.toFixed(3),
      s.anchorCount,
      s.enabled ? 1 : 0,
    ].map(csvCell).join(","),
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

export function buildLabels(result: AnalysisResult): string {
  const lines = result.windows
    .filter((w) => !w.excluded && w.lagMs !== null)
    .map((w) => {
      const mid = (w.start + w.end) / 2;
      return `${secondsToTimecode(w.start)}\t${secondsToTimecode(w.end)}\t${w.kind} ${w.lagMs!.toFixed(1)}ms c=${w.confidence.toFixed(2)} @${mid.toFixed(2)}s`;
    });
  return lines.join("\n") + "\n";
}

export function buildProjectJson(result: AnalysisResult, referenceName: string, recordedName: string): string {
  return JSON.stringify(
    {
      format: "sync-lab/project/v1",
      reference: referenceName,
      recorded: recordedName,
      signConvention: "positive offsetMs means recorder event is later than camera; renderer subtracts it (moves recorder earlier)",
      ...result,
    },
    null,
    2,
  );
}

export function secondsToTimecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":") + "." + String(ms).padStart(3, "0");
}
