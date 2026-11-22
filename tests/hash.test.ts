import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex } from "../src/core/hash.ts";

test("sha256Hex 与 Node crypto 的结果一致", () => {
  for (const input of ["", "a", "abc", "LUT_3D_SIZE 8\n0 0 0", "中文标题与符号 #@%"]) {
    const expected = createHash("sha256").update(input, "utf8").digest("hex");
    assert.equal(sha256Hex(input), expected);
  }
});

test("sha256Hex 对长输入（跨多个 64 字节块）正确", () => {
  const input = "x".repeat(200);
  const expected = createHash("sha256").update(input).digest("hex");
  assert.equal(sha256Hex(input), expected);
});
