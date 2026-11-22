import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(root, "src");
const outputRoot = join(root, "dist");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

export async function build() {
  await rm(outputRoot, { recursive: true, force: true });
  const files = await walk(sourceRoot);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const stripped = stripTypeScriptTypes(source, {
      mode: "strip",
      sourceMap: false,
    });
    const browserSource = stripped.replace(
      /(from\s+["'][^"']+)\.ts(["'])/g,
      "$1.js$2",
    );
    const target = join(outputRoot, relative(sourceRoot, file)).replace(
      /\.ts$/,
      ".js",
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, browserSource);
  }
  for (const asset of ["index.html", "styles.css"]) {
    await mkdir(outputRoot, { recursive: true });
    await writeFile(join(outputRoot, asset), await readFile(join(root, asset)));
  }
  return files.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = await build();
  console.log(`Built ${count} TypeScript modules into dist/`);
}
