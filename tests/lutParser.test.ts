import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseLUT, normalizeLutText, LUTParseError } from "../src/core/lutParser.ts";
import { LUTRegistry } from "../src/core/lutRegistry.ts";

const lutDir = join(import.meta.dirname, "..", "luts");

test("解析 .cube：尺寸、域、数据长度正确", async () => {
  const text = await readFile(join(lutDir, "warm_sunset.cube"), "utf8");
  const lut = parseLUT(text, "warm_sunset.cube");
  assert.equal(lut.size, 8);
  assert.equal(lut.format, "cube");
  assert.equal(lut.data.length, 8 ** 3 * 3);
  assert.deepEqual(lut.domainMin, [0, 0, 0]);
  assert.deepEqual(lut.domainMax, [1, 1, 1]);
});

test("解析 .3dl：自动按最大值归一化到 0..1", async () => {
  const text = await readFile(join(lutDir, "warm_4point.3dl"), "utf8");
  const lut = parseLUT(text, "warm_4point.3dl");
  assert.equal(lut.size, 4);
  assert.equal(lut.format, "3dl");
  let max = 0;
  for (const value of lut.data) max = Math.max(max, value);
  assert.ok(max <= 1 && max > 0.99);
});

test("重复导入幂等：空白、注释、换行差异不影响 id", () => {
  const base = `TITLE "T"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`;
  const noisy = `# 注释\r\n TITLE  "T" \r\n LUT_3D_SIZE  2 \n\n0   0 0 # 行尾注释\n1\t0\t0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`;
  const a = parseLUT(base, "a.cube");
  const b = parseLUT(noisy, "b.cube");
  assert.equal(a.id, b.id);
  assert.deepEqual(Array.from(a.data), Array.from(b.data));
});

test("注册表：同一文件二次导入返回 duplicated 且不新增条目", () => {
  const registry = new LUTRegistry();
  const text = `LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1`;
  const first = registry.importText(text, "x.cube");
  const second = registry.importText(text + "\n\n", "x-copy.cube");
  assert.equal(first.duplicated, false);
  assert.equal(second.duplicated, true);
  assert.equal(registry.size, 1);
  assert.equal(first.lut.id, second.lut.id);
});

test("归一化会丢弃注释与空行", () => {
  const normalized = normalizeLutText("# c\n\nLUT_3D_SIZE 2\n  0   0 0 \n");
  assert.deepEqual(normalized.lines, ["LUT_3D_SIZE 2", "0 0 0"]);
});

test("数据点数与尺寸不匹配时抛出带行号的错误", () => {
  const bad = `LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0`;
  assert.throws(() => parseLUT(bad, "bad.cube"), LUTParseError);
});

test("拒绝 1D LUT", () => {
  const oneD = `LUT_1D_SIZE 4\n0 0 0\n1 1 1`;
  assert.throws(() => parseLUT(oneD, "1d.cube"), /3D LUT/);
});
