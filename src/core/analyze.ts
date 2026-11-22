import type { Frame } from "./types.ts";

/** Rec.601 luma plane. */
export function toLuma(frame: Frame): Float32Array {
  const { rgba, width, height } = frame;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return out;
}

/** Per-pixel median across a small temporal window of luma planes. */
export function temporalMedian(planes: Float32Array[]): Float32Array {
  const n = planes.length;
  const out = new Float32Array(planes[0].length);
  const buf = new Float32Array(n);
  for (let i = 0; i < out.length; i++) {
    for (let k = 0; k < n; k++) buf[k] = planes[k][i];
    for (let a = 1; a < n; a++) {
      const v = buf[a];
      let b = a - 1;
      while (b >= 0 && buf[b] > v) { buf[b + 1] = buf[b]; b--; }
      buf[b + 1] = v;
    }
    out[i] = n % 2 === 1
      ? buf[(n - 1) / 2]
      : 0.5 * (buf[n / 2 - 1] + buf[n / 2]);
  }
  return out;
}

/**
 * Robust grain/noise sigma of a luma plane via the median absolute
 * deviation of the discrete Laplacian (variance factor 20 for iid noise).
 */
export function noiseSigma(luma: Float32Array, w: number, h: number): number {
  const vals: number[] = [];
  for (let y = 1; y < h - 1; y += 2) {
    const row = y * w;
    for (let x = 1; x < w - 1; x += 2) {
      const i = row + x;
      vals.push(Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - w] - luma[i + w]));
    }
  }
  vals.sort((a, b) => a - b);
  const mad = vals.length ? vals[vals.length >> 1] : 0;
  return (mad / 0.6745) / Math.sqrt(20);
}

/** Local grain sigma inside a masked region (same Laplacian estimator). */
export function localGrain(
  luma: Float32Array, w: number, h: number,
  mask: Uint8Array, bbox: { x: number; y: number; w: number; h: number },
): number {
  const vals: number[] = [];
  const x0 = Math.max(1, bbox.x), y0 = Math.max(1, bbox.y);
  const x1 = Math.min(w - 1, bbox.x + bbox.w), y1 = Math.min(h - 1, bbox.y + bbox.h);
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      vals.push(Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - w] - luma[i + w]));
    }
  }
  if (vals.length < 8) return 0;
  vals.sort((a, b) => a - b);
  return (vals[vals.length >> 1] / 0.6745) / Math.sqrt(20);
}

/**
 * Candidate defect pixels: current frame deviates from the temporal
 * median by more than max(minDelta, sigmaK * noise). Strength in [0,1]
 * loosens the threshold as it approaches 1.
 */
export function defectCandidates(
  cur: Float32Array, med: Float32Array, sigma: number,
  minDelta: number, sigmaK: number, strength: number,
): Uint8Array {
  const k = sigmaK * (1.6 - 0.6 * strength);
  const thr = Math.max(minDelta * (1.5 - 0.5 * strength), k * sigma);
  const out = new Uint8Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    if (Math.abs(cur[i] - med[i]) > thr) out[i] = 1;
  }
  return out;
}

/**
 * Untrusted motion mask: pixels whose neighbourhood changes between the
 * previous and next frame. Dilated by `radius` so repair never touches
 * the edges of moving objects.
 */
export function motionMask(
  prev: Float32Array, next: Float32Array,
  w: number, h: number, sigma: number, radius: number,
): Uint8Array {
  // |next - prev| of clean grain has sigma sqrt(2)*sigma; stay well above
  // it so film grain never reads as motion.
  const thr = Math.max(10, 5 * sigma * 1.4142);
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < raw.length; i++) {
    if (Math.abs(next[i] - prev[i]) > thr) raw[i] = 1;
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!raw[y * w + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}
