/** Zero-dependency static server for the web app: node tools/serve.mjs [port] */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";

const ROOT = "web";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webm": "video/webm",
};

const port = Number(process.argv[2] ?? 8080);
createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let path = normalize(join(ROOT, url === "/" ? "index.html" : url));
  if (!path.startsWith(ROOT) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
  res.end(readFileSync(path));
}).listen(port, () => console.log(`serving web/ at http://localhost:${port}`));
