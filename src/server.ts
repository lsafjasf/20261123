import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIST = join(ROOT, "dist", "src");
const SAMPLES = join(ROOT, "samples");
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function safePath(root: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const target = resolve(root, `.${normalized}`);
  return target.startsWith(`${resolve(root)}/`) || target === resolve(root) ? target : null;
}

async function serveFile(path: string, range: string | undefined, res: import("node:http").ServerResponse) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("not a file");
  const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string | number> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": path.includes("/samples/") ? "public, max-age=3600" : "no-cache",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; worker-src 'self' blob:"
  };

  if (range && info.size > 0) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      if (start <= end && start < info.size) {
        res.writeHead(206, {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${info.size}`,
          "Content-Length": end - start + 1
        });
        createReadStream(path, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, { ...headers, "Content-Length": info.size });
  createReadStream(path).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, offline: true, node: process.version, port: PORT }));
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.startsWith("/samples/")) {
      const path = safePath(SAMPLES, url.pathname.slice("/samples".length));
      if (!path) throw new Error("invalid path");
      await serveFile(path, req.headers.range, res);
      return;
    }
    const pathname =
      url.pathname === "/"
        ? "/client/index.html"
        : url.pathname.startsWith("/shared/")
          ? url.pathname
          : `/client${url.pathname}`;
    const path = safePath(DIST, pathname);
    if (!path) throw new Error("invalid path");
    await serveFile(path, req.headers.range, res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Framelock running offline at http://${HOST}:${PORT}`);
  console.log("All decoding, compositing, and encoding happens in this browser session.");
});

server.on("error", (error: Error & { code?: string }) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Start with: PORT=4180 npm start`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
