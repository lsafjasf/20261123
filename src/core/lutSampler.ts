// 3D LUT 三线性插值采样。纯数学实现，与渲染环境无关。

import type { LUT3D } from "./types.ts";

export interface LUTSampler {
  readonly lut: LUT3D;
  /** 采样单个像素，输入/输出均为 0..1 线性域 RGB。 */
  sample(r: number, g: number, b: number, out: [number, number, number]): void;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function createSampler(lut: LUT3D): LUTSampler {
  const { size, data, domainMin, domainMax } = lut;
  const last = size - 1;
  const range: [number, number, number] = [
    domainMax[0] - domainMin[0],
    domainMax[1] - domainMin[1],
    domainMax[2] - domainMin[2]
  ];

  function sample(r: number, g: number, b: number, out: [number, number, number]): void {
    // 归一化到 0..1 网格坐标；输入超出域时夹紧，保证行为确定。
    const nx = clamp01((r - domainMin[0]) / range[0]) * last;
    const ny = clamp01((g - domainMin[1]) / range[1]) * last;
    const nz = clamp01((b - domainMin[2]) / range[2]) * last;
    const x0 = Math.floor(nx);
    const y0 = Math.floor(ny);
    const z0 = Math.floor(nz);
    const x1 = Math.min(x0 + 1, last);
    const y1 = Math.min(y0 + 1, last);
    const z1 = Math.min(z0 + 1, last);
    const tx = nx - x0;
    const ty = ny - y0;
    const tz = nz - z0;

    const offset = (x: number, y: number, z: number): number =>
      (x * size + y) * size + z;

    let accR = 0;
    let accG = 0;
    let accB = 0;
    // 立方体 8 个角，权重 = 各轴插值因子的乘积。
    for (let cx = 0; cx < 2; cx += 1) {
      const wx = cx === 0 ? 1 - tx : tx;
      const x = cx === 0 ? x0 : x1;
      for (let cy = 0; cy < 2; cy += 1) {
        const wy = cy === 0 ? 1 - ty : ty;
        const y = cy === 0 ? y0 : y1;
        for (let cz = 0; cz < 2; cz += 1) {
          const wz = cz === 0 ? 1 - tz : tz;
          const z = cz === 0 ? z0 : z1;
          const index = offset(x, y, z) * 3;
          const weight = wx * wy * wz;
          accR += data[index] * weight;
          accG += data[index + 1] * weight;
          accB += data[index + 2] * weight;
        }
      }
    }
    out[0] = accR;
    out[1] = accG;
    out[2] = accB;
  }

  return { lut, sample };
}

/** 恒等采样器：输出等于输入，用于“直通”节点与 LUT 之间的交叉过渡。 */
export function createIdentitySampler(): LUTSampler {
  const size = 2;
  const data = new Float32Array(size ** 3 * 3);
  let writeIndex = 0;
  for (let r = 0; r < size; r += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let b = 0; b < size; b += 1) {
        data[writeIndex++] = r;
        data[writeIndex++] = g;
        data[writeIndex++] = b;
      }
    }
  }
  const identityLut: LUT3D = {
    id: "identity-builtin",
    title: "Identity",
    size,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data,
    format: "cube"
  };
  return {
    lut: identityLut,
    sample(r, g, b, out) {
      out[0] = r;
      out[1] = g;
      out[2] = b;
    }
  };
}
