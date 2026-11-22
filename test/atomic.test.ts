import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dirSizeBytes,
  mergeSegments,
  safeRm,
  writeFileAtomic,
} from "../src/server/util/atomic.ts";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "scheduler-atomic-"));
});

after(async () => {
  await safeRm(root);
});

describe("writeFileAtomic", () => {
  it("正式文件原子出现，目录里不留 tmp 残留", async () => {
    const target = join(root, "out.dat");
    await writeFileAtomic(target, "hello-world");
    assert.equal(await readFile(target, "utf8"), "hello-world");
    const { readdir } = await import("node:fs/promises");
    const leftover = (await readdir(root)).filter((name) => name.includes(".tmp."));
    assert.deepEqual(leftover, []);
  });
});

describe("mergeSegments", () => {
  it("按顺序拼接分段并原子 rename，无 partial 残留", async () => {
    const seg1 = join(root, "s1");
    const seg2 = join(root, "s2");
    await writeFileAtomic(seg1, Buffer.from([1, 2, 3]));
    await writeFileAtomic(seg2, Buffer.from([4, 5, 6]));
    const finalPath = join(root, "merged.bin");
    await mergeSegments([seg1, seg2], finalPath);
    assert.deepEqual([...(await readFile(finalPath))], [1, 2, 3, 4, 5, 6]);
    const { readdir } = await import("node:fs/promises");
    const leftover = (await readdir(root)).filter((name) => name.includes(".partial."));
    assert.deepEqual(leftover, []);
  });

  it("合并失败时清理 partial，不留半个正式文件", async () => {
    const finalPath = join(root, "never.bin");
    await assert.rejects(
      mergeSegments([join(root, "missing-segment")], finalPath),
    );
    await assert.rejects(stat(finalPath), /ENOENT/);
  });
});

describe("dirSizeBytes", () => {
  it("递归统计字节数", async () => {
    const dir = join(root, "sized");
    await writeFileAtomic(join(dir, "a"), Buffer.alloc(100));
    await writeFileAtomic(join(dir, "nested", "b"), Buffer.alloc(200));
    assert.equal(await dirSizeBytes(dir), 300);
  });
});
