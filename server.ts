// Offline dev server — Node standard library only.
// Serves static files, transpiles .ts on the fly via type stripping
// (no build step, no dependencies), and exposes a tiny JSON API for
// listing take files and saving/loading the comp project.
//
//   node server.ts [port]     → http://localhost:8080

import { createServer } from "node:http";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const ROOT = process.cwd();
const TAKES_DIR = join(ROOT, "takes");
const PROJECT_FILE = join(ROOT, "project.json");
const PORT = Number(process.argv[2]) || 8080;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
};

const AUDIO_EXT = new Set([".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac"]);

function safePath(urlPath: string): string | null {
  const p = normalize(join(ROOT, decodeURIComponent(urlPath)));
  return p.startsWith(ROOT) ? p : null;
}

async function handleApi(url: URL, res: import("node:http").ServerResponse, body?: string): Promise<boolean> {
  if (url.pathname === "/api/takes" ) {
    let names: string[] = [];
    try {
      names = (await readdir(TAKES_DIR)).filter((f) => AUDIO_EXT.has(extname(f).toLowerCase())).sort();
    } catch {
      names = [];
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(names));
    return true;
  }
  if (url.pathname.startsWith("/api/takes/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/takes/".length));
    if (name.includes("/") || name.includes("..")) {
      res.writeHead(400).end("bad name");
      return true;
    }
    try {
      const data = await readFile(join(TAKES_DIR, name));
      res.writeHead(200, { "content-type": MIME[extname(name).toLowerCase()] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
    return true;
  }
  if (url.pathname === "/api/project") {
    if (body !== undefined) {
      await writeFile(PROJECT_FILE, body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      try {
        const data = await readFile(PROJECT_FILE, "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(data);
      } catch {
        res.writeHead(404).end("no project");
      }
    }
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let body: string | undefined;
    if (req.method === "POST" || req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = Buffer.concat(chunks).toString("utf8");
    }
    if (await handleApi(url, res, body)) return;

    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = safePath(path);
    if (!file) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const ext = extname(file).toLowerCase();
    let content: string | Buffer = await readFile(file);
    if (ext === ".ts") {
      // On-the-fly transpile: strip types, serve as JS. No source maps needed
      // because stripping preserves line/column layout.
      content = stripTypeScriptTypes(content.toString("utf8"), { mode: "strip" });
    }
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(content);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用，换一个：node server.ts 8081`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`take-comp → http://localhost:${PORT}`);
  console.log(`takes dir: ${TAKES_DIR}`);
});
