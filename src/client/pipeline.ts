// Analysis pipeline: load photos, align to anchors, plan exposure
// corrections, and build the output frame plan (skip/dwell aware).
import { toGray, alignFrame } from './align.ts';
import type { GrayImage } from './align.ts';
import { measureEv, planCorrections } from './exposure.ts';
import type { Anchor, FrameAnalysis, PhotoMeta, Transform } from './types.ts';
import { IDENTITY } from './types.ts';

export interface LoadedFrame {
  meta: PhotoMeta;
  bitmap: ImageBitmap;
  rgba: Uint8ClampedArray;
  gray: GrayImage;
}

export const GRAY_STEP = 2; // analysis pyramid step (px)

export async function loadFrames(photos: PhotoMeta[], w: number, h: number): Promise<LoadedFrame[]> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const frames: LoadedFrame[] = [];
  for (const meta of photos) {
    const blob = await (await fetch(meta.url)).blob();
    const bitmap = await createImageBitmap(blob);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    frames.push({ meta, bitmap, rgba: img.data, gray: toGray(img.data, w, h, GRAY_STEP) });
  }
  return frames;
}

export const RESIDUAL_WARN_PX = 1.5;
export const RESIDUAL_BAD_PX = 4;
export const EV_CAP = 1.5;

export function analyze(
  frames: LoadedFrame[],
  anchors: Anchor[],
  skipped: boolean[],
): FrameAnalysis[] {
  const refIdx = skipped.findIndex((s) => !s);
  const ref = frames[refIdx === -1 ? 0 : refIdx];
  const out: FrameAnalysis[] = [];
  let lastGood: Transform = IDENTITY;

  for (let i = 0; i < frames.length; i++) {
    const anomalies: string[] = [];
    let transform = IDENTITY;
    let residual = 0;
    let used = anchors.length;

    if (i === (refIdx === -1 ? 0 : refIdx)) {
      transform = IDENTITY;
    } else {
      const fit = alignFrame(ref.gray, frames[i].gray, anchors, GRAY_STEP);
      if (fit && fit.used >= Math.min(2, anchors.length)) {
        transform = fit.transform;
        residual = fit.residualPx;
        used = fit.used;
        lastGood = transform;
      } else {
        transform = lastGood;
        anomalies.push(`对齐失败：仅 ${fit?.used ?? 0} 个锚点匹配，沿用上一帧变换`);
      }
    }
    if (residual > RESIDUAL_BAD_PX) anomalies.push(`对齐残差过大：${residual.toFixed(2)}px`);
    else if (residual > RESIDUAL_WARN_PX) anomalies.push(`对齐残差偏高：${residual.toFixed(2)}px`);

    const evRaw = measureEv(frames[i].rgba, frames[i].gray.w * GRAY_STEP, frames[i].gray.h * GRAY_STEP);
    out.push({
      index: i,
      name: frames[i].meta.name,
      transform,
      residualPx: residual,
      matchedAnchors: used,
      evRaw,
      evTrend: 0,
      evCorrection: 0,
      skipped: skipped[i],
      dwell: 0,
      anomalies,
    });
  }

  const plan = planCorrections(out.map((f) => f.evRaw), EV_CAP);
  for (let i = 0; i < out.length; i++) {
    out[i].evTrend = plan.evTrend[i];
    out[i].evCorrection = plan.corrections[i];
    if (Math.abs(out[i].evRaw - plan.evTrend[i]) >= EV_CAP) {
      out[i].anomalies.push(`曝光突变 ${(out[i].evRaw - plan.evTrend[i]).toFixed(2)}EV，校正已限幅 ±${EV_CAP}EV`);
    }
  }
  return out;
}

// Output plan: included frames in order, each repeated (dwell + 1) times.
export function buildOutputPlan(analysis: FrameAnalysis[], dwell: number[]): number[] {
  const plan: number[] = [];
  for (const a of analysis) {
    if (a.skipped) continue;
    const repeats = 1 + Math.max(0, dwell[a.index] | 0);
    for (let k = 0; k < repeats; k++) plan.push(a.index);
  }
  return plan;
}

// Draw one aligned + exposure-corrected frame onto a 2d context.
export function renderAligned(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: LoadedFrame,
  t: Transform,
  evCorrection: number,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  // frame coords q map to reference coords via p = (q - t) / s
  ctx.setTransform(1 / t.s, 0, 0, 1 / t.s, -t.tx / t.s, -t.ty / t.s);
  ctx.filter = `brightness(${Math.pow(2, evCorrection).toFixed(4)})`;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame.bitmap, 0, 0, w, h);
  ctx.restore();
}
