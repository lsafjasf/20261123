// 零依赖静态服务器：直接伺服仓库文件；
// .ts 请求用 Node 内置 stripTypeScriptTypes 现场擦除类型后发给浏览器。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = process.cwd();
const port = Number(process.argv[2] ?? 8080);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".mp4": "video/mp4",
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (path === "/") path = "/web/index.html";
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const data = await readFile(file);
    const ext = extname(file);
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    if (ext === ".ts") {
      res.end(stripTypeScriptTypes(data.toString("utf8"), { mode: "strip" }));
    } else {
      res.end(data);
    }
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => {
  console.log(`验证页: http://localhost:${port}/  （根目录 ${root}）`);
});
