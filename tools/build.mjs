import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const out = join(root, "public");

await mkdir(join(out, "modules"), { recursive: true });

for (const name of await readdir(src)) {
  if (!name.endsWith(".ts")) continue;
  const input = await readFile(join(src, name), "utf8");
  let js = stripTypeScriptTypes(input, { mode: "strip", sourceUrl: name });
  js = js.replaceAll(/from "\.\/([^"]+)\.ts"/g, 'from "./$1.js"');
  js = js.replaceAll(/from '\.\/([^']+)\.ts'/g, "from './$1.js'");
  await writeFile(join(out, "modules", basename(name, ".ts") + ".js"), js);
}

const css = await readFile(join(src, "styles.css"), "utf8");
await writeFile(join(out, "styles.css"), css);

const html = await readFile(join(src, "index.html"), "utf8");
await writeFile(join(out, "index.html"), html);

const built = (await readdir(join(out, "modules"))).sort();
console.log(`Built ${built.length} modules: ${built.join(", ")} (${relative(root, out)}/)`);
