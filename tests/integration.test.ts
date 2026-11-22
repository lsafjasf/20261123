import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LUTRegistry } from "../src/core/lutRegistry.ts";
import { ColorTimeline } from "../src/core/timeline.ts";
import { createSampler } from "../src/core/lutSampler.ts";
import { gradeFrame } from "../src/core/gradePipeline.ts";
import { DEFAULT_GRADE_OPTIONS } from "../src/core/types.ts";

const lutDir = join(import.meta.dirname, "..", "luts");

test("端到端：时间线采样驱动双 LUT 过渡并产出稳定结果", async () => {
  const registry = new LUTRegistry();
  const warm = registry.importText(await readFile(join(lutDir, "warm_sunset.cube"), "utf8"), "warm.cube").lut;
  const teal = registry.importText(await readFile(join(lutDir, "teal_orange.cube"), "utf8"), "teal.cube").lut;

  const timeline = new ColorTimeline();
  timeline.addNode({ id: "n1", time: 0, lutId: warm.id, intensity: 1 });
  timeline.addNode({ id: "n2", time: 2, lutId: teal.id, intensity: 1 });

  // 构造一帧 2x2 RGBA：暗像素、中间调、高光、纯白。
  const pixels = new Uint8ClampedArray([
    0, 0, 0, 255,
    128, 128, 128, 255,
    200, 100, 50, 255,
    255, 255, 255, 255
  ]);

  const runAt = (time: number): number[] => {
    const sample = timeline.sampleAt(time)!;
    const frame = Uint8ClampedArray.from(pixels);
    gradeFrame({
      pixels: frame,
      sampler: createSampler(registry.get(sample.fromLutId)!),
      secondSampler: createSampler(registry.get(sample.toLutId)!),
      mix: sample.mix,
      options: { ...DEFAULT_GRADE_OPTIONS, highlightClipping: false }
    });
    return Array.from(frame);
  };

  const atStart = runAt(0);
  const atMiddle = runAt(1);
  const atEnd = runAt(2);

  // 起点是纯 warm LUT，终点是纯 teal LUT，二者应不同；中点介于其间。
  assert.notDeepEqual(atStart, atEnd);
  assert.notDeepEqual(atStart, atMiddle);

  // 确定性：同一时刻重复计算结果完全一致。
  assert.deepEqual(runAt(1), atMiddle);
});

test("端到端：强度从 1 调到 0 时画面收敛回原图", async () => {
  const registry = new LUTRegistry();
  const warm = registry.importText(await readFile(join(lutDir, "warm_sunset.cube"), "utf8"), "warm.cube").lut;
  const sampler = createSampler(warm);
  const source = new Uint8ClampedArray([40, 120, 210, 255, 255, 255, 255, 255]);
  const snapshot = Array.from(source);

  const frame = Uint8ClampedArray.from(source);
  gradeFrame({
    pixels: frame,
    sampler,
    options: { ...DEFAULT_GRADE_OPTIONS, intensity: 0, highlightClipping: false }
  });
  assert.deepEqual(Array.from(frame), snapshot);
});
