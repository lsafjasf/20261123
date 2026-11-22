import { activeCueAt, activeSentenceAt } from "./cues.js";
import type { FrameTiming, SubtitleCue } from "./types.js";

export interface FrameRate {
  numerator: number;
  denominator: number;
}

export const COMMON_FRAME_RATES: FrameRate[] = [
  { numerator: 24, denominator: 1 },
  { numerator: 25, denominator: 1 },
  { numerator: 30, denominator: 1 },
  { numerator: 50, denominator: 1 },
  { numerator: 60, denominator: 1 },
  { numerator: 24000, denominator: 1001 },
  { numerator: 30000, denominator: 1001 },
  { numerator: 60000, denominator: 1001 }
];

export function fpsValue(rate: FrameRate): number {
  return rate.numerator / rate.denominator;
}

export function frameIndexAt(timestampUs: number, rate: FrameRate, originUs = 0): number {
  const scaled = ((timestampUs - originUs) * rate.numerator) / (rate.denominator * 1_000_000);
  return Math.max(0, Math.round(scaled));
}

export function frameTimestamp(index: number, rate: FrameRate, originUs = 0): number {
  return originUs + Math.round((index * rate.denominator * 1_000_000) / rate.numerator);
}

export function nearestFrameTimestamp(timestampUs: number, rate: FrameRate, originUs = 0): number {
  return frameTimestamp(frameIndexAt(timestampUs, rate, originUs), rate, originUs);
}

export function matchFrameRate(candidate: FrameRate, sampleTimestampsUs: number[]): number {
  if (sampleTimestampsUs.length < 2) return 0;
  let bestError = Number.POSITIVE_INFINITY;
  for (const rate of COMMON_FRAME_RATES) {
    let error = 0;
    for (let index = 0; index < Math.min(sampleTimestampsUs.length, 90); index += 1) {
      const predicted = frameTimestamp(index, rate, sampleTimestampsUs[0]);
      error += Math.abs(predicted - sampleTimestampsUs[index]);
    }
    if (error < bestError) {
      bestError = error;
      candidate = rate;
    }
  }
  return 1 - bestError / Math.max(1, sampleTimestampsUs.length * 1_000_000);
}

export function frameTimings(
  timestampsUs: number[],
  cues: SubtitleCue[],
  options: { originUs?: number; rate?: FrameRate } = {}
): FrameTiming[] {
  const originUs = options.originUs ?? timestampsUs[0] ?? 0;
  return timestampsUs.map((timestamp, index) => {
    const next = timestampsUs[index + 1] ?? timestamp + (options.rate ? (options.rate.denominator * 1_000_000) / options.rate.numerator : 0);
    const cue = activeCueAt(cues, timestamp);
    return {
      index: frameIndexAt(timestamp, options.rate ?? { numerator: 30, denominator: 1 }, originUs),
      timestampUs: timestamp,
      durationUs: Math.max(0, next - timestamp),
      cueId: cue?.id ?? null,
      activeSentenceId: cue ? (activeSentenceAt(cue, timestamp)?.id ?? -1) : -1
    };
  });
}

export interface TimingCheck {
  exact: boolean;
  frameCount: number;
  maxPtsDriftUs: number;
  cueRanges: Array<{ cueId: string; firstFrame: number | null; lastFrame: number | null; startUs: number; endUs: number }>;
  warnings: string[];
}

export function validateFrameTimings(
  timestampsUs: number[],
  cues: SubtitleCue[],
  rate: FrameRate,
  originUs = timestampsUs[0] ?? 0
): TimingCheck {
  const warnings: string[] = [];
  let maxPtsDriftUs = 0;
  for (let index = 0; index < timestampsUs.length; index += 1) {
    const predicted = frameTimestamp(index, rate, originUs);
    maxPtsDriftUs = Math.max(maxPtsDriftUs, Math.abs(timestampsUs[index] - predicted));
  }
  if (maxPtsDriftUs > 500) warnings.push(`帧率不是恒定 ${fpsValue(rate).toFixed(3)}fps，已按源 PTS 顺序导出`);

  const cueRanges = cues.map((cue) => {
    let firstFrame: number | null = null;
    let lastFrame: number | null = null;
    for (let index = 0; index < timestampsUs.length; index += 1) {
      if (timestampsUs[index] >= cue.startUs && timestampsUs[index] < cue.endUs) {
        if (firstFrame === null) firstFrame = index;
        lastFrame = index;
      }
    }
    if (firstFrame === null) warnings.push(`字幕 ${cue.id} 不在任何视频帧的时间范围内`);
    return { cueId: cue.id, firstFrame, lastFrame, startUs: cue.startUs, endUs: cue.endUs };
  });

  return {
    exact: maxPtsDriftUs <= 500,
    frameCount: timestampsUs.length,
    maxPtsDriftUs,
    cueRanges,
    warnings
  };
}

export function findCueStartFrame(timestampsUs: number[], cue: SubtitleCue): number | null {
  const index = timestampsUs.findIndex((timestamp) => timestamp >= cue.startUs);
  return index >= 0 && timestampsUs[index] < cue.endUs ? index : null;
}

export function findCueEndFrame(timestampsUs: number[], cue: SubtitleCue): number | null {
  for (let index = timestampsUs.length - 1; index >= 0; index -= 1) {
    if (timestampsUs[index] >= cue.startUs && timestampsUs[index] < cue.endUs) return index;
  }
  return null;
}
