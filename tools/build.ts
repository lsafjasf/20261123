// Build: strip TypeScript types with Node's built-in module API (no external
// packages) and emit runnable ES modules into public/.
import { stripTypeScriptTypes } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const SRC = "src";
const OUT = "public";

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

let built = 0;
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (file.endsWith(".ts")) {
    let js = stripTypeScriptTypes(readFileSync(file, "utf8"), {
      mode: "strip",
      sourceMap: false,
    });
    // rewrite .ts import specifiers to .js
    js = js.replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2");
    js = js.replace(/(import\s+["'][^"']+)\.ts(["'])/g, "$1.js$2");
    writeFileSync(dest.replace(/\.ts$/, ".js"), js);
    built++;
  } else {
    copyFileSync(file, dest);
  }
}
console.log(`built ${built} modules -> ${OUT}/`);
