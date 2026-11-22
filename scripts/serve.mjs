import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.cwd());
const port = Number(process.env.PORT ?? 4173);
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const relativePath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const path = resolve(join(root, normalize(relativePath)));
    if (!path.startsWith(`${root}/`) && path !== root) {
      response.writeHead(403).end("forbidden");
      return;
    }
    if (!(await stat(path)).isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(path);
    response.writeHead(200, {
      "content-type": mime.get(extname(path)) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`exact timeline demo: http://127.0.0.1:${port}/\n`);
});
