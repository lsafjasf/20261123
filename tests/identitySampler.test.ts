import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdentitySampler, createSampler } from "../src/core/lutSampler.ts";
import { gradeFrame } from "../src/core/gradePipeline.ts";
import { DEFAULT_GRADE_OPTIONS } from "../src/core/types.ts";
import { parseLUT } from "../src/core/lutParser.ts";

test("恒等采样器输出严格等于输入", () => {
  const sampler = createIdentitySampler();
  const out: [number, number, number] = [0, 0, 0];
  sampler.sample(0.3, 0.6, 0.9, out);
  assert.deepEqual(out, [0.3, 0.6, 0.9]);
});

test("直通（恒等）与真实 LUT 交叉混合时结果介于两者之间", () => {
  const identity = createIdentitySampler();
  const lines = ["LUT_3D_SIZE 2"];
  for (let index = 0; index < 8; index += 1) lines.push("0.9 0.8 0.1");
  const warm = createSampler(parseLUT(lines.join("\n"), "warm.cube"));

  const source = new Uint8ClampedArray([100, 100, 100, 255]);
  const pureLut = Uint8ClampedArray.from(source);
  gradeFrame({
    pixels: pureLut,
    sampler: warm,
    options: { ...DEFAULT_GRADE_OPTIONS, highlightClipping: false }
  });

  const mixed = Uint8ClampedArray.from(source);
  gradeFrame({
    pixels: mixed,
    sampler: identity,
    secondSampler: warm,
    mix: 0.5,
    options: { ...DEFAULT_GRADE_OPTIONS, highlightClipping: false }
  });

  // 50% 混合的红通道应在原图（100）与纯 LUT 结果之间。
  assert.ok(mixed[0] > source[0] && mixed[0] < pureLut[0]);
});
