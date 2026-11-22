import type { CutDecision, ManifestEvent, PanelId } from './types.ts';

/**
 * Scene-cut detection thresholding. Pixel statistics are produced on the
 * client (downscaled grayscale thumbnails on canvas); this module owns the
 * pure decision logic and manifest mapping so it is testable without a DOM.
 */
export function decideCut(diff: number, threshold = 0.25): CutDecision {
  return {
    diff,
    threshold,
    isCut: diff >= threshold,
  };
}

/**
 * A cut swaps the source attached to a panel; it never touches the layout
 * timeline or playback head. We record it for the manifest but keep position.
 */
export function cutEvent(
  panel: PanelId,
  frame: number,
  frameRate: number,
  diff: number,
): ManifestEvent {
  return {
    frame: Math.round(frame),
    timeSec: Math.round((frame / frameRate) * 1000) / 1000,
    type: 'cut',
    panel,
    detail: `camera/source cut on "${panel}" (diff=${diff.toFixed(3)}) — layout position retained`,
  };
}

/** Mean absolute difference of two grayscale thumbnail buffers (values 0..255). */
export function meanAbsoluteDifference(
  previous: Uint8Array | Uint8ClampedArray,
  current: Uint8Array | Uint8ClampedArray,
): number {
  if (previous.length !== current.length || previous.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < current.length; i += 1) {
    sum += Math.abs(current[i] - previous[i]);
  }
  return sum / current.length / 255;
}
