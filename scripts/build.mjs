import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, "src");
const outputDir = join(root, "public", "js");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const files = (await readdir(sourceDir)).filter((name) => name.endsWith(".ts"));
for (const file of files) {
  const source = await readFile(join(sourceDir, file), "utf8");
  const stripped = stripTypeScriptTypes(source, { mode: "strip" });
  const javascript = stripped.replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2");
  await writeFile(join(outputDir, file.replace(/\.ts$/, ".js")), javascript);
}

console.log(`Built ${files.length} TypeScript modules into public/js`);
