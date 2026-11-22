import type { RgbaImage } from "./types.ts";

export function createImage(width: number, height: number, fill = 0): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill !== 0) data.fill(fill);
  return { width, height, data };
}

export function cloneImage(image: RgbaImage): RgbaImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
}

export function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

export function luminanceAt(image: RgbaImage, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  const data = image.data;
  return 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
}

export function toLuma(image: RgbaImage): Float32Array {
  const pixels = image.width * image.height;
  const luma = new Float32Array(pixels);
  const data = image.data;
  for (let index = 0, offset = 0; index < pixels; index += 1, offset += 4) {
    luma[index] = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
  }
  return luma;
}

export function resizeRgba(image: RgbaImage, width: number, height: number): RgbaImage {
  if (width === image.width && height === image.height) return cloneImage(image);
  const source = image.data;
  const target = new Uint8ClampedArray(width * height * 4);
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(image.height - 1, (y + 0.5) * yRatio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, (x + 0.5) * xRatio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const p00 = (y0 * image.width + x0) * 4;
      const p10 = (y0 * image.width + x1) * 4;
      const p01 = (y1 * image.width + x0) * 4;
      const p11 = (y1 * image.width + x1) * 4;
      const out = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = source[p00 + channel] * (1 - fx) + source[p10 + channel] * fx;
        const bottom = source[p01 + channel] * (1 - fx) + source[p11 + channel] * fx;
        target[out + channel] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return { width, height, data: target };
}

export function fitWithin(image: RgbaImage, maxDimension: number): RgbaImage {
  const longest = Math.max(image.width, image.height);
  if (longest <= maxDimension) return cloneImage(image);
  const ratio = maxDimension / longest;
  return resizeRgba(
    image,
    Math.max(1, Math.round(image.width * ratio)),
    Math.max(1, Math.round(image.height * ratio))
  );
}

export function cropRgba(
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number
): RgbaImage {
  const sx = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const sw = Math.max(1, Math.min(image.width - sx, Math.round(width)));
  const sh = Math.max(1, Math.min(image.height - sy, Math.round(height)));
  const data = new Uint8ClampedArray(sw * sh * 4);
  for (let row = 0; row < sh; row += 1) {
    const from = ((sy + row) * image.width + sx) * 4;
    const to = row * sw * 4;
    data.set(image.data.subarray(from, from + sw * 4), to);
  }
  return { width: sw, height: sh, data };
}

export function buildIntegral(luma: Float32Array, width: number, height: number): Float64Array {
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += luma[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }
  return integral;
}

export function rectMean(
  integral: Float64Array,
  stride: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): number {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.max(left + 1, Math.floor(x1));
  const bottom = Math.max(top + 1, Math.floor(y1));
  const sum =
    integral[bottom * stride + right] -
    integral[top * stride + right] -
    integral[bottom * stride + left] +
    integral[top * stride + left];
  return sum / ((right - left) * (bottom - top));
}

export function ensureEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}
