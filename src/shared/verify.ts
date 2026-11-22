import type { VerificationResult } from './types.ts';

export interface FrameSnapshot {
  frame: number;
  /** RGBA bytes from a canvas getImageData call. */
  pixels: Uint8ClampedArray;
}

export interface FrameDelta {
  frame: number;
  maxDelta: number;
  meanDelta: number;
}

/**
 * Compare the live preview canvas snapshots against frames decoded back from
 * the exported blob. Both paths go through the same compositor, so any
 * divergence indicates a real export bug rather than a rendering difference.
 */
export function compareSnapshots(
  preview: FrameSnapshot[],
  exported: FrameSnapshot[],
  tolerance: number,
): VerificationResult {
  const byFrame = new Map<number, FrameSnapshot>();
  for (const snap of exported) byFrame.set(snap.frame, snap);

  const perFrame: VerificationResult['perFrame'] = [];
  let maxChannelDelta = 0;
  let totalDelta = 0;
  let sampleCount = 0;
  let mismatchedFrames = 0;

  for (const snap of preview) {
    const other = byFrame.get(snap.frame);
    if (!other || other.pixels.length !== snap.pixels.length) {
      mismatchedFrames += 1;
      perFrame.push({ frame: snap.frame, maxDelta: 255, meanDelta: 255 });
      maxChannelDelta = 255;
      continue;
    }
    const delta = pixelDelta(snap.frame, snap.pixels, other.pixels);
    perFrame.push(delta);
    maxChannelDelta = Math.max(maxChannelDelta, delta.maxDelta);
    totalDelta += delta.meanDelta;
    sampleCount += 1;
    if (delta.maxDelta > tolerance) mismatchedFrames += 1;
  }

  return {
    comparedFrames: preview.length,
    maxChannelDelta,
    meanChannelDelta:
      sampleCount === 0 ? 255 : totalDelta / sampleCount,
    mismatchedFrames,
    passed: mismatchedFrames === 0,
    tolerance,
    perFrame,
  };
}

function pixelDelta(
  frame: number,
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
): FrameDelta {
  let maxDelta = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(a[i + c] - b[i + c]);
      if (d > maxDelta) maxDelta = d;
      sum += d;
      count += 1;
    }
  }
  return {
    frame,
    maxDelta,
    meanDelta: count === 0 ? 0 : sum / count,
  };
}
