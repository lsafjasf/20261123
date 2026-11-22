import type { FrameSignature, RGBAFrame } from "./types.ts";

export interface LumaPlane {
  width: number;
  height: number;
  data: Float32Array;
  scaleX: number;
  scaleY: number;
}

export function toLumaPlane(frame: RGBAFrame, targetWidth: number): LumaPlane {
  const scale = Math.min(1, targetWidth / frame.width);
  const width = Math.max(16, Math.round(frame.width * scale));
  const height = Math.max(16, Math.round(frame.height * scale));
  const data = new Float32Array(width * height);
  const source = frame.data;

  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(frame.height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(frame.width - 1, Math.floor((x + 0.5) / scale));
      const at = (sy * frame.width + sx) * 4;
      data[y * width + x] =
        source[at] * 0.2126 + source[at + 1] * 0.7152 + source[at + 2] * 0.0722;
    }
  }

  return { width, height, data, scaleX: width / frame.width, scaleY: height / frame.height };
}

export function rowDifferences(plane: LumaPlane): Float32Array {
  const { width, height, data } = plane;
  const out = new Float32Array(height);
  for (let y = 1; y < height; y += 1) {
    let total = 0;
    let count = 0;
    for (let x = 1; x < width - 1; x += 1) {
      total += Math.abs(data[y * width + x] - data[(y - 1) * width + x]);
      count += 1;
    }
    out[y] = total / Math.max(1, count);
  }
  return out;
}

export function rowCoverage(plane: LumaPlane, threshold = 9): Float32Array {
  const { width, height, data } = plane;
  const out = new Float32Array(height);
  for (let y = 1; y < height; y += 1) {
    let hits = 0;
    for (let x = 1; x < width - 1; x += 1) {
      if (Math.abs(data[y * width + x] - data[(y - 1) * width + x]) >= threshold) {
        hits += 1;
      }
    }
    out[y] = hits / Math.max(1, width - 2);
  }
  return out;
}

export function normalizeProfile(values: Float32Array): Float32Array {
  let mean = 0;
  for (const value of values) mean += value;
  mean /= Math.max(1, values.length);
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;
  const sd = Math.sqrt(variance / Math.max(1, values.length)) || 1;
  return Float32Array.from(values, (value) => (value - mean) / sd);
}

export function profileSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(aa * bb)));
}

export function buildSignature(plane: LumaPlane, rowDiff: Float32Array): FrameSignature {
  const { width, height, data } = plane;
  const cols = 36;
  const rows = 8;
  const half = Math.max(4, Math.floor(height / 2));
  return {
    rowProfile: normalizeProfile(rowDiff),
    top: boxSample(data, width, 0, half, cols, rows),
    bottom: boxSample(data, width, half, height - half, cols, rows),
    width,
    height,
  };
}

function boxSample(
  data: Float32Array,
  sourceWidth: number,
  startY: number,
  height: number,
  cols: number,
  rows: number,
): Float32Array {
  const out = new Float32Array(cols * rows);
  for (let ry = 0; ry < rows; ry += 1) {
    const y0 = startY + Math.floor((ry * height) / rows);
    const y1 = Math.max(y0 + 1, startY + Math.floor(((ry + 1) * height) / rows));
    for (let rx = 0; rx < cols; rx += 1) {
      const x0 = Math.floor((rx * sourceWidth) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * sourceWidth) / cols));
      let total = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          total += data[y * sourceWidth + x];
          count += 1;
        }
      }
      out[ry * cols + rx] = total / Math.max(1, count);
    }
  }
  return out;
}

export function signatureDistance(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / Math.max(1, length);
}
