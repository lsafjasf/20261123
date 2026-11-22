import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(root, "src", "client");
const outputRoot = join(root, "public", "js");

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(fullPath)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files;
}

await rm(outputRoot, { recursive: true, force: true });
const files = await listTypeScriptFiles(sourceRoot);

for (const file of files) {
  const source = await readFile(file, "utf8");
  const output = stripTypeScriptTypes(source, {
    mode: "transform",
    sourceMap: false,
    sourceUrl: relative(sourceRoot, file)
  });
  const destination = join(outputRoot, relative(sourceRoot, file)).replace(/\.ts$/, ".js");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${output}\n`, "utf8");
}

console.log(`Built ${files.length} client modules into public/js`);
