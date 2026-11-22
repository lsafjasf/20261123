// LUT 顺序对比与解释。
// 两个 LUT 串联等价于函数复合 B(A(x))；三线性插值是非线性映射，函数复合一般不满足交换律，
// 因此 A->B 与 B->A 的结果通常不同。本模块用确定性的网格采样量化差异并生成可读解释。

import type { LUT3D } from "./types.ts";
import { createSampler, type LUTSampler } from "./lutSampler.ts";

export interface OrderComparison {
  lutAId: string;
  lutBId: string;
  /** 参与比较的采样点数。 */
  sampleCount: number;
  /** 两种顺序输出的平均每通道绝对差（0..1 量纲）。 */
  meanAbsDiff: number;
  /** 最大每通道绝对差。 */
  maxAbsDiff: number;
  /** 存在差异的采样点占比。 */
  differingRatio: number;
  /** 是否在浮点容差内等价（例如恒等 LUT）。 */
  equivalent: boolean;
  explanation: string;
}

function applyChain(first: LUTSampler, second: LUTSampler, r: number, g: number, b: number): [number, number, number] {
  const mid: [number, number, number] = [0, 0, 0];
  const out: [number, number, number] = [0, 0, 0];
  first.sample(r, g, b, mid);
  second.sample(mid[0], mid[1], mid[2], out);
  return out;
}

export function compareLUTOrder(lutA: LUT3D, lutB: LUT3D, grid = 8): OrderComparison {
  const samplerA = createSampler(lutA);
  const samplerB = createSampler(lutB);
  const step = 1 / (grid - 1);
  let sumAbs = 0;
  let maxAbsDiff = 0;
  let differing = 0;
  let count = 0;
  const tolerance = 1e-6;

  for (let ix = 0; ix < grid; ix += 1) {
    for (let iy = 0; iy < grid; iy += 1) {
      for (let iz = 0; iz < grid; iz += 1) {
        const r = ix * step;
        const g = iy * step;
        const b = iz * step;
        const ab = applyChain(samplerA, samplerB, r, g, b);
        const ba = applyChain(samplerB, samplerA, r, g, b);
        let pointMax = 0;
        let pointSum = 0;
        for (let channel = 0; channel < 3; channel += 1) {
          const diff = Math.abs(ab[channel] - ba[channel]);
          pointMax = Math.max(pointMax, diff);
          pointSum += diff;
        }
        sumAbs += pointSum / 3;
        maxAbsDiff = Math.max(maxAbsDiff, pointMax);
        if (pointMax > tolerance) differing += 1;
        count += 1;
      }
    }
  }

  const meanAbsDiff = sumAbs / count;
  const differingRatio = differing / count;
  const equivalent = maxAbsDiff <= tolerance;
  const explanation = equivalent
    ? `LUT「${lutA.title}」与「${lutB.title}」在容差 ${tolerance} 内可交换（至少其一为恒等映射或二者线性相容），调换顺序画面不变。`
    : `串联 LUT 是函数复合：先 A 后 B 等价于 B(A(x))，先 B 后 A 等价于 A(B(x))。` +
      `三线性插值得到的色调映射是非线性的，函数复合不满足交换律，因此两种顺序在 ${(differingRatio * 100).toFixed(1)}% ` +
      `的采样点上产生不同结果，平均色差 ${meanAbsDiff.toFixed(4)}、最大 ${maxAbsDiff.toFixed(4)}（0..1 量纲）。` +
      `经验上应先放技术校正类 LUT（对数转 Rec.709、白平衡），再放创意风格类 LUT。`;

  return {
    lutAId: lutA.id,
    lutBId: lutB.id,
    sampleCount: count,
    meanAbsDiff,
    maxAbsDiff,
    differingRatio,
    equivalent,
    explanation
  };
}
