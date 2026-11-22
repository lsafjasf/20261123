// Canvas 渲染器：保留原始帧，应用 LUT 调色，支持前后对比滑块与分屏，并回传越界统计。

import { gradeFrame, type GradeStats } from "../core/gradePipeline.ts";
import type { GradeOptions } from "../core/types.ts";
import type { LUTSampler } from "../core/lutSampler.ts";

export type CompareMode = "off" | "slider" | "split";

export interface RenderInput {
  source: CanvasImageSource;
  width: number;
  height: number;
  sampler: LUTSampler | null;
  secondSampler: LUTSampler | null;
  mix: number;
  options: GradeOptions;
  compareMode: CompareMode;
  /** 对比位置 0..1，仅 slider/split 模式生效。 */
  comparePosition: number;
}

export class GradingRenderer {
  private readonly display: HTMLCanvasElement;
  private readonly original: HTMLCanvasElement;
  private readonly graded: HTMLCanvasElement;
  private readonly originalCtx: CanvasRenderingContext2D;
  private readonly gradedCtx: CanvasRenderingContext2D;
  private readonly displayCtx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private lastStats: GradeStats = { clipped: 0, outOfGamut: 0, invalidSample: 0, total: 0 };

  constructor(display: HTMLCanvasElement) {
    this.display = display;
    this.original = document.createElement("canvas");
    this.graded = document.createElement("canvas");
    const originalCtx = this.original.getContext("2d", { willReadFrequently: true });
    const gradedCtx = this.graded.getContext("2d", { willReadFrequently: true });
    const displayCtx = display.getContext("2d");
    if (!originalCtx || !gradedCtx || !displayCtx) throw new Error("Canvas 2D 上下文不可用");
    this.originalCtx = originalCtx;
    this.gradedCtx = gradedCtx;
    this.displayCtx = displayCtx;
  }

  private resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    for (const canvas of [this.display, this.original, this.graded]) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  render(input: RenderInput): GradeStats {
    this.resize(input.width, input.height);
    // 1. 原始帧快照，保证“前”视图永远是未调色像素。
    this.originalCtx.drawImage(input.source, 0, 0, input.width, input.height);
    const frame = this.originalCtx.getImageData(0, 0, input.width, input.height);
    // 2. 在副本上应用调色管线。
    this.gradedCtx.putImageData(frame, 0, 0);
    const editable = this.gradedCtx.getImageData(0, 0, input.width, input.height);
    this.lastStats = gradeFrame({
      pixels: editable.data,
      sampler: input.sampler,
      secondSampler: input.secondSampler,
      mix: input.mix,
      options: input.options
    });
    this.gradedCtx.putImageData(editable, 0, 0);

    const ctx = this.displayCtx;
    ctx.clearRect(0, 0, input.width, input.height);
    if (input.compareMode === "off") {
      ctx.drawImage(this.graded, 0, 0);
    } else if (input.compareMode === "split") {
      const half = Math.floor(input.width * input.comparePosition);
      ctx.drawImage(this.original, 0, 0, half, input.height, 0, 0, half, input.height);
      ctx.drawImage(
        this.graded,
        half,
        0,
        input.width - half,
        input.height,
        half,
        0,
        input.width - half,
        input.height
      );
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(half, 0);
      ctx.lineTo(half, input.height);
      ctx.stroke();
    } else {
      const cutX = Math.floor(input.width * input.comparePosition);
      ctx.drawImage(this.graded, 0, 0);
      ctx.drawImage(this.original, 0, 0, cutX, input.height, 0, 0, cutX, input.height);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cutX, 0);
      ctx.lineTo(cutX, input.height);
      ctx.stroke();
    }
    return this.lastStats;
  }

  getStats(): GradeStats {
    return this.lastStats;
  }
}
