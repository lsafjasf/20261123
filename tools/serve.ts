// Tiny static file server for the UI (Node stdlib only).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const ROOT = "public";
const PORT = Number(process.env.PORT ?? 8321);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".json": "application/json",
  ".wav": "audio/wav",
};

createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const path = normalize(join(ROOT, url === "/" ? "app/index.html" : url));
  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  readFile(path)
    .then((data) => {
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(data);
    })
    .catch(() => res.writeHead(404).end("not found"));
}).listen(PORT, () => {
  console.log(`serving ${ROOT}/ at http://localhost:${PORT}`);
});
