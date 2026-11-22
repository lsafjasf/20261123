/**
 * 原子文件操作：所有正式产物都先写临时文件，fsync 后 rename 到位。
 * rename 在同一文件系统上是原子的，崩溃只会留下 staging 里的临时文件，
 * 绝不会出现半个正式文件。
 */
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  opendir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

let seq = 0;

export function createId(prefix = "t"): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${process.pid.toString(36)}_${seq.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** 原子写整文件：同目录临时文件 + rename */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  await ensureDir(dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await writeFile(tmp, data);
  await rename(tmp, filePath);
}

/** 安全删除，不存在时静默 */
export async function safeRm(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

/** 递归计算目录占用字节数 */
export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    const dirHandle = await opendir(dir);
    for await (const entry of dirHandle) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSizeBytes(full);
      } else if (entry.isFile()) {
        const info = await stat(full);
        total += info.size;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return total;
}

/**
 * 把多个分段文件流式拼接为正式产物：
 * 先拼到同目录 .partial，完成并关闭后再原子 rename。
 */
export async function mergeSegments(
  segments: string[],
  finalPath: string,
): Promise<void> {
  await ensureDir(dirname(finalPath));
  const partial = `${finalPath}.partial.${process.pid}.${Date.now().toString(36)}`;
  try {
  const out = createWriteStream(partial);
  for (const segment of segments) {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const input = createReadStream(segment);
      const onError = (err: Error) => {
        input.destroy();
        out.destroy();
        rejectPromise(err);
      };
      input.once("error", onError);
      out.once("error", onError);
      input.pipe(out, { end: false });
      input.once("end", () => {
        input.removeListener("error", onError);
        out.removeListener("error", onError);
        resolvePromise();
      });
    });
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    out.close((err) => (err ? rejectPromise(err) : resolvePromise()));
  });
  await rename(partial, finalPath);
  } catch (err) {
    await safeRm(partial);
    throw err;
  }
}

export function underRoot(root: string, candidate: string): boolean {
  const resolved = resolve(candidate);
  const rootResolved = resolve(root);
  return resolved === rootResolved || resolved.startsWith(rootResolved + "/");
}
