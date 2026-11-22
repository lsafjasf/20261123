/**
 * Local static server for the browser verifier. Node stdlib only.
 *
 *   node web/serve.ts [--out out] [--port 8080]
 *
 * Routes:
 *   /            -> web/index.html
 *   /web/*       -> files under web/
 *   /output/*    -> files under the migration output dir
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(webRoot, "..");

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = arg("--out", join(repoRoot, "out"));
const port = Number(arg("--port", "8080"));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
};

function safeJoin(root: string, rel: string): string | null {
  const p = normalize(join(root, rel));
  return p.startsWith(normalize(root)) ? p : null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = url.pathname;
    let file: string | null;
    if (path === "/") file = join(webRoot, "index.html");
    else if (path.startsWith("/output/")) file = safeJoin(outDir, path.slice(8));
    else if (path.startsWith("/media/")) file = safeJoin(repoRoot, path.slice(1));
    else file = safeJoin(webRoot, path.slice(1));
    if (!file) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let body: Buffer | string = await readFile(file);
    if (file.endsWith(".ts")) {
      // Browsers can't parse type annotations; strip them on the fly
      // with Node's built-in transformer (still zero dependencies).
      body = stripTypeScriptTypes(body.toString("utf8"), { mode: "strip" });
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, () => {
  console.log(`verifier: http://localhost:${port}/ (output dir: ${outDir})`);
});
