// 构建脚本：用 Node 内置的 stripTypeScriptTypes 把 src/ 下的 .ts
// 原样剥离类型后输出到 public/js/，不引入任何第三方依赖。
// 用法: node build.mjs [--watch]
import { stripTypeScriptTypes } from "node:module";
import { readdir, readFile, writeFile, mkdir, watch } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(root, "src");
const outDir = join(root, "public", "js");

async function listTs(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listTs(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

async function buildOne(file) {
  const rel = relative(srcDir, file).replace(/\.ts$/, ".js");
  const dst = join(outDir, rel);
  const code = await readFile(file, "utf8");
  // 源码用 .ts 后缀互相引用（Node 可直接跑）；浏览器侧改写成 .js
  const js = stripTypeScriptTypes(code, { mode: "strip", sourceMap: false }).replace(
    /(from\s+["'])(\.[^"']+)\.ts(["'])/g,
    "$1$2.js$3",
  );
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, js);
  console.log("built", rel);
}

async function buildAll() {
  for (const f of await listTs(srcDir)) await buildOne(f);
}

await buildAll();
if (process.argv.includes("--watch")) {
  const w = await watch(srcDir, { recursive: true });
  for await (const ev of w) {
    if (ev.filename?.endsWith(".ts")) {
      try { await buildOne(join(srcDir, ev.filename)); } catch (e) { console.error(e); }
    }
  }
}
