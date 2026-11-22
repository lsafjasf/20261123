import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const outputRoot = fileURLToPath(new URL("../dist/", import.meta.url));
const checkOnly = process.argv.includes("--check");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function browserModule(source) {
  return source.replace(
    /(\bfrom\s*["'][^"']+)\.ts(["'])/g,
    "$1.js$2",
  );
}

let count = 0;
for (const file of await filesUnder(sourceRoot)) {
  const source = await readFile(file, "utf8");
  let output;
  try {
    output = browserModule(stripTypeScriptTypes(source, { mode: "strip" }));
  } catch (error) {
    throw new Error(`${relative(root, file)}: ${error.message}`);
  }
  const destination = join(outputRoot, relative(sourceRoot, file)).replace(
    /\.ts$/,
    ".js",
  );
  if (!checkOnly) {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, output);
  }
  count += 1;
}

process.stdout.write(
  `${checkOnly ? "checked" : "built"} ${count} TypeScript modules` +
    `${checkOnly ? "" : " into dist/"}\n`,
);
