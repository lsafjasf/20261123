import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { watch } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const DIRS = ["src", "scripts", "tests"];
const ASSET_EXTENSIONS = new Set([".html", ".css", ".svg", ".png", ".woff2"]);

async function walk(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(child)));
    else files.push(child);
  }
  return files;
}

function outputPath(file: string): string {
  const suffix = extname(file) === ".ts" ? ".js" : extname(file);
  const relativePath = relative(ROOT, file).replace(/\.ts$/, suffix);
  return join(DIST, relativePath);
}

async function compileFile(file: string): Promise<void> {
  const target = outputPath(file);
  await mkdir(dirname(target), { recursive: true });
  if (extname(file) === ".ts") {
    const source = await readFile(file, "utf8");
    const stripped = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: file });
    await writeFile(target, stripped);
  } else if (ASSET_EXTENSIONS.has(extname(file))) {
    await copyFile(file, target);
  }
}

async function build(): Promise<void> {
  const startedAt = performance.now();
  await rm(DIST, { recursive: true, force: true });
  const files: string[] = [];
  for (const directory of DIRS) {
    const absolute = join(ROOT, directory);
    try {
      if ((await stat(absolute)).isDirectory()) files.push(...(await walk(absolute)));
    } catch {
      // Optional directories are skipped.
    }
  }
  for (const file of files) await compileFile(file);
  await writeFile(
    join(DIST, "build.json"),
    JSON.stringify({ builtAt: new Date().toISOString(), files: files.length, node: process.version }, null, 2)
  );
  console.log(`Built ${files.length} files in ${Math.round(performance.now() - startedAt)}ms → dist/`);
}

async function main(): Promise<void> {
  await build();
  if (!process.argv.includes("--watch")) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const directory of DIRS) {
    try {
      watch(join(ROOT, directory), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => build().catch((error) => console.error(error)), 120);
      });
    } catch {
      // Optional directory.
    }
  }
  console.log("Watching src/, scripts/, tests/ for changes…");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
