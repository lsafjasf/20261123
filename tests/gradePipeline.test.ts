import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLUT } from "../src/core/lutParser.ts";
import { createSampler } from "../src/core/lutSampler.ts";
import { gradeFrame } from "../src/core/gradePipeline.ts";
import { DEFAULT_GRADE_OPTIONS } from "../src/core/types.ts";

function identityLUT(size = 4) {
  const lines = ["LUT_3D_SIZE " + size];
  for (let r = 0; r < size; r += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let b = 0; b < size; b += 1) {
        lines.push(`${r / (size - 1)} ${g / (size - 1)} ${b / (size - 1)}`);
      }
    }
  }
  return parseLUT(lines.join("\n"), "id.cube");
}

test("恒等 LUT 采样在网格点上严格还原", () => {
  const sampler = createSampler(identityLUT(4));
  const out: [number, number, number] = [0, 0, 0];
  sampler.sample(0.25, 0.5, 0.75, out);
  assert.ok(Math.abs(out[0] - 0.25) < 1e-6);
  assert.ok(Math.abs(out[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(out[2] - 0.75) < 1e-6);
});

test("三线性插值在网格中点取两侧平均值", () => {
  const sampler = createSampler(identityLUT(2));
  const out: [number, number, number] = [0, 0, 0];
  sampler.sample(0.5, 0, 0, out);
  assert.ok(Math.abs(out[0] - 0.5) < 1e-6);
});

test("强度 0 时像素严格不变", () => {
  const sampler = createSampler(identityLUT(4));
  const pixels = new Uint8ClampedArray([10, 120, 240, 255, 255, 255, 255, 255]);
  const snapshot = Uint8ClampedArray.from(pixels);
  const stats = gradeFrame({
    pixels,
    sampler,
    options: { ...DEFAULT_GRADE_OPTIONS, intensity: 0, highlightClipping: false }
  });
  assert.deepEqual(Array.from(pixels), Array.from(snapshot));
  assert.equal(stats.total, 2);
});

test("过曝像素被统计并叠加高亮色", () => {
  const sampler = createSampler(identityLUT(4));
  const pixels = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  const stats = gradeFrame({
    pixels,
    sampler,
    options: { ...DEFAULT_GRADE_OPTIONS, intensity: 1, clipThreshold: 0.99 }
  });
  assert.equal(stats.clipped, 1);
  assert.deepEqual([pixels[0], pixels[1], pixels[2]], [255, 0, 255]);
});

test("关闭高亮时只统计不改写颜色", () => {
  const sampler = createSampler(identityLUT(4));
  const pixels = new Uint8ClampedArray([255, 255, 255, 255]);
  gradeFrame({
    pixels,
    sampler,
    options: { ...DEFAULT_GRADE_OPTIONS, highlightClipping: false, clipThreshold: 0.99 }
  });
  assert.deepEqual([pixels[0], pixels[1], pixels[2]], [255, 255, 255]);
});

test("越界（LUT 输出 >1）被标记为 outOfGamut", () => {
  const lines = ["LUT_3D_SIZE 2"];
  for (let index = 0; index < 8; index += 1) lines.push("1.5 1.5 1.5");
  const sampler = createSampler(parseLUT(lines.join("\n"), "hot.cube"));
  const pixels = new Uint8ClampedArray([10, 10, 10, 255]);
  const stats = gradeFrame({
    pixels,
    sampler,
    options: { ...DEFAULT_GRADE_OPTIONS, highlightClipping: true }
  });
  assert.equal(stats.outOfGamut, 1);
  assert.deepEqual([pixels[0], pixels[1], pixels[2]], [0, 255, 255]);
});
