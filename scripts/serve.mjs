import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))), "public");
const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime"
};

function safePath(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, "http://local").pathname);
  const target = resolve(join(root, normalize(pathname)));
  return target === root || target.startsWith(root + sep) ? target : null;
}

createServer(async (request, response) => {
  try {
    const requested = request.url?.split("?")[0] || "/";
    let path = safePath(requested);
    if (!path) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      path = join(path, "index.html");
      info = await stat(path).catch(() => null);
    }
    if (!info?.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }

    const headers = {
      "Content-Type": mimeTypes[extname(path)] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store"
    };
    const range = request.headers.range;
    if (range) {
      const [startText, endText] = range.replace(/bytes=/, "").split("-");
      const start = Math.max(0, Number(startText) || 0);
      const end = endText ? Math.min(Number(endText), info.size - 1) : info.size - 1;
      if (start > end || start >= info.size) {
        response.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end();
        return;
      }
      response.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Content-Length": end - start + 1
      });
      createReadStream(path, { start, end }).pipe(response);
      return;
    }

    response.writeHead(200, { ...headers, "Content-Length": info.size });
    if (request.method === "HEAD") response.end();
    else createReadStream(path).pipe(response);
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : "Server error");
  }
}).listen(port, () => {
  console.log(`Frame Lens available at http://localhost:${port}`);
});
