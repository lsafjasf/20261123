import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("./web/", import.meta.url)));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".ico": "image/x-icon",
};

function securityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; " +
      "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'",
  );
}

function sendText(response: ServerResponse, status: number, body: string): void {
  securityHeaders(response);
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function serveFile(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  let relative = "";
  try {
    relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    sendText(response, 400, "Bad request");
    return;
  }
  const filePath = normalize(join(ROOT, relative));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendText(response, 404, "Not found");
      return;
    }

    const extension = extname(filePath).toLowerCase();
    let bytes = await readFile(filePath);
    if (extension === ".ts") {
      const source = bytes.toString("utf8");
      bytes = Buffer.from(
        stripTypeScriptTypes(source, {
          mode: "strip",
          sourceUrl: pathname,
        }),
      );
    }

    securityHeaders(response);
    response.writeHead(200, {
      "Content-Type": MIME[extension] || "application/octet-stream",
      "Content-Length": bytes.byteLength,
      "Cache-Control": extension === ".ts" ? "no-store" : "no-cache",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(bytes);
  } catch {
    sendText(response, 404, "Not found");
  }
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method not allowed");
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/health") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ ok: true, mode: "local-only", dependencies: 0 }));
    return;
  }
  await serveFile(request, response, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Pause Studio ready at http://localhost:${PORT}`);
  console.log("Local-only server · no package dependencies · originals stay read-only");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
