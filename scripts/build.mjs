import { readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(root, "src");
const outputRoot = join(root, "dist", "src");

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function rewriteImports(source) {
  return source
    .replace(/(\bfrom\s+["'])(\.[^"']+)\.ts(["'])/g, "$1$2.js$3")
    .replace(/(\bimport\s+["'])(\.[^"']+)\.ts(["'])/g, "$1$2.js$3")
    .replace(/(\bimport\s*\(\s*["'])(\.[^"']+)\.ts(["'])/g, "$1$2.js$3");
}

await rm(join(root, "dist"), { recursive: true, force: true });
const files = await collect(sourceRoot);
for (const file of files) {
  const source = await readFile(file, "utf8");
  const stripped = stripTypeScriptTypes(source, { mode: "transform" });
  const output = rewriteImports(stripped);
  const destination = join(outputRoot, relative(sourceRoot, file)).replace(
    /\.ts$/,
    ".js",
  );
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output, "utf8");
}
console.log(`built ${files.length} TypeScript modules into dist/src`);
