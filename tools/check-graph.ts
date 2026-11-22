import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = process.cwd();
const entry = join(root, "src", "web", "app.ts");
const visited = new Set<string>();
const queue = [entry];

async function resolveImports(file: string): Promise<string[]> {
  const source = await readFile(file, "utf8");
  const stripped = stripTypeScriptTypes(source, { mode: "strip" });
  const imports = [...stripped.matchAll(/from\s+"(\.[^"]+)"/g)].map((match) => match[1]);
  return imports.map((spec) => resolve(dirname(file), spec));
}

while (queue.length > 0) {
  const file = queue.shift() as string;
  if (visited.has(file)) {
    continue;
  }
  visited.add(file);
  for (const dependency of await resolveImports(file)) {
    queue.push(dependency);
  }
}

console.log(`resolved ${visited.size} browser modules from app.ts`);
for (const file of visited) {
  console.log("ok", file.slice(root.length + 1));
}
