import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicRoot = join(root, "public");
const dataRoot = join(root, "data");
const savedManifestPath = join(dataRoot, "saved-manifest.json");
const mediaTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function createAppServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/api/health") {
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname === "/api/demo-manifest" && request.method === "GET") {
        const body = await readFile(join(dataRoot, "demo-manifest.json"));
        return sendBuffer(response, 200, body, mediaTypes[".json"], false);
      }
      if (url.pathname === "/api/manifest") {
        return handleSavedManifest(request, response);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return sendJson(response, 405, { error: "Method not allowed" });
      }
      return serveStatic(request, response, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(response, 500, { error: message });
    }
  });
}

async function handleSavedManifest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET") {
    try {
      const body = await readFile(savedManifestPath);
      sendBuffer(response, 200, body, mediaTypes[".json"], false);
    } catch {
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
    }
    return;
  }
  if (request.method !== "PUT") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  const body = await readBody(request, 2 * 1024 * 1024);
  try {
    JSON.parse(body);
  } catch {
    sendJson(response, 400, { error: "Manifest must be valid JSON" });
    return;
  }
  await mkdir(dataRoot, { recursive: true });
  await writeFile(savedManifestPath, body, "utf8");
  sendJson(response, 200, { ok: true, bytes: Buffer.byteLength(body) });
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  const decoded = decodeURIComponent(pathname);
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = resolve(publicRoot, normalize(relativePath));
  if (!filePath.startsWith(`${publicRoot}/`) && filePath !== publicRoot) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  let details;
  try {
    details = await stat(filePath);
  } catch {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  if (!details.isFile()) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const extension = extname(filePath).toLowerCase();
  const contentType = mediaTypes[extension] ?? "application/octet-stream";
  const cacheControl = extension === ".mp4" ? "public, max-age=3600" : "no-cache";
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { "Content-Range": `bytes */${details.size}` });
      response.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2]
      ? Math.min(Number(match[2]), details.size - 1)
      : details.size - 1;
    if (start > end || start >= details.size) {
      response.writeHead(416, { "Content-Range": `bytes */${details.size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      "Content-Type": contentType,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${details.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl,
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": details.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  sendBuffer(
    response,
    status,
    Buffer.from(JSON.stringify(value)),
    mediaTypes[".json"],
    false,
  );
}

function sendBuffer(
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  cache: boolean,
): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": cache ? "public, max-age=60" : "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.PORT ?? 4173);
  const server = createAppServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`First Aid Branch Studio: http://localhost:${port}`);
  });
}
