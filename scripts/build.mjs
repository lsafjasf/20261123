import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(root, "src");
const outputRoot = join(root, "public", "app");
const sourceFiles = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.name.endsWith(".ts")) sourceFiles.push(path);
  }
}

await collect(sourceRoot);
for (const sourcePath of sourceFiles) {
  const source = await readFile(sourcePath, "utf8");
  const transformed = stripTypeScriptTypes(source, { mode: "transform" })
    .replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2")
    .replace(/(import\(\s*["'][^"']+)\.ts(["']\s*\))/g, "$1.js$2");
  const relativePath = relative(sourceRoot, sourcePath).replace(/\.ts$/, ".js");
  const outputPath = join(outputRoot, relativePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `// Generated from src/${relative(sourceRoot, sourcePath)}. Do not edit.\n${transformed}`,
    "utf8",
  );
}

console.log(`Built ${sourceFiles.length} TypeScript modules into public/app`);
