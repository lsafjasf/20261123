// Offline build: strip TypeScript types with Node's built-in API.
// No third-party dependencies; src/*.ts must use erasable syntax only.
import { stripTypeScriptTypes } from "node:module";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(root, "src");
const outDir = join(root, "public", "js");

await mkdir(outDir, { recursive: true });
const files = (await readdir(srcDir)).filter((f) => f.endsWith(".ts"));
for (const file of files) {
  const code = await readFile(join(srcDir, file), "utf8");
  const js = stripTypeScriptTypes(code, { mode: "strip", sourceMap: false });
  const out = join(outDir, file.replace(/\.ts$/, ".js"));
  await writeFile(out, js);
  console.log(`built ${file} -> public/js/${file.replace(/\.ts$/, ".js")}`);
}
