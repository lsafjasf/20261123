import type { DetectedPause, DetectionSettings } from "./types.ts";

const FRAME_MS = 10;
const HOLE_CLOSE_MS = 70;
const EDGE_INSET_MS = 22;
const ABSOLUTE_QUIET_FLOOR_DB = -55;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function percentile(sorted: Float64Array, fraction: number): number {
  if (sorted.length === 0) return -120;
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

interface FrameStats {
  db: number;
  zcr: number;
}

function computeFrames(source: { channels: Float32Array[]; sampleRate: number }): FrameStats[] {
  const frameSize = Math.max(32, Math.round((source.sampleRate * FRAME_MS) / 1000));
  const frameCount = Math.ceil(source.channels[0].length / frameSize);
  const frames: FrameStats[] = [];
  const channelCount = source.channels.length;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    const end = Math.min(start + frameSize, source.channels[0].length);
    let energy = 0;
    let crossings = 0;
    let previous = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const samples = source.channels[channel];
      for (let index = start; index < end; index += 1) {
        const sample = samples[index];
        energy += sample * sample;
        if (index > start && (sample >= 0) !== (previous >= 0)) crossings += 1;
        previous = sample;
      }
    }
    const meanSquare = energy / Math.max(1, (end - start) * channelCount);
    const db = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -120;
    const zcr = crossings / Math.max(1, (end - start - 1) * channelCount);
    frames.push({ db, zcr });
  }
  return frames;
}

export function detectPauses(
  source: { channels: Float32Array[]; sampleRate: number },
  settings: DetectionSettings,
): DetectedPause[] {
  if (source.channels.length === 0 || source.channels[0].length === 0) return [];
  const frames = computeFrames(source);
  const levels = Float64Array.from(frames.map((frame) => frame.db)).sort();
  const noiseFloor = percentile(levels, 0.18);
  const quietThreshold = settings.smartProtection
    ? clamp(noiseFloor + 7.5, -58, -37)
    : clamp(noiseFloor + 9, -54, -33);

  const quiet = frames.map((frame) => frame.db < quietThreshold);
  const closeFrames = Math.max(1, Math.round(HOLE_CLOSE_MS / FRAME_MS));

  let previousQuietIndex = -closeFrames - 1;
  for (let index = 0; index < quiet.length; index += 1) {
    if (!quiet[index]) continue;
    const gap = index - previousQuietIndex - 1;
    if (previousQuietIndex >= 0 && gap > 0 && gap <= closeFrames) {
      for (let fill = previousQuietIndex + 1; fill < index; fill += 1) quiet[fill] = true;
    }
    previousQuietIndex = index;
  }

  const frameSeconds = FRAME_MS / 1000;
  const edgeFrames = Math.max(1, Math.round(EDGE_INSET_MS / FRAME_MS));
  const minFrames = Math.round(settings.minSilenceMs / FRAME_MS);
  const segments: DetectedPause[] = [];
  let index = 0;

  while (index < quiet.length) {
    if (!quiet[index]) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < quiet.length && quiet[index]) index += 1;
    const runEnd = index;
    if (runEnd - runStart < minFrames) continue;

    const innerStart = runStart + edgeFrames;
    const innerEnd = runEnd - edgeFrames;
    if (innerEnd - innerStart < minFrames * 0.65) continue;

    let energy = 0;
    let sampleCount = 0;
    let zcr = 0;
    for (let frame = innerStart; frame < innerEnd; frame += 1) {
      const linear = Math.pow(10, frames[frame].db / 10);
      energy += linear;
      zcr += frames[frame].zcr;
      sampleCount += 1;
    }
    const meanEnergy = energy / Math.max(1, sampleCount);
    const levelDb = meanEnergy > 0 ? 10 * Math.log10(meanEnergy) : -120;
    const timeStart = innerStart * frameSeconds;
    const timeEnd = Math.min(source.channels[0].length / source.sampleRate, innerEnd * frameSeconds);
    const duration = timeEnd - timeStart;
    if (duration < settings.minSilenceMs / 1000 * 0.9) continue;

    const quietness = clamp((quietThreshold - levelDb) / 14, 0, 1);
    const durationConfidence = clamp((duration - settings.minSilenceMs / 1000) / 1.4, 0, 1);
    const confidence = Math.round((0.58 + quietness * 0.3 + durationConfidence * 0.12) * 100);
    const meanZcr = zcr / Math.max(1, sampleCount);
    const kind = duration >= 2.1 ? "long" : meanZcr > 0.19 ? "breath" : "clean";

    segments.push({
      id: `pause-${segments.length + 1}`,
      sourceStart: Number(timeStart.toFixed(4)),
      sourceEnd: Number(timeEnd.toFixed(4)),
      duration,
      confidence: clamp(confidence, 55, 99),
      levelDb,
      spectralTilt: meanZcr,
      state: "active",
      targetMs: settings.targetMs,
      kind,
    });
  }

  return segments;
}

export function detectionStats(segments: DetectedPause[]): {
  activeCount: number;
  removedSeconds: number;
} {
  let activeCount = 0;
  let removedSeconds = 0;
  for (const segment of segments) {
    if (segment.state !== "active") continue;
    activeCount += 1;
    const target = Math.min(segment.duration, segment.targetMs / 1000);
    removedSeconds += Math.max(0, segment.duration - target);
  }
  return { activeCount, removedSeconds };
}
