// 组合滤镜：亮度（brightness）+ 锐化（unsharp mask / 3x3 卷积）
// + 畸变（以帧中心为原点的桶形/枕形畸变）。
// 本文件提供：参数定义、CPU 参考实现、以及与 CPU 等价的 GLSL 片段。
// CPU 与 GPU 都基于“整帧归一化坐标”的同一映射函数，
// 因此同一像素无论落在哪个分块（含重叠区）结果一致。

export interface FilterParams {
  /** 亮度增益，1 = 不变 */
  brightness: number;
  /** 锐化强度，0 = 关闭；典型 0..1 */
  sharpen: number;
  /** 畸变系数，>0 桶形，<0 枕形，0 = 关闭 */
  distortion: number;
}

export const DEFAULT_FILTER: FilterParams = {
  brightness: 1.08,
  sharpen: 0.6,
  distortion: 0.12,
};

export const MAX_DISTORTION_RADIUS = 1.5;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 畸变逆映射：给定输出归一化坐标 p（中心原点，y 向上），
 * 返回需要采样的输入坐标。r' = r * (1 + k*r^2) 的反演用一次牛顿迭代。
 */
export function distortInverse(nx: number, ny: number, k: number): [number, number] {
  if (k === 0) return [nx, ny];
  const rout = Math.hypot(nx, ny);
  if (rout === 0) return [0, 0];
  // 求 rin 使 rin*(1+k*rin^2)=rout，初值取 rout，迭代两次足够 1e-6 精度
  let rin = rout;
  for (let i = 0; i < 2; i++) {
    const f = rin * (1 + k * rin * rin) - rout;
    const fp = 1 + 3 * k * rin * rin;
    rin = Math.max(0, rin - f / fp);
  }
  const scale = rin / rout;
  return [nx * scale, ny * scale];
}

/** 采样器接口：按整帧像素坐标取 RGB（0..1），越界由实现决定（通常边缘钳制）。 */
export type PixelSampler = (x: number, y: number) => [number, number, number];

export function makeEdgeClampSampler(
  data: Uint8ClampedArray | Float32Array,
  width: number,
  height: number,
  channels: 3 | 4 = 4,
): PixelSampler {
  return (x: number, y: number): [number, number, number] => {
    const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
    const off = (cy * width + cx) * channels;
    if (data instanceof Uint8ClampedArray) {
      return [data[off] / 255, data[off + 1] / 255, data[off + 2] / 255];
    }
    return [data[off], data[off + 1], data[off + 2]];
  };
}

/**
 * 计算输出像素 (outX, outY) 的最终 RGB。
 * 流程：畸变逆映射 -> 双线性取中心与四邻域 -> 锐化卷积 -> 亮度。
 * 仅依赖整帧坐标与参数，与分块方式无关 => 重叠区天然一致。
 */
export function renderPixel(
  outX: number,
  outY: number,
  width: number,
  height: number,
  params: FilterParams,
  sample: PixelSampler,
): [number, number, number] {
  // 输出像素中心的归一化坐标（中心原点，y 向上），用半像素偏移避免奇数尺寸偏移
  const u = (outX + 0.5) / width - 0.5;
  const v = 0.5 - (outY + 0.5) / height;
  const [du, dv] = distortInverse(u, v, params.distortion);
  // 映回输入像素坐标（像素中心）
  const inX = (du + 0.5) * width - 0.5;
  const inY = (0.5 - dv) * height - 0.5;

  const center = bilinear(sample, inX, inY);
  let r = center[0];
  let g = center[1];
  let b = center[2];

  if (params.sharpen > 0) {
    // 3x3 unsharp：中心 1+4s，四邻域 -s（对角不参与，减少 halo 宽度需求 = 1px）
    const n = bilinear(sample, inX, inY - 1);
    const s = bilinear(sample, inX, inY + 1);
    const l = bilinear(sample, inX - 1, inY);
    const rr = bilinear(sample, inX + 1, inY);
    const sh = params.sharpen;
    r = (1 + 4 * sh) * r - sh * (n[0] + s[0] + l[0] + rr[0]);
    g = (1 + 4 * sh) * g - sh * (n[1] + s[1] + l[1] + rr[1]);
    b = (1 + 4 * sh) * b - sh * (n[2] + s[2] + l[2] + rr[2]);
  }

  const bright = params.brightness;
  return [clamp01(r * bright), clamp01(g * bright), clamp01(b * bright)];
}

function bilinear(
  sample: PixelSampler,
  x: number,
  y: number,
): [number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const p00 = sample(x0, y0);
  const p10 = sample(x0 + 1, y0);
  const p01 = sample(x0, y0 + 1);
  const p11 = sample(x0 + 1, y0 + 1);
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = p00[c] * (1 - fx) + p10[c] * fx;
    const bot = p01[c] * (1 - fx) + p11[c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

/** 整帧 CPU 渲染（测试与无头环境回退用）。 */
export function renderFrameCpu(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  params: FilterParams,
): Uint8ClampedArray {
  const sampler = makeEdgeClampSampler(src, width, height);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = renderPixel(x, y, width, height, params, sampler);
      const off = (y * width + x) * 4;
      out[off] = Math.round(r * 255);
      out[off + 1] = Math.round(g * 255);
      out[off + 2] = Math.round(b * 255);
      out[off + 3] = 255;
    }
  }
  return out;
}
