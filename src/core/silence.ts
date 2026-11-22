import type { PcmBuffer } from './types.ts';

export interface SilenceProfile {
  headSilenceSec: number;
  tailSilenceSec: number;
  /** Every silent window longer than the configured minimum, for the QC list. */
  silentRanges: { startSec: number; endSec: number }[];
  frameCount: number;
}

/** Downmix every channel to mono mean-square level per frame. */
function frameLevels(pcm: PcmBuffer): Float32Array {
  const frameCount = pcm.channels[0].length;
  const levels = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let sumSquares = 0;
    for (const channel of pcm.channels) sumSquares += channel[frame] * channel[frame];
    levels[frame] = Math.sqrt(sumSquares / pcm.channels.length);
  }
  return levels;
}

/**
 * Scan head/tail silence and interior silent windows.
 * A window is silent when its mean linear amplitude stays below the
 * dBFS-derived threshold for its whole duration.
 */
export function scanSilence(pcm: PcmBuffer, thresholdDbfs: number, windowMs: number): SilenceProfile {
  const { sampleRate } = pcm;
  const levels = frameLevels(pcm);
  const frameCount = levels.length;
  const windowFrames = Math.max(1, Math.floor((windowMs / 1000) * sampleRate));
  const threshold = Math.pow(10, thresholdDbfs / 20);

  const isWindowSilent = (start: number): boolean => {
    const end = Math.min(start + windowFrames, frameCount);
    for (let i = start; i < end; i++) if (levels[i] > threshold) return false;
    return true;
  };

  // Head: count leading fully-silent windows.
  let headWindows = 0;
  for (let start = 0; start + windowFrames <= frameCount; start += windowFrames) {
    if (!isWindowSilent(start)) break;
    headWindows++;
  }
  const headSilenceFrames = headWindows * windowFrames;

  // Tail: count trailing fully-silent windows.
  let tailWindows = 0;
  for (let end = frameCount; end - windowFrames >= 0; end -= windowFrames) {
    if (!isWindowSilent(end - windowFrames)) break;
    tailWindows++;
  }
  const tailSilenceFrames = tailWindows * windowFrames;

  // Interior silent ranges (exclude head/tail zones).
  const silentRanges: { startSec: number; endSec: number }[] = [];
  let rangeStart = -1;
  const interiorEnd = frameCount - tailSilenceFrames;
  for (let start = headSilenceFrames; start + windowFrames <= interiorEnd; start += windowFrames) {
    if (isWindowSilent(start)) {
      if (rangeStart < 0) rangeStart = start;
    } else if (rangeStart >= 0) {
      silentRanges.push({ startSec: rangeStart / sampleRate, endSec: start / sampleRate });
      rangeStart = -1;
    }
  }
  if (rangeStart >= 0) {
    silentRanges.push({ startSec: rangeStart / sampleRate, endSec: interiorEnd / sampleRate });
  }

  return {
    headSilenceSec: headSilenceFrames / sampleRate,
    tailSilenceSec: tailSilenceFrames / sampleRate,
    silentRanges,
    frameCount,
  };
}
