/**
 * 零依赖静态服务器：
 * - 只使用 node:http / node:fs / node:path / node:module；
 * - .ts 请求即时类型擦除为 JS ESM，浏览器无需构建步骤；
 * - 路径限制在项目根内，防止目录穿越。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const ROOT = resolve(process.cwd());
const PORT = Number(process.env.PORT ?? 5173);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function safePath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = join(ROOT, relative);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const urlPath = request.url === "/" ? "/public/index.html" : request.url ?? "/";
  let filePath = safePath(urlPath);
  if (!filePath) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
    let bytes = await readFile(filePath);
    const ext = extname(filePath);
    if (ext === ".ts") {
      const source = bytes.toString("utf8");
      const js = stripTypeScriptTypes(source, { mode: "transform" });
      bytes = Buffer.from(js);
    }
    response.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
    } else {
      response.writeHead(500).end(`Server Error: ${(error as Error).message}`);
    }
  }
}

const server = createServer((request, response) => {
  void serve(request, response);
});

server.listen(PORT, () => {
  console.log(`BeatCut 运行在 http://localhost:${PORT}/`);
  console.log("按 Ctrl+C 停止");
});
