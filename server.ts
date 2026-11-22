import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PUBLIC = join(ROOT, "public");
const SRC = join(ROOT, "src");
const PORT = Number(process.env.PORT ?? 4173);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4"
};

function inside(parent: string, child: string): boolean {
  const rel = normalize(child).replace(/^([/\\])+/, "");
  return !rel.startsWith(`..${sep}`) && rel !== ".." && resolve(parent, rel).startsWith(parent + sep) ||
    resolve(parent, rel) === parent;
}

function sendText(
  response: import("node:http").ServerResponse,
  status: number,
  body: string,
  type = "text/plain; charset=utf-8"
): void {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

async function serveTypeScript(path: string, response: import("node:http").ServerResponse): Promise<void> {
  try {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(path, "utf8");
    const javascript = stripTypeScriptTypes(source, { mode: "transform", sourceMap: false });
    sendText(response, 200, javascript, MIME[".js"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendText(response, 500, `TypeScript transform failed:\n${message}`);
  }
}

async function serveFile(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  path: string
): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    sendText(response, 404, "Not found");
    return;
  }
  if (!info.isFile()) {
    sendText(response, 404, "Not found");
    return;
  }

  const baseHeaders: Record<string, string> = {
    "Content-Type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": extname(path) === ".mp4" ? "public, max-age=3600" : "no-store"
  };
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { ...baseHeaders, "Content-Length": String(info.size) });
    if (request.method === "HEAD") response.end();
    else createReadStream(path).pipe(response);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match) {
    response.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${info.size}` });
    response.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
  if (!Number.isFinite(start) || start < 0 || start > end || start >= info.size) {
    response.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${info.size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    ...baseHeaders,
    "Content-Range": `bytes ${start}-${end}/${info.size}`,
    "Content-Length": String(end - start + 1)
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path, { start, end }).pipe(response);
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method not allowed");
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(response, 400, "Bad request");
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    await serveFile(request, response, join(PUBLIC, "index.html"));
    return;
  }
  if (pathname.startsWith("/src/") && pathname.endsWith(".ts")) {
    const candidate = resolve(SRC, `.${pathname.slice(4)}`);
    if (!inside(SRC, candidate)) {
      sendText(response, 403, "Forbidden");
      return;
    }
    await serveTypeScript(candidate, response);
    return;
  }
  const candidate = resolve(PUBLIC, `.${pathname}`);
  if (!inside(PUBLIC, candidate)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  await serveFile(request, response, candidate);
});

let port = PORT;
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE" && port < PORT + 20) {
    port += 1;
    server.listen(port, "0.0.0.0");
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
server.on("listening", () => {
  console.log(`Frame review server: http://localhost:${port}`);
});
server.listen(port, "0.0.0.0");
