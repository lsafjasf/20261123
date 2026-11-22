import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT || 4173);

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "Method Not Allowed");
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/web/index.html";
    const relative = normalize(pathname).replace(/^([/\\])+/, "");
    if (relative.startsWith("..") || relative.includes(`..${sep}`)) {
      send(response, 403, "Forbidden");
      return;
    }
    if (!relative.startsWith(`web${sep}`) && !relative.startsWith(`src${sep}`) && !relative.startsWith(`assets${sep}`)) {
      send(response, 404, "Not Found");
      return;
    }
    const file = join(root, relative);
    const info = await stat(file);
    if (!info.isFile()) {
      send(response, 404, "Not Found");
      return;
    }
    const extension = extname(file).toLowerCase();
    response.statusCode = 200;
    response.setHeader("Content-Type", mime[extension] ?? "application/octet-stream");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'",
    );
    if (extension === ".ts") {
      const source = await readFile(file, "utf8");
      const output = stripTypeScriptTypes(source, {
        mode: "strip",
        sourceUrl: pathname,
      });
      response.end(request.method === "HEAD" ? undefined : output);
      return;
    }
    response.setHeader("Content-Length", info.size);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      send(response, 404, "Not Found");
    } else {
      console.error(error);
      send(response, 500, "Internal Server Error");
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`SeamLab ready at http://127.0.0.1:${port}`);
});

function send(response: import("node:http").ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(body);
}
