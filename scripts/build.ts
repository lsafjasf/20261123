import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceDir = join(root, "src");
const clientOut = join(root, "public", "app");
const distDir = join(root, "dist");

async function listTs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listTs(path);
      return extname(entry.name) === ".ts" ? [path] : [];
    }),
  );
  return nested.flat();
}

function rewriteImports(code: string): string {
  return code.replace(/(from\s+["']|import\s*\(\s*["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, "$1$2.js$3");
}

async function transpile(source: string, target: string): Promise<number> {
  const input = await readFile(source, "utf8");
  const stripped = stripTypeScriptTypes(input, { mode: "transform", sourceUrl: relative(root, source) });
  const output = rewriteImports(stripped);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, output, "utf8");
  return Buffer.byteLength(output);
}

async function main(): Promise<void> {
  const started = performance.now();
  await rm(clientOut, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await mkdir(clientOut, { recursive: true });
  await mkdir(distDir, { recursive: true });

  const files = await listTs(sourceDir);
  const sizes = await Promise.all(
    files.map(async (file) => {
      const out = join(clientOut, relative(sourceDir, file).replace(/\.ts$/, ".js"));
      return transpile(file, out);
    }),
  );

  sizes.push(await transpile(join(root, "server.ts"), join(distDir, "server.js")));
  const bytes = sizes.reduce((total, size) => total + size, 0);
  const version = new Date().toISOString();
  await writeFile(
    join(clientOut, "build.json"),
    JSON.stringify({ version, modules: files.length + 1, bytes }, null, 2),
    "utf8",
  );
  console.log(
    `Built ${files.length + 1} TypeScript modules (${(bytes / 1024).toFixed(1)} KiB) in ${(performance.now() - started).toFixed(0)}ms`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
