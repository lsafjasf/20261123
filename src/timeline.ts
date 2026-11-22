import type { Sample, VideoTrack } from "./mp4.ts";

export interface DisplayFrame {
  frameNumber: number;
  sample: Sample;
  decodeIndex: number;
  ctsSeconds: number;
  dtsSeconds: number;
  durationSeconds: number;
  isKeyframe: boolean;
  gopId: number;
  gopStartDecodeIndex: number;
  gopKeyframeFrame: number;
}

export interface FrameTimeline {
  track: VideoTrack;
  frames: DisplayFrame[];
  fps: number;
  durationSeconds: number;
  originSeconds: number;
  frameAt(frameNumber: number): DisplayFrame;
  frameAtTime(seconds: number): DisplayFrame;
  frameForDecodeIndex(decodeIndex: number): DisplayFrame | undefined;
  gopFrames(gopId: number): DisplayFrame[];
  clampFrame(frameNumber: number): number;
  navigationTarget(frameNumber: number, delta: number): number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function buildFrameTimeline(track: VideoTrack): FrameTimeline {
  if (track.samples.length === 0) throw new Error("视频轨道没有样本");
  const originTicks = Math.min(...track.samples.map((sample) => sample.ctsTicks));
  const displayed = [...track.samples].sort((left, right) =>
    left.ctsTicks - right.ctsTicks ||
    left.dtsTicks - right.dtsTicks ||
    left.decodeIndex - right.decodeIndex
  );

  const gopStartByDecode = new Array<number>(track.samples.length);
  let currentGop = 0;
  const decodeOrder = [...track.samples].sort((left, right) => left.decodeIndex - right.decodeIndex);
  for (const sample of decodeOrder) {
    if (sample.isSync) currentGop = sample.decodeIndex;
    gopStartByDecode[sample.decodeIndex] = currentGop;
  }

  const keyframeForGop = new Map<number, number>();
  const frames: DisplayFrame[] = displayed.map((sample, frameNumber) => {
    if (sample.isSync && gopStartByDecode[sample.decodeIndex] === sample.decodeIndex) {
      keyframeForGop.set(sample.decodeIndex, frameNumber);
    }
    return {
      frameNumber,
      sample,
      decodeIndex: sample.decodeIndex,
      ctsSeconds: (sample.ctsTicks - originTicks) / track.timescale,
      dtsSeconds: (sample.dtsTicks - originTicks) / track.timescale,
      durationSeconds: sample.durationTicks / track.timescale,
      isKeyframe: sample.isSync,
      gopId: gopStartByDecode[sample.decodeIndex],
      gopStartDecodeIndex: gopStartByDecode[sample.decodeIndex],
      gopKeyframeFrame: 0
    };
  });

  for (const frame of frames) {
    frame.gopKeyframeFrame = keyframeForGop.get(frame.gopId) ?? 0;
  }

  const frameByDecode = new Map<number, DisplayFrame>();
  for (const frame of frames) frameByDecode.set(frame.decodeIndex, frame);

  const deltas: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const delta = frames[index].ctsSeconds - frames[index - 1].ctsSeconds;
    if (delta > 0.000001) deltas.push(delta);
  }
  const typicalDelta = median(deltas);
  const fps = typicalDelta > 0 ? Math.max(1, Math.round(1 / typicalDelta)) : 24;
  const last = frames.at(-1)!;
  const durationSeconds = Math.max(
    last.ctsSeconds + (last.durationSeconds || typicalDelta),
    track.durationTicks / track.timescale
  );

  const gopGroups = new Map<number, DisplayFrame[]>();
  for (const frame of frames) {
    const group = gopGroups.get(frame.gopId);
    if (group) group.push(frame);
    else gopGroups.set(frame.gopId, [frame]);
  }

  const clampFrame = (frameNumber: number): number =>
    Math.max(0, Math.min(frames.length - 1, Math.round(frameNumber)));

  const frameAtTime = (seconds: number): DisplayFrame => {
    if (!Number.isFinite(seconds) || seconds <= frames[0].ctsSeconds) return frames[0];
    let low = 0;
    let high = frames.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (frames[middle].ctsSeconds <= seconds) low = middle + 1;
      else high = middle - 1;
    }
    return frames[Math.max(0, high)];
  };

  return {
    track,
    frames,
    fps,
    durationSeconds,
    originSeconds: originTicks / track.timescale,
    frameAt: (frameNumber: number) => frames[clampFrame(frameNumber)],
    frameAtTime,
    frameForDecodeIndex: (decodeIndex: number) => frameByDecode.get(decodeIndex),
    gopFrames: (gopId: number) => gopGroups.get(gopId) ?? [],
    clampFrame,
    navigationTarget: (frameNumber: number, delta: number) => clampFrame(frameNumber + delta)
  };
}

export function formatTimecode(frame: DisplayFrame, fps: number): string {
  const safeFps = Math.max(1, Math.round(fps));
  const totalFrames = Math.round(frame.ctsSeconds * safeFps);
  const frames = ((totalFrames % safeFps) + safeFps) % safeFps;
  const totalSeconds = Math.floor(totalFrames / safeFps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, seconds, frames]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remaining = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remaining.toFixed(3).padStart(6, "0")}`;
}
