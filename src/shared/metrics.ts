// Reference YUV -> RGB conversion (BT.601 limited range) and content
// deviation metrics. Pure functions: identical inputs give identical
// outputs on every machine, which keeps repeat runs comparable.

import type { GeneratedFrame } from './frames.ts';

export function clamp8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

// Converts a generated frame to a packed RGBA buffer (reference image).
export function frameToRgba(frame: GeneratedFrame): Uint8ClampedArray {
  const { width, height, y, u, v, layout } = frame;
  const out = new Uint8ClampedArray(width * height * 4);
  const subX = layout.planes[1].subX;
  const subY = layout.planes[1].subY;
  const cW = subX === 0 ? width : Math.ceil(width / 2);
  for (let row = 0; row < height; row++) {
    const cRow = subY === 0 ? row : row >> 1;
    for (let col = 0; col < width; col++) {
      const cCol = subX === 0 ? col : col >> 1;
      const yv = y[row * width + col];
      const uv = u[cRow * cW + cCol] - 128;
      const vv = v[cRow * cW + cCol] - 128;
      const c = yv - 16;
      const idx = (row * width + col) * 4;
      out[idx] = clamp8(Math.round((298 * c + 409 * vv + 128) >> 8));
      out[idx + 1] = clamp8(Math.round((298 * c - 100 * uv - 208 * vv + 128) >> 8));
      out[idx + 2] = clamp8(Math.round((298 * c + 516 * uv + 128) >> 8));
      out[idx + 3] = 255;
    }
  }
  return out;
}

export interface Deviation {
  mae: number;
  psnrDb: number;
  samples: number;
}

// Mean absolute error and PSNR over RGB channels of two RGBA buffers.
export function deviation(a: Uint8ClampedArray, b: Uint8ClampedArray): Deviation {
  const n = Math.min(a.length, b.length);
  let sumAbs = 0;
  let sumSq = 0;
  let samples = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 3) === 3) continue; // skip alpha
    const d = a[i] - b[i];
    sumAbs += Math.abs(d);
    sumSq += d * d;
    samples++;
  }
  if (samples === 0) return { mae: 0, psnrDb: Infinity, samples: 0 };
  const mae = sumAbs / samples;
  const mse = sumSq / samples;
  const psnrDb = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  return { mae, psnrDb, samples };
}

export interface Distribution {
  mean: number;
  stddev: number;
  cv: number; // coefficient of variation, 0 when mean is 0
  min: number;
  max: number;
}

export function distribution(values: number[]): Distribution {
  if (values.length === 0) return { mean: 0, stddev: 0, cv: 0, min: 0, max: 0 };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const mean = sum / values.length;
  let sq = 0;
  for (const value of values) sq += (value - mean) * (value - mean);
  const stddev = Math.sqrt(sq / values.length);
  return { mean, stddev, cv: mean === 0 ? 0 : stddev / mean, min, max };
}
