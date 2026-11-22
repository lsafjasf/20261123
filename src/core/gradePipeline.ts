// 逐像素调色管线：在 RGBA 缓冲上应用 LUT、混合强度、标记过曝/越界。
// 输入输出均为 0..255 的 Uint8ClampedArray（Canvas ImageData 布局）。

import type { GradeOptions, PixelFlag } from "./types.ts";
import { PixelFlag as Flag } from "./types.ts";
import { createSampler, type LUTSampler } from "./lutSampler.ts";

export interface GradeStats {
  clipped: number;
  outOfGamut: number;
  invalidSample: number;
  total: number;
}

export interface PipelineInput {
  pixels: Uint8ClampedArray;
  sampler: LUTSampler | null;
  /** 双 LUT 过渡时的第二个采样器；null 表示单 LUT。 */
  secondSampler?: LUTSampler | null;
  /** 第二个 LUT 的混合权重 0..1，用于时间线节点之间的平滑交叉过渡。 */
  mix?: number;
  options: GradeOptions;
}

/** 判断 LUT 表中是否存在非法采样点，只扫描一次并缓存结果。 */
export function lutHasInvalidSample(sampler: LUTSampler): boolean {
  const data = sampler.lut.data;
  for (let index = 0; index < data.length; index += 1) {
    if (!Number.isFinite(data[index])) return true;
  }
  return false;
}

export function gradeFrame(input: PipelineInput): GradeStats {
  const { pixels, sampler, options } = input;
  const mix = input.secondSampler ? Math.min(1, Math.max(0, input.mix ?? 0)) : 0;
  const intensity = Math.min(1, Math.max(0, options.intensity));
  const stats: GradeStats = { clipped: 0, outOfGamut: 0, invalidSample: 0, total: pixels.length / 4 };
  const graded: [number, number, number] = [0, 0, 0];
  const gradedB: [number, number, number] = [0, 0, 0];
  const threshold = options.clipThreshold * 255;
  const [hlR, hlG, hlB] = options.highlightColor;

  for (let index = 0; index < pixels.length; index += 4) {
    const sourceR = pixels[index];
    const sourceG = pixels[index + 1];
    const sourceB = pixels[index + 2];
    let flags: PixelFlag = Flag.None;

    if (intensity > 0 && sampler) {
      sampler.sample(sourceR / 255, sourceG / 255, sourceB / 255, graded);
      if (input.secondSampler && mix > 0) {
        input.secondSampler.sample(sourceR / 255, sourceG / 255, sourceB / 255, gradedB);
        graded[0] += (gradedB[0] - graded[0]) * mix;
        graded[1] += (gradedB[1] - graded[1]) * mix;
        graded[2] += (gradedB[2] - graded[2]) * mix;
      }
      for (let channel = 0; channel < 3; channel += 1) {
        if (!Number.isFinite(graded[channel])) {
          flags |= Flag.InvalidSample;
          graded[channel] = 0;
        } else if (graded[channel] < 0 || graded[channel] > 1) {
          flags |= Flag.OutOfGamut;
        }
      }
      // 强度 = 原图与调色结果线性混合；0 强度严格等于原图。
      pixels[index] = sourceR + (graded[0] * 255 - sourceR) * intensity;
      pixels[index + 1] = sourceG + (graded[1] * 255 - sourceG) * intensity;
      pixels[index + 2] = sourceB + (graded[2] * 255 - sourceB) * intensity;
    }

    if (
      pixels[index] >= threshold ||
      pixels[index + 1] >= threshold ||
      pixels[index + 2] >= threshold
    ) {
      flags |= Flag.Clipped;
    }

    if (flags & Flag.Clipped) stats.clipped += 1;
    if (flags & Flag.OutOfGamut) stats.outOfGamut += 1;
    if (flags & Flag.InvalidSample) stats.invalidSample += 1;

    if (options.highlightClipping && flags !== Flag.None) {
      // 越界用青色、过曝用洋红、非法采样用红色区分。
      if (flags & Flag.InvalidSample) {
        pixels[index] = 255;
        pixels[index + 1] = 0;
        pixels[index + 2] = 0;
      } else if (flags & Flag.OutOfGamut) {
        pixels[index] = 0;
        pixels[index + 1] = 255;
        pixels[index + 2] = 255;
      } else {
        pixels[index] = hlR;
        pixels[index + 1] = hlG;
        pixels[index + 2] = hlB;
      }
    }
  }
  return stats;
}

export { createSampler };
