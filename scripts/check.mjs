import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith(".ts")) {
      const source = await readFile(path, "utf8");
      try {
        stripTypeScriptTypes(source, { mode: "strip" });
      } catch (error) {
        console.error(`Syntax check failed: ${path}`);
        throw error;
      }
    }
  }
}

await walk("src");
await walk("tests");
console.log("All TypeScript modules strip cleanly.");
