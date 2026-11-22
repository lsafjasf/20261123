import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "0.0.0.0";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}

function resolveRequestPath(urlPath: string): string | null {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const requested = clean === "/" ? "/index.html" : clean;
  const full = normalize(join(ROOT, requested));
  if (full !== ROOT && !isInside(ROOT, full)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end("Method not allowed");
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, service: "frametrace", offline: true }));
      return;
    }

    const target = resolveRequestPath(req.url ?? "/");
    if (!target) {
      res.writeHead(400);
      res.end("Bad path");
      return;
    }

    const info = await stat(target);
    if (!info.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const type = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
    let body: Buffer | string = await readFile(target);
    if (extname(target) === ".ts") {
      body = stripTypeScriptTypes(body.toString("utf8"), { mode: "strip" });
    }

    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "cross-origin-opener-policy": "same-origin"
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    res.writeHead(code === "ENOENT" ? 404 : 500, {
      "content-type": "text/plain; charset=utf-8"
    });
    res.end(code === "ENOENT" ? "Not found" : "Internal server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FrameTrace running at http://localhost:${PORT}`);
});
