// Render pipeline: captures frames from the working video, applies the
// gain map, composites the selected preview mode, and computes corner
// sampling stats before/after.

import { applyCorrection, renderGainMapImage } from "./correct.js";
import type { CorrectOptions } from "./correct.js";
import type { GainMap } from "./gainmap.js";
import { sampleRegions } from "./sampler.js";
import type { FrameStats } from "./sampler.js";
import { grabRGBA } from "./capture.js";

export type PreviewMode = "original" | "corrected" | "split" | "gainmap";

export interface StatPair {
  before: FrameStats;
  after: FrameStats;
}

export class Pipeline {
  width = 0;
  height = 0;
  private orig: Uint8ClampedArray | null = null;
  private corrected: Uint8ClampedArray | null = null;
  private gainImage: Uint8ClampedArray | null = null;
  private gainImageKey = "";

  // Capture the current video frame into the pipeline at preview resolution.
  async capture(video: HTMLVideoElement, maxWidth = 1280): Promise<boolean> {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return false;
    const scale = Math.min(1, maxWidth / vw);
    this.width = Math.max(2, Math.round(vw * scale));
    this.height = Math.max(2, Math.round(vh * scale));
    this.orig = await grabRGBA(video, this.width, this.height);
    this.corrected = null;
    return true;
  }

  get hasFrame(): boolean {
    return this.orig !== null;
  }

  private ensureCorrected(map: GainMap, opts: CorrectOptions): Uint8ClampedArray {
    if (!this.corrected) {
      this.corrected = new Uint8ClampedArray(this.orig!.length);
    }
    applyCorrection(this.orig!, this.width, this.height, map, opts, this.corrected);
    return this.corrected;
  }

  private ensureGainImage(map: GainMap): Uint8ClampedArray {
    const key = `${this.width}x${this.height}:${map.meta.createdAt}:${map.cols}`;
    if (!this.gainImage || this.gainImageKey !== key) {
      this.gainImage = renderGainMapImage(map, this.width, this.height);
      this.gainImageKey = key;
    }
    return this.gainImage;
  }

  // Draw the selected mode into the target canvas.
  render(
    target: CanvasRenderingContext2D,
    mode: PreviewMode,
    map: GainMap | null,
    opts: CorrectOptions,
    splitPos: number,
  ): void {
    if (!this.orig) return;
    const { width: w, height: h } = this;
    const put = (data: Uint8ClampedArray) => {
      target.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
    };
    if (mode === "original" || !map) {
      put(this.orig);
      return;
    }
    if (mode === "gainmap") {
      put(this.ensureGainImage(map));
      return;
    }
    const corr = this.ensureCorrected(map, opts);
    if (mode === "corrected") {
      put(corr);
      return;
    }
    // split: original left of splitPos, corrected right, with a divider line
    const out = new Uint8ClampedArray(this.orig);
    const splitX = Math.round(w * Math.min(Math.max(splitPos, 0), 1));
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      out.set(corr.subarray(row + splitX * 4, row + w * 4), row + splitX * 4);
      const lx = row + splitX * 4;
      out[lx] = 255; out[lx + 1] = 255; out[lx + 2] = 0; out[lx + 3] = 255;
    }
    put(out);
  }

  // Corner/center stats before and after correction (for the readout table).
  stats(map: GainMap | null, opts: CorrectOptions): StatPair | null {
    if (!this.orig) return null;
    const before = sampleRegions(this.orig, this.width, this.height);
    const after = map
      ? sampleRegions(this.ensureCorrected(map, opts), this.width, this.height)
      : before;
    return { before, after };
  }

  // Full-resolution corrected frame for PNG export.
  async exportCorrected(
    video: HTMLVideoElement,
    map: GainMap,
    opts: CorrectOptions,
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
    const w = video.videoWidth;
    const h = video.videoHeight;
    const rgba = await grabRGBA(video, w, h);
    applyCorrection(rgba, w, h, map, opts);
    return { data: rgba, width: w, height: h };
  }
}
