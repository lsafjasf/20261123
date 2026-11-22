// 零依赖静态文件服务器：浏览器 ES Module 需要 http(s) 源，不能用 file://。
// 运行：npm run serve，然后打开 http://localhost:8080/

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(import.meta.url), "..", "..", ".."));
const port = Number(process.env.PORT ?? 8080);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wav": "audio/wav",
};

interface Req { url?: string }
interface Res {
  writeHead(code: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

createServer((req: unknown, res: unknown) => {
  const r = req as Req;
  const w = res as Res;
  void (async () => {
    let path = decodeURIComponent((r.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      w.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      w.end("403");
      return;
    }
    try {
      const data = await readFile(file);
      w.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      w.end(data as unknown as string);
    } catch {
      w.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      w.end("404");
    }
  })();
}).listen(port, () => {
  console.log(`打开 http://localhost:${port}/ 使用双麦串音处理工具`);
});
