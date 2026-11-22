import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const compiledRoot = fileURLToPath(new URL("../public/", import.meta.url));
const root = existsSync(compiledRoot) ? compiledRoot : join(process.cwd(), "public");
const port = Number.parseInt(process.env.PORT ?? "4178", 10);
const host = process.env.HOST ?? "127.0.0.1";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};

function resolvePath(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }

  const target = decoded === "/" ? "/index.html" : decoded;
  const safe = normalize(target).replace(/^(\.\.[/\\])+/, "");
  const absolute = join(root, safe);
  if (absolute !== root && !absolute.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return null;
  }
  return absolute;
}

const server = createServer(async (request, response) => {
  const started = performance.now();
  const method = request.method ?? "GET";

  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );

  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }

  if (request.url === "/api/health") {
    const body = JSON.stringify({
      ok: true,
      mode: "offline-local",
      service: "six-cue",
      now: new Date().toISOString(),
    });
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(method === "HEAD" ? undefined : body);
    return;
  }

  const path = resolvePath(request.url ?? "/");
  if (!path) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }

  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    const ext = extname(path).toLowerCase();
    const headers: Record<string, string | number> = {
      "Content-Type": types[ext] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Last-Modified": info.mtime.toUTCString(),
      "Cache-Control": ext === ".html" || ext === ".js" || ext === ".css" ? "no-cache" : "public, max-age=3600",
    };
    response.writeHead(200, headers);
    if (method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(path)
      .on("error", () => response.destroy())
      .pipe(response);
  } catch {
    if (method === "GET" && !extname(path)) {
      const body = await import("node:fs/promises").then(({ readFile }) => readFile(join(root, "index.html")));
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.byteLength,
        "Cache-Control": "no-cache",
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } finally {
    const elapsed = (performance.now() - started).toFixed(1);
    if (process.env.QUIET !== "1") {
      console.log(`${method} ${request.url ?? "/"} ${response.statusCode} ${elapsed}ms`);
    }
  }
});

server.listen(port, host, () => {
  console.log(`SIX/CUE ready at http://${host}:${port}`);
  console.log("Offline mode: no external connections, no credentials, no cloud.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
