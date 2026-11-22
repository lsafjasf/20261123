import { decideCut, meanAbsoluteDifference } from '/shared/cut.ts';
import type { PanelId } from '/shared/types.ts';
import type { Compositor } from './compositor.ts';

const THUMB_SIZE = 24;

/**
 * Per-panel scene cut detector. A small offscreen thumbnail of each panel is
 * reduced to grayscale and compared with the previous frame. A cut swaps the
 * source bound to the panel but never resets layout or the playback head.
 */
export class CutDetector {
  private readonly previous = new Map<PanelId, Uint8ClampedArray>();
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D;
  private readonly threshold: number;
  private readonly cooldownFrames = 8;
  private readonly cooldown = new Map<PanelId, number>();

  constructor(threshold = 0.25) {
    this.threshold = threshold;
    this.scratch = document.createElement('canvas');
    this.scratch.width = THUMB_SIZE;
    this.scratch.height = THUMB_SIZE;
    const ctx = this.scratch.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('cut detector canvas unavailable');
    this.scratchCtx = ctx;
  }

  samplePanel(
    compositor: Compositor,
    panel: PanelId,
    rect: DOMRect,
  ): number {
    this.scratchCtx.drawImage(
      compositor.canvas,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      THUMB_SIZE,
      THUMB_SIZE,
    );
    const data = this.scratchCtx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE).data;
    const gray = new Uint8ClampedArray(THUMB_SIZE * THUMB_SIZE);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
      gray[j] = Math.round(
        data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114,
      );
    }
    const prior = this.previous.get(panel);
    const diff = prior ? meanAbsoluteDifference(prior, gray) : 0;
    this.previous.set(panel, gray);
    return diff;
  }

  /**
   * Apply a cooldown after a detected cut: real camera switches produce one
   * spike, while layout motion only changes framing. The cooldown prevents
   * the same cut from being re-logged on successive transition frames.
   */
  consumeCut(panel: PanelId, diff: number, currentFrame: number): boolean {
    const until = this.cooldown.get(panel) ?? -1;
    if (currentFrame <= until) return false;
    const decision = decideCut(diff, this.threshold);
    if (!decision.isCut) return false;
    this.cooldown.set(panel, currentFrame + this.cooldownFrames);
    return true;
  }

  reset(): void {
    this.previous.clear();
    this.cooldown.clear();
  }
}
