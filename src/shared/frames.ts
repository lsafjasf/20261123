// Deterministic procedural frame generation in YUV space.
// Frames depend only on (seed, width, height, chroma, frameIndex), so
// repeated runs of the same config produce byte-identical input.

import { createPrng, hashString, randomInt } from './prng.ts';
import type { ChromaFormat } from './matrix.ts';

export interface PlaneLayout {
  format: ChromaFormat;
  // Per-plane: subsampling shift relative to luma (0 = same size).
  planes: Array<{ subX: number; subY: number }>;
}

export function chromaLayout(format: ChromaFormat): PlaneLayout {
  switch (format) {
    case 'I420':
      return { format, planes: [{ subX: 0, subY: 0 }, { subX: 1, subY: 1 }, { subX: 1, subY: 1 }] };
    case 'NV12':
      // Handled as I420 plus interleave flag by callers; kept planar here.
      return { format, planes: [{ subX: 0, subY: 0 }, { subX: 1, subY: 1 }, { subX: 1, subY: 1 }] };
    case 'I422':
      return { format, planes: [{ subX: 0, subY: 0 }, { subX: 1, subY: 0 }, { subX: 1, subY: 0 }] };
    case 'I444':
      return { format, planes: [{ subX: 0, subY: 0 }, { subX: 0, subY: 0 }, { subX: 0, subY: 0 }] };
  }
}

export interface GeneratedFrame {
  format: ChromaFormat;
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
  // Packed single-buffer layout for VideoFrame construction.
  data: Uint8Array;
  layout: PlaneLayout;
}

function planeSize(dimension: number, sub: number): number {
  return sub === 0 ? dimension : Math.ceil(dimension / 2);
}

// Fills one frame: moving bars + diagonal gradient + deterministic noise
// patch + a 16-bit frame-index marker (detects drops/reorder on decode).
export function generateFrame(
  seedText: string,
  width: number,
  height: number,
  format: ChromaFormat,
  frameIndex: number,
): GeneratedFrame {
  const layout = chromaLayout(format);
  const seed = (hashString(seedText) ^ Math.imul(frameIndex + 1, 2654435761)) >>> 0;
  const next = createPrng(seed);

  const yW = width;
  const yH = height;
  const cW = planeSize(width, layout.planes[1].subX);
  const cH = planeSize(height, layout.planes[1].subY);

  const y = new Uint8Array(yW * yH);
  const u = new Uint8Array(cW * cH);
  const v = new Uint8Array(cW * cH);

  // Moving diagonal gradient + travelling bar, full-res luma.
  const barX = (frameIndex * 7) % Math.max(1, width);
  const barWidth = Math.max(8, Math.floor(width / 12));
  for (let row = 0; row < yH; row++) {
    for (let col = 0; col < yW; col++) {
      let value = 16 + Math.floor(((col + row + frameIndex * 3) % 256) * (219 / 255));
      const inBar = col >= barX && col < barX + barWidth;
      if (inBar) value = 235 - (value - 16);
      y[row * yW + col] = value;
    }
  }

  // Chroma: two counter-rotating sweeps so subsampling errors are visible.
  for (let row = 0; row < cH; row++) {
    for (let col = 0; col < cW; col++) {
      u[row * cW + col] = 16 + ((col * 2 + frameIndex * 5) % 224);
      v[row * cW + col] = 16 + ((row * 2 + 240 - ((frameIndex * 5) % 224)) % 224);
    }
  }

  // Deterministic noise patch (exercises bitrate adaptation).
  const patchSize = Math.max(16, Math.floor(Math.min(width, height) / 6));
  const patchX = randomInt(next, Math.max(1, yW - patchSize));
  const patchY = randomInt(next, Math.max(1, yH - patchSize));
  for (let row = 0; row < patchSize; row++) {
    for (let col = 0; col < patchSize; col++) {
      y[(patchY + row) * yW + patchX + col] = 16 + randomInt(next, 220);
    }
  }

  // 16-bit frame index marker, two 8x8 cells per bit, top-left corner.
  for (let bit = 0; bit < 16; bit++) {
    const on = ((frameIndex >>> bit) & 1) === 1;
    const cellX = 4 + bit * 9;
    if (cellX + 8 > yW || 12 > yH) break;
    for (let row = 4; row < 12; row++) {
      for (let col = cellX; col < cellX + 8; col++) {
        y[row * yW + col] = on ? 235 : 16;
      }
    }
  }

  // Pack into the exact byte layout VideoFrame expects for the format.
  let data: Uint8Array;
  if (format === 'NV12') {
    data = new Uint8Array(y.length + u.length * 2);
    data.set(y, 0);
    for (let i = 0; i < u.length; i++) {
      data[y.length + i * 2] = u[i];
      data[y.length + i * 2 + 1] = v[i];
    }
  } else {
    data = new Uint8Array(y.length + u.length + v.length);
    data.set(y, 0);
    data.set(u, y.length);
    data.set(v, y.length + u.length);
  }

  return { format, width, height, y, u, v, data, layout };
}

// VideoFrameInit layout descriptor for the packed buffer above.
export function videoFrameLayout(frame: GeneratedFrame): {
  offset: number;
  stride: number;
}[] {
  const yStride = frame.width;
  if (frame.format === 'NV12') {
    return [
      { offset: 0, stride: yStride },
      { offset: frame.y.length, stride: planeSize(frame.width, 1) },
    ];
  }
  const cW = planeSize(frame.width, frame.layout.planes[1].subX);
  return [
    { offset: 0, stride: yStride },
    { offset: frame.y.length, stride: cW },
    { offset: frame.y.length + frame.u.length, stride: cW },
  ];
}
