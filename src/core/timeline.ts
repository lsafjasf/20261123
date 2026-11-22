import type { FrameScheduleEntry, TimingSummary } from "./types.js";

const EPSILON = 1e-9;

export interface ScheduleOptions {
  sourceFps: number;
  targetFps: number;
  sourceFrameCount: number;
}

export function buildFrameSchedule(options: ScheduleOptions): FrameScheduleEntry[] {
  const { sourceFps, targetFps, sourceFrameCount } = options;
  if (!(sourceFps > 0) || !(targetFps > 0) || sourceFrameCount <= 1) {
    throw new Error("Invalid frame schedule parameters");
  }

  const durationSec = sourceFrameCount / sourceFps;
  const outputCount = Math.max(1, Math.round(durationSec * targetFps));
  const schedule: FrameScheduleEntry[] = new Array(outputCount);

  for (let index = 0; index < outputCount; index += 1) {
    const timeSec = index / targetFps;
    const sourcePosition = timeSec * sourceFps;
    const rawSourceIndex = Math.floor(sourcePosition + EPSILON);
    const sourceIndex = Math.min(sourceFrameCount - 1, Math.max(0, rawSourceIndex));
    const nextSourceIndex = Math.min(sourceFrameCount - 1, sourceIndex + 1);
    const sourcePhase = sourceIndex === nextSourceIndex
      ? 0
      : Math.min(1, Math.max(0, sourcePosition - sourceIndex));
    const nearestSourceIndex = Math.min(
      sourceFrameCount - 1,
      Math.max(0, Math.round(sourcePosition))
    );

    schedule[index] = {
      index,
      timeSec,
      timestampUs: Math.round(index * 1_000_000 / targetFps),
      sourceIndex,
      nextSourceIndex,
      nearestSourceIndex,
      sourcePhase
    };
  }

  return schedule;
}

export function summarizeTiming(
  schedule: FrameScheduleEntry[],
  targetFps: number
): TimingSummary {
  if (schedule.length === 0) {
    return {
      count: 0,
      averageIntervalMs: 0,
      minIntervalMs: 0,
      maxIntervalMs: 0,
      jitterMs: 0,
      maxTimestampErrorUs: 0,
      ordered: false,
      duplicateTimestamps: 0
    };
  }

  let ordered = true;
  let duplicateTimestamps = 0;
  let maxTimestampErrorUs = 0;
  let minIntervalUs = Number.POSITIVE_INFINITY;
  let maxIntervalUs = 0;
  let intervalSumUs = 0;

  for (let index = 0; index < schedule.length; index += 1) {
    const entry = schedule[index];
    const idealUs = index * 1_000_000 / targetFps;
    maxTimestampErrorUs = Math.max(
      maxTimestampErrorUs,
      Math.abs(entry.timestampUs - idealUs)
    );
    if (index === 0) continue;

    const previous = schedule[index - 1];
    if (entry.timestampUs <= previous.timestampUs) {
      ordered = false;
      if (entry.timestampUs === previous.timestampUs) duplicateTimestamps += 1;
    }
    if (entry.sourceIndex < previous.sourceIndex) ordered = false;

    const intervalUs = entry.timestampUs - previous.timestampUs;
    intervalSumUs += intervalUs;
    minIntervalUs = Math.min(minIntervalUs, intervalUs);
    maxIntervalUs = Math.max(maxIntervalUs, intervalUs);
  }

  const intervalCount = Math.max(1, schedule.length - 1);
  const averageIntervalMs = intervalSumUs / intervalCount / 1000;
  return {
    count: schedule.length,
    averageIntervalMs,
    minIntervalMs: Number.isFinite(minIntervalUs) ? minIntervalUs / 1000 : 0,
    maxIntervalMs: maxIntervalUs / 1000,
    jitterMs: (maxIntervalUs - (Number.isFinite(minIntervalUs) ? minIntervalUs : 0)) / 1000,
    maxTimestampErrorUs,
    ordered,
    duplicateTimestamps
  };
}

export function sourceTimeForEntry(
  entry: FrameScheduleEntry,
  sourceFps: number
): number {
  return (entry.sourceIndex + entry.sourcePhase) / sourceFps;
}
