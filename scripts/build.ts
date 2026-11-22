import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceDir = join(root, "src");
const outputDir = join(root, "public", "js");

export async function build(): Promise<void> {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const files = (await readdir(sourceDir))
    .filter((name) => name.endsWith(".ts"))
    .sort();

  for (const file of files) {
    const source = await readFile(join(sourceDir, file), "utf8");
    const stripped = stripTypeScriptTypes(source, {
      mode: "strip",
      sourceUrl: file,
    });
    await writeFile(join(outputDir, file.replace(/\.ts$/, ".js")), stripped);
  }

  console.log(`[build] ${files.length} TypeScript modules -> public/js`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await build();
}
