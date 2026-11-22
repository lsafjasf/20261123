import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

async function transpileDirectory(sourceDirectory, outputDirectory, rootDirectory) {
  const files = await listTypeScriptFiles(sourceDirectory);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    let output;
    try {
      output = stripTypeScriptTypes(source, {
        mode: "strip",
        sourceUrl: relative(rootDirectory, file),
      });
    } catch (error) {
      throw new Error(`Failed to transpile ${relative(rootDirectory, file)}: ${error.message}`);
    }
    const target = join(outputDirectory, relative(sourceDirectory, file)).replace(/\.ts$/, ".js");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output, "utf8");
  }
  return files.length;
}

await rm(join(root, "dist"), { recursive: true, force: true });
await rm(join(root, "public", "js"), { recursive: true, force: true });

const serverCount = await transpileDirectory(join(root, "server"), join(root, "dist", "server"), root);
const clientCount = await transpileDirectory(join(root, "client"), join(root, "public", "js"), root);

const shellFiles = [
  "index.html",
  "styles.css",
  "favicon.svg",
  "js/app.js",
  "js/artwork.js",
  "js/audio.js",
  "js/bootstrap.js",
  "js/crypto.js",
  "js/db.js",
  "js/errors.js",
  "js/generate.js",
  "js/licensing.js",
  "js/player.js",
  "js/types.js",
  "js/webm.js",
];
const buildHash = createHash("sha256");
for (const file of shellFiles) {
  buildHash.update(await readFile(join(root, "public", file)));
}
const serviceWorkerPath = join(root, "public", "js", "sw.js");
const serviceWorker = await readFile(serviceWorkerPath, "utf8");
await writeFile(serviceWorkerPath, serviceWorker.replace("__BUILD_ID__", buildHash.digest("hex").slice(0, 12)), "utf8");

console.log(`Built ${serverCount} server modules and ${clientCount} browser modules without external packages.`);
