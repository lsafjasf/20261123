import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

const root = resolve(new URL("../", import.meta.url).pathname);
const webRoot = join(root, "web");
const tempRoot = mkdtempSync(join(tmpdir(), "pause-studio-check-"));
const failures: string[] = [];

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function checkJavaScript(path: string, source: string, transformed: boolean): void {
  const output = join(tempRoot, `${relative(root, path).replaceAll("/", "_")}.mjs`);
  writeFileSync(output, transformed ? stripTypeScriptTypes(source, { mode: "strip" }) : source);
  const result = spawnSync(process.execPath, ["--check", output], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`${relative(root, path)}\n${result.stderr || result.stdout}`);
  }
}

for (const path of walk(join(webRoot, "src"))) {
  if (extname(path) === ".ts") checkJavaScript(path, readFileSync(path, "utf8"), true);
}
checkJavaScript(join(root, "server.ts"), readFileSync(join(root, "server.ts"), "utf8"), true);

const html = readFileSync(join(webRoot, "index.html"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length > 0) failures.push(`Duplicate HTML ids: ${[...new Set(duplicateIds)].join(", ")}`);

const appSource = readFileSync(join(webRoot, "src", "app.ts"), "utf8");
const elementReferences = [...appSource.matchAll(/element<[^>]+>\("([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(elementReferences.filter((id) => !ids.includes(id)))];
if (missingIds.length > 0) failures.push(`Missing HTML targets: ${missingIds.join(", ")}`);

const css = readFileSync(join(webRoot, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
let depth = 0;
for (const character of css) {
  if (character === "{") depth += 1;
  if (character === "}") depth -= 1;
  if (depth < 0) break;
}
if (depth !== 0) failures.push(`Unbalanced CSS braces (${depth})`);

const networkReferences = [
  ...html.matchAll(/(?:src|href)="(https?:\/\/[^\"]+)"/g),
].map((match) => match[1]);
if (networkReferences.length > 0) failures.push(`External network references: ${networkReferences.join(", ")}`);

mkdirSync(tempRoot, { recursive: true });
rmSync(tempRoot, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  process.exit(1);
}
console.log(`OK · ${ids.length} HTML ids · ${elementReferences.length} app bindings · 0 dependencies`);
