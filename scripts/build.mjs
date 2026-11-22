import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = resolve(import.meta.dirname, "..");
const src = join(root, "src");
const out = join(root, "dist");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

await rm(out, { recursive: true, force: true });
const files = await walk(src);

for (const file of files) {
  const target = join(out, relative(src, file));
  await mkdir(dirname(target), { recursive: true });
  if (file.endsWith(".ts")) {
    const input = await readFile(file, "utf8");
    const javascript = stripTypeScriptTypes(input, { mode: "transform" })
      .replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2")
      .replace(/(import\s*\(\s*["'][^"']+)\.ts(["']\s*\))/g, "$1.js$2");
    await writeFile(target.replace(/\.ts$/, ".js"), javascript);
  } else {
    await copyFile(file, target);
  }
}

console.log(`Built ${files.length} source files into dist/`);
