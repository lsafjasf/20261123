import type {
  AudioFeatures,
  MatchGroup,
  MatchOccurrence,
} from "../shared/types.ts";
import type { WaveformPeaks } from "./audio.ts";

interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

function prepare(canvas: HTMLCanvasElement): CanvasSize {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  return { width, height, dpr };
}

function background(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  context.fillStyle = "rgba(8, 13, 20, 0.72)";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(255, 255, 255, 0.055)";
  context.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (height * i) / 4;
    context.beginPath();
    context.moveTo(0, y + 0.5);
    context.lineTo(width, y + 0.5);
    context.stroke();
  }
}

function peakRange(
  peaks: WaveformPeaks,
  fromSec: number,
  toSec: number,
): [number, number] {
  return [
    Math.max(0, Math.floor(fromSec * peaks.rate)),
    Math.min(peaks.min.length, Math.ceil(toSec * peaks.rate)),
  ];
}

export interface WaveformStyle {
  color: string;
  fill?: string;
  playhead?: number | null;
  grid?: boolean;
}

export function drawWaveformStrip(
  canvas: HTMLCanvasElement,
  peaks: WaveformPeaks,
  startSec: number,
  endSec: number,
  style: WaveformStyle,
): void {
  const { width, height } = prepare(canvas);
  background(
    canvas.getContext("2d") as CanvasRenderingContext2D,
    width,
    height,
  );
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  const [from, to] = peakRange(peaks, startSec, endSec);
  const count = Math.max(1, to - from);
  const center = height / 2;
  const amplitude = height * 0.39;
  const path = new Path2D();
  for (let x = 0; x < width; x++) {
    const index = from + Math.floor((x / width) * count);
    const low = peaks.min[Math.min(index, peaks.min.length - 1)] ?? 0;
    const high = peaks.max[Math.min(index, peaks.max.length - 1)] ?? 0;
    const top = center - high * amplitude * 2;
    const bottom = center - low * amplitude * 2;
    path.moveTo(x + 0.5, top);
    path.lineTo(x + 0.5, Math.max(top + 1, bottom));
  }
  if (style.fill) {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, style.fill);
    gradient.addColorStop(0.5, style.color);
    gradient.addColorStop(1, style.fill);
    context.strokeStyle = gradient;
  } else {
    context.strokeStyle = style.color;
  }
  context.lineWidth = 1;
  context.stroke(path);
  if (style.playhead !== undefined && style.playhead !== null) {
    const x = ((style.playhead - startSec) / (endSec - startSec)) * width;
    context.fillStyle = "#f4f1e8";
    context.fillRect(Math.max(0, Math.min(width - 1, x)), 0, 1, height);
  }
}

export function drawOverview(
  canvas: HTMLCanvasElement,
  peaks: WaveformPeaks,
  durationSec: number,
  groups: MatchGroup[],
  selectedId: string | null,
  playheadSec: number | null,
): void {
  const { width, height } = prepare(canvas);
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  background(context, width, height);
  const [from, to] = peakRange(peaks, 0, durationSec);
  const count = Math.max(1, to - from);
  const center = height / 2;
  const amplitude = height * 0.42;
  context.beginPath();
  for (let x = 0; x < width; x++) {
    const index = from + Math.floor((x / width) * count);
    const low = peaks.min[Math.min(index, peaks.min.length - 1)] ?? 0;
    const high = peaks.max[Math.min(index, peaks.max.length - 1)] ?? 0;
    context.moveTo(x + 0.5, center - high * amplitude * 2);
    context.lineTo(x + 0.5, center - low * amplitude * 2);
  }
  context.strokeStyle = "rgba(159, 177, 194, 0.52)";
  context.lineWidth = 1;
  context.stroke();

  for (const group of groups) {
    const active = group.id === selectedId;
    const color =
      group.status === "confirmed"
        ? "rgba(101, 219, 179, 0.26)"
        : group.status === "rejected"
          ? "rgba(148, 156, 166, 0.12)"
          : active
            ? "rgba(242, 176, 92, 0.32)"
            : "rgba(242, 176, 92, 0.13)";
    for (const occurrence of group.occurrences) {
      const x = (occurrence.start / durationSec) * width;
      const w = Math.max(2, ((occurrence.end - occurrence.start) / durationSec) * width);
      context.fillStyle = color;
      context.fillRect(x, 0, w, height);
      context.fillStyle = active ? "#f2b05c" : "rgba(242, 176, 92, 0.62)";
      context.fillRect(x, 0, 1, height);
    }
  }
  if (playheadSec !== null) {
    const x = (playheadSec / durationSec) * width;
    context.fillStyle = "#f7f2e7";
    context.fillRect(Math.max(0, Math.min(width - 1, x)), 0, 1.5, height);
  }
  context.fillStyle = "rgba(8, 13, 20, 0.38)";
  context.fillRect(0, height - 1, width, 1);
}

function drawPitchLine(
  context: CanvasRenderingContext2D,
  features: AudioFeatures,
  occurrence: MatchOccurrence,
  width: number,
  top: number,
  height: number,
  color: string,
): void {
  const from = Math.max(0, Math.floor(occurrence.start / features.hopSec));
  const to = Math.min(
    features.frameCount,
    Math.ceil(occurrence.end / features.hopSec),
  );
  const pitches: number[] = [];
  for (let frame = from; frame < to; frame++) {
    if (features.voiced[frame] && Number.isFinite(features.midi[frame])) {
      pitches.push(features.midi[frame]);
    }
  }
  if (pitches.length < 2) return;
  pitches.sort((a, b) => a - b);
  const median = pitches[pitches.length >> 1];
  const low = Math.max(...pitches);
  const high = Math.min(...pitches);
  const span = Math.max(4, low - high);
  context.beginPath();
  let started = false;
  for (let frame = from; frame < to; frame++) {
    if (!features.voiced[frame] || !Number.isFinite(features.midi[frame])) {
      started = false;
      continue;
    }
    const x = ((frame * features.hopSec - occurrence.start) /
      (occurrence.end - occurrence.start)) * width;
    const value = (features.midi[frame] - median) / span;
    const y = top + height / 2 - value * height * 0.38;
    if (!started) {
      context.moveTo(x, y);
      started = true;
    } else {
      context.lineTo(x, y);
    }
  }
  context.strokeStyle = color;
  context.lineWidth = 1.4;
  context.globalAlpha = 0.9;
  context.stroke();
  context.globalAlpha = 1;
}

export function drawComparison(
  canvas: HTMLCanvasElement,
  peaks: WaveformPeaks,
  features: AudioFeatures,
  left: MatchOccurrence,
  right: MatchOccurrence,
): void {
  const { width, height } = prepare(canvas);
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  background(context, width, height);
  context.fillStyle = "rgba(255,255,255,0.018)";
  context.fillRect(0, 0, width, height / 2 - 1);

  const drawHalf = (
    occurrence: MatchOccurrence,
    top: number,
    color: string,
    fill: string,
  ) => {
    const halfHeight = height / 2;
    const [from, to] = peakRange(peaks, occurrence.start, occurrence.end);
    const count = Math.max(1, to - from);
    context.beginPath();
    for (let x = 0; x < width; x++) {
      const index = from + Math.floor((x / width) * count);
      const low = peaks.min[Math.min(index, peaks.min.length - 1)] ?? 0;
      const high = peaks.max[Math.min(index, peaks.max.length - 1)] ?? 0;
      const center = top + halfHeight / 2;
      context.moveTo(x + 0.5, center - high * halfHeight * 0.72);
      context.lineTo(x + 0.5, center - low * halfHeight * 0.72);
    }
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.stroke();
    drawPitchLine(context, features, occurrence, width, top, halfHeight, fill);
  };
  drawHalf(left, 0, "rgba(242,176,92,0.75)", "#ffd8a4");
  drawHalf(right, height / 2, "rgba(98,211,207,0.7)", "#9cf2e8");
  context.fillStyle = "rgba(255,255,255,0.1)";
  context.fillRect(0, height / 2, width, 1);
  context.fillStyle = "rgba(242,176,92,0.85)";
  context.fillRect(0, 0, 2, height / 2);
  context.fillStyle = "rgba(98,211,207,0.85)";
  context.fillRect(0, height / 2, 2, height / 2);
}
