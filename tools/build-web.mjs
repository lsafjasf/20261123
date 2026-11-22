/**
 * Build the browser app without external packages: Node's native type
 * stripping converts our TypeScript sources to plain ES modules.
 *
 *   node tools/build-web.mjs
 */
import { stripTypeScriptTypes } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const jobs = [];
for (const f of readdirSync("src/core")) {
  if (f.endsWith(".ts")) jobs.push([join("src/core", f), join("web/dist/core", f)]);
}
for (const f of readdirSync("web")) {
  if (f.endsWith(".ts")) jobs.push([join("web", f), join("web/dist", f)]);
}

for (const [src, dst] of jobs) {
  let code = stripTypeScriptTypes(readFileSync(src, "utf8"), { mode: "strip" });
  code = code
  .replaceAll("../src/core/", "./core/")
  .replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2");
  const out = dst.replace(/\.ts$/, ".js");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, code);
  console.log(`${src} -> ${out}`);
}
console.log("web build complete");
