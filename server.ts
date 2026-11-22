// 开发/导出服务器：仅使用 Node.js 标准库。
// 用法: node server.ts [port]
import { createServer } from "node:http";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const exportsDir = join(root, "exports");
const port = Number(process.argv[2] ?? 8080);

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".wasm": "application/wasm",
};

function safePath(urlPath: string): string | null {
  const p = normalize(join(publicDir, decodeURIComponent(urlPath)));
  return p.startsWith(publicDir) ? p : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && url.pathname === "/save") {
    // 用户在浏览器确认导出后，把生成的 MP4 写到 exports/
    const name = (url.searchParams.get("name") ?? "cut.mp4").replace(/[^\w.-]/g, "_");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        await mkdir(exportsDir, { recursive: true });
        const file = join(exportsDir, name);
        await writeFile(file, Buffer.concat(chunks));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, file }));
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  const p = safePath(url.pathname === "/" ? "/index.html" : url.pathname);
  if (!p) {
    res.writeHead(403).end();
    return;
  }
  try {
    const st = await stat(p);
    if (st.isDirectory()) throw new Error("dir");
    const data = await readFile(p);
    res.writeHead(200, {
      "content-type": mime[extname(p)] ?? "application/octet-stream",
      "content-length": data.byteLength,
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, () => {
  console.log(`serving http://localhost:${port}  (exports -> ${exportsDir})`);
});
