import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = process.cwd();
const port = Number(process.env.PORT ?? 8080);

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    if (path === "" || path === ".") path = "public/index.html";
    if (path.startsWith("src/")) path = path; // browser TS modules
    else if (!path.startsWith("public/")) path = join("public", path);
    const file = join(root, path);
    if (!file.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const ext = extname(file);
    if (ext === ".ts") {
      const src = await readFile(file, "utf8");
      const js = stripTypeScriptTypes(src, { mode: "strip" });
      res.writeHead(200, { "content-type": mime[".js"], "cache-control": "no-store" });
      res.end(js);
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": mime[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, () => {
  console.log(`splice-forensics listening on http://localhost:${port}`);
});
