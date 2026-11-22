import { access, readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicDir = join(root, "public");

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return files.flat();
}

const generated = (await walk(publicDir)).filter((file) => extname(file) === ".js");
for (const file of generated) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}
await access(join(root, "dist", "server.js"));
execFileSync(process.execPath, ["--check", join(root, "dist", "server.js")], { stdio: "pipe" });

const html = await readFile(join(publicDir, "index.html"), "utf8");
const external = [...html.matchAll(/(?:src|href)=["'](https?:)?\/\//g)];
if (external.length > 0) throw new Error("External assets are not allowed");
const css = await readFile(join(publicDir, "styles.css"), "utf8");
if (/url\(\s*["']?https?:/i.test(css) || /@import\s+url/i.test(css)) {
  throw new Error("External CSS assets are not allowed");
}

for (const asset of ["styles.css", "app/main.js"]) {
  await readFile(join(publicDir, asset));
}

console.log(`Checked ${generated.length} generated modules; all assets are local.`);
