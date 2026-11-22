import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const port = Number(process.env.PORT ?? 8080);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wav": "audio/wav",
};

const server = createServer((request, response) => {
  void handle(request, response);
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/src/browser/index.html";
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(root, safePath);
    if (!filePath.startsWith(root)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    const bytes = await readFile(filePath);
    const ext = extname(filePath);
    if (ext === ".ts") {
      const stripped = stripTypeScriptTypes(bytes.toString("utf8"), { mode: "transform" });
      response.writeHead(200, { "Content-Type": MIME[ext]!, "Cache-Control": "no-store" });
      response.end(stripped);
      return;
    }
    response.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    response.end(bytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
    response.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(code === 404 ? "not found" : String(error));
  }
}

server.listen(port, () => {
  console.log(`sync-lab running at http://localhost:${port}/`);
});
