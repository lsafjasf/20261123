import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(root, "src");
const outputRoot = join(root, "public", "js");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile() && extname(entry.name) === ".ts") files.push(path);
  }
  return files;
}

const files = await walk(sourceRoot);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const file of files) {
  const source = await readFile(file, "utf8");
  const output = stripTypeScriptTypes(source, { mode: "strip" });
  const destination = join(outputRoot, relative(sourceRoot, file)).replace(/\.ts$/, ".js");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output);
}

console.log(`Built ${files.length} TypeScript modules into public/js`);
