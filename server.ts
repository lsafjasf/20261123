import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".ts", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webm", "video/webm"],
  [".vtt", "text/vtt; charset=utf-8"],
  [".zip", "application/zip"],
]);

function safePath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded === "/" ? "src/index.html" : decoded.replace(/^\/+/, "");
  const path = normalize(join(root, relative));
  if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return null;
  }
  return path;
}

const server = createServer(async (request, response) => {
  try {
    const path = safePath(request.url ?? "/");
    if (!path) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    const ext = extname(path);
    const body = await readFile(path);
    const source = ext === ".ts"
      ? stripTypeScriptTypes(body.toString("utf8"), { mode: "strip" })
      : body;
    response.writeHead(200, {
      "Content-Type": mime.get(ext) ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    response.end(source);
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : "Server error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Portrait Cut running at http://127.0.0.1:${port}`);
});
