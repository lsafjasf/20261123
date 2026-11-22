// 零依赖本地静态服务器，支持 Range 请求（MediaSource / <video> 回放需要）。
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const publicDir = join(root, "dist");
const port = Number(process.env.PORT ?? 8080);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".cube": "text/plain; charset=utf-8",
  ".3dl": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const filePath = normalize(join(publicDir, pathname));
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404).end("Not Found");
      return;
    }
    const type = mime[extname(filePath)] ?? "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const size = info.size;
      let start = match?.[1] ? Number(match[1]) : 0;
      let end = match?.[2] ? Number(match[2]) : size - 1;
      if (Number.isNaN(start) || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes"
      });
      const buffer = await readFile(filePath);
      res.end(buffer.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": info.size });
    res.end(await readFile(filePath));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});

server.listen(port, () => {
  console.log(`调色台已启动：http://localhost:${port}/ （根目录 dist/，Ctrl+C 退出）`);
});
