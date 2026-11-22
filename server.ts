import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const SOURCE_DIR = join(ROOT, "src");
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "127.0.0.1";

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "worker-src 'self'",
    "connect-src 'self'",
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(self), microphone=(self)",
  "Cache-Control": "no-store",
};

function isInside(parent: string, candidate: string): boolean {
  const normalized = normalize(candidate);
  return normalized.startsWith(parent + sep) || normalized === parent;
}

function writeError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/public\//, "").replace(/^\//, "");
  const target = resolve(PUBLIC_DIR, relative);
  if (!isInside(PUBLIC_DIR, target)) {
    writeError(response, 403, "Forbidden");
    return;
  }

  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    writeError(response, 404, "Not found");
    return;
  }

  const body = await readFile(target);
  const type = STATIC_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type });
  response.end(body);
}

async function serveTypeScript(pathname: string, response: ServerResponse): Promise<void> {
  const relative = pathname.replace(/^\/src\//, "");
  const target = resolve(SOURCE_DIR, relative);
  if (!target.endsWith(".ts") || !isInside(SOURCE_DIR, target)) {
    writeError(response, 403, "Forbidden");
    return;
  }

  const source = await readFile(target, "utf8").catch(() => null);
  if (source === null) {
    writeError(response, 404, "Not found");
    return;
  }

  const javascript = stripTypeScriptTypes(source, {
    mode: "strip",
    sourceMap: false,
  });
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/javascript; charset=utf-8",
  });
  response.end(javascript);
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method !== "GET" && request.method !== "HEAD") {
    writeError(response, 405, "Method not allowed");
    return;
  }
  if (url.pathname === "/health") {
    response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, local: true }));
    return;
  }
  if (url.pathname.startsWith("/src/")) {
    await serveTypeScript(url.pathname, response);
    return;
  }
  await serveStatic(url.pathname, response);
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error(error);
    if (!response.headersSent) {
      writeError(response, 500, "Internal server error");
    } else {
      response.destroy();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Trail replay ready at http://${HOST}:${PORT}`);
  console.log("All media stays in this browser; no external requests.");
});
