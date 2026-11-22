import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLUT } from "../src/core/lutParser.ts";
import { compareLUTOrder } from "../src/core/orderExplain.ts";

function makeLUT(scale: [number, number, number], name: string, cross = 0) {
  const size = 4;
  const lines = [`TITLE "${name}"`, `LUT_3D_SIZE ${size}`];
  for (let r = 0; r < size; r += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let b = 0; b < size; b += 1) {
        const rr = r / (size - 1);
        const gg = g / (size - 1);
        const bb = b / (size - 1);
        lines.push(
          `${(rr * scale[0] + gg * cross) * 0.5} ${(gg * scale[1] + rr * cross) * 0.5} ${(bb * scale[2]) * 0.5}`
        );
      }
    }
  }
  return parseLUT(lines.join("\n"), name + ".cube");
}

test("两个恒等 LUT 顺序等价", () => {
  const idA = makeLUT([1, 1, 1], "idA");
  const idB = makeLUT([1, 1, 1], "idB");
  const result = compareLUTOrder(idA, idB, 4);
  assert.equal(result.equivalent, true);
  assert.equal(result.differingRatio, 0);
  assert.match(result.explanation, /可交换/);
});

test("不同通道增益的 LUT 顺序不同会产生可量化差异", () => {
  // 跨通道耦合（绿通道渗入红通道）使映射成为真正的非线性复合，顺序不可交换。
  const red = makeLUT([1.5, 1, 1], "redBoost", 0.4);
  const blue = makeLUT([1, 1, 1.6], "blueBoost", 0.3);
  const result = compareLUTOrder(red, blue, 6);
  assert.equal(result.equivalent, false);
  assert.ok(result.differingRatio > 0);
  assert.ok(result.maxAbsDiff > 0);
  assert.match(result.explanation, /函数复合/);
});
