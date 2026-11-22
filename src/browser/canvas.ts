import type { AnalysisResult, AnalysisWindow } from "../shared/types.ts";

export interface CanvasState {
  result: AnalysisResult;
  playheadSec: number;
  selectionIndex: number | null;
}

const KIND_COLOR: Record<AnalysisWindow["kind"], string> = {
  silence: "#4b5563",
  music: "#a855f7",
  ambient: "#38bdf8",
  transient: "#facc15",
};

export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  result: AnalysisResult,
  playheadSec: number,
): void {
  const context = canvas.getContext("2d")!;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0f172a";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#7dd3fc";
  context.lineWidth = 1;
  context.beginPath();
  for (let x = 0; x < peaks.length; x++) {
    const peak = peaks[x]!;
    const y = (peak * 0.9 * height) / 2;
    context.moveTo(x + 0.5, height / 2 - y);
    context.lineTo(x + 0.5, height / 2 + y);
  }
  context.stroke();

  for (const window of result.windows) {
    if (!window.excluded) continue;
    const x0 = (window.start / result.duration) * width;
    const x1 = (window.end / result.duration) * width;
    context.fillStyle = window.kind === "silence" ? "rgba(75,85,99,0.45)" : "rgba(168,85,247,0.35)";
    context.fillRect(x0, 0, Math.max(1, x1 - x0), height);
  }
  drawPlayhead(context, width, height, playheadSec, result.duration);
}

export function computePeaks(mono: Float32Array, buckets: number): Float32Array {
  const peaks = new Float32Array(buckets);
  const perBucket = Math.max(1, Math.floor(mono.length / buckets));
  for (let x = 0; x < buckets; x++) {
    let peak = 0;
    const start = x * perBucket;
    for (let i = 0; i < perBucket; i++) peak = Math.max(peak, Math.abs(mono[start + i] ?? 0));
    peaks[x] = peak;
  }
  return peaks;
}

export function drawCurve(canvas: HTMLCanvasElement, state: CanvasState): void {
  const { result } = state;
  const context = canvas.getContext("2d")!;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0f172a";
  context.fillRect(0, 0, width, height);
  const values = result.windows.filter((w) => w.lagMs !== null).map((w) => w.lagMs!);
  const minOffset = Math.min(0, ...values) - 10;
  const maxOffset = Math.max(0, ...values) + 10;
  const yFor = (ms: number) => height - ((ms - minOffset) / (maxOffset - minOffset)) * height;

  context.strokeStyle = "#334155";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, yFor(0));
  context.lineTo(width, yFor(0));
  context.stroke();

  for (const segment of result.segments) {
    context.strokeStyle = segment.enabled ? "#34d399" : "#64748b";
    context.lineWidth = 2.5;
    context.beginPath();
    const x0 = (segment.start / result.duration) * width;
    const x1 = (segment.end / result.duration) * width;
    context.moveTo(x0, yFor(segment.offsetMsAtStart));
    context.lineTo(x1, yFor(segment.offsetMsAtEnd));
    context.stroke();
    if (!segment.enabled) {
      context.strokeStyle = "rgba(100,116,139,0.5)";
      context.beginPath();
      context.moveTo(x0, 4);
      context.lineTo(x1, 4);
      context.stroke();
    }
  }

  for (const window of result.windows) {
    if (window.lagMs === null || window.excluded) continue;
    const t = (window.start + window.end) / 2;
    const x = (t / result.duration) * width;
    const y = yFor(window.lagMs);
    context.fillStyle = KIND_COLOR[window.kind];
    context.globalAlpha = 0.35 + 0.65 * window.confidence;
    context.beginPath();
    context.arc(x, y, window.kind === "transient" ? 4 : 2.5, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
  }

  if (state.selectionIndex !== null) {
    const window = result.windows[state.selectionIndex];
    if (window && window.lagMs !== null) {
      const t = (window.start + window.end) / 2;
      context.strokeStyle = "#f8fafc";
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc((t / result.duration) * width, yFor(window.lagMs), 7, 0, Math.PI * 2);
      context.stroke();
    }
  }
  drawPlayhead(context, width, height, state.playheadSec, result.duration);
}

function drawPlayhead(context: CanvasRenderingContext2D, width: number, height: number, playheadSec: number, duration: number): void {
  const x = (playheadSec / Math.max(1e-9, duration)) * width;
  context.strokeStyle = "#fb7185";
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, height);
  context.stroke();
}

export function windowAtX(result: AnalysisResult, x: number, width: number): number {
  const t = (x / width) * result.duration;
  const found = result.windows.findIndex((w) => t >= w.start && t < w.end);
  return found;
}
