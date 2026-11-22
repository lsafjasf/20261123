// 零依赖构建：使用 Node 内置 stripTypeScriptTypes 将 src 下的 .ts 擦除为浏览器可运行的 .js。
import { stripTypeScriptTypes } from "node:module";
import { readdir, mkdir, rm, writeFile, readFile, copyFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const srcDir = join(root, "src");
const outDir = join(root, "dist");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

// 将相对导入的 .ts 后缀改写为 .js（浏览器 ESM 需要真实文件后缀）。
function rewriteImports(code) {
  return code.replace(/(from\s*["'])(\.[^"']+?)(["'])/g, (match, head, spec, tail) => {
    const normalized = spec.endsWith(".ts") ? spec.slice(0, -3) + ".js" : spec;
    return head + normalized + tail;
  });
}

async function build() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const files = await walk(srcDir);
  for (const file of files) {
    const rel = relative(srcDir, file);
    const target = join(outDir, "src", rel.replace(/\.ts$/, ".js"));
    await mkdir(join(target, ".."), { recursive: true });
    if (file.endsWith(".ts")) {
      const source = await readFile(file, "utf8");
      const stripped = stripTypeScriptTypes(source, { mode: "transform" });
      await writeFile(target, rewriteImports(stripped), "utf8");
    } else {
      await copyFile(file, target);
    }
  }
  for (const asset of ["index.html", "styles.css"]) {
    await copyFile(join(root, asset), join(outDir, asset));
  }
  const luts = await walk(join(root, "luts")).catch(() => []);
  if (luts.length) {
    await mkdir(join(outDir, "luts"), { recursive: true });
    for (const lut of luts) {
      await copyFile(lut, join(outDir, "luts", lut.split(sep).pop()));
    }
  }
  console.log(`构建完成：${files.length} 个源文件 -> dist/`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
