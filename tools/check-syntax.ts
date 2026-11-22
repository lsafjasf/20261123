import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = process.cwd();
const directories = ["src", "tools", "test"];

function walk(directory: string): string[] {
  const full = join(root, directory);
  const entries = readdirSync(full, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const files = directories.flatMap((directory) => {
  try {
    statSync(join(root, directory));
  } catch {
    return [];
  }
  return walk(directory);
});

let failures = 0;
for (const file of files) {
  try {
    const source = readFileSync(join(root, file), "utf8");
    stripTypeScriptTypes(source, { mode: "strip" });
    console.log(`ok ${relative(root, join(root, file))}`);
  } catch (error) {
    failures += 1;
    console.error(`fail ${file}: ${(error as Error).message}`);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`checked ${files.length} TypeScript files`);
}
