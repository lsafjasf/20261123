// Local dev server. Node standard library only.
// - serves index.html and static assets
// - transpiles src/*.ts on the fly via node:module type stripping
// - serves media/*.mp4 with Range support
// - POST /api/export persists export reports to artifacts/
import { createServer } from "node:http";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8321);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
};

function safePath(urlPath: string): string | null {
  const p = normalize(join(ROOT, decodeURIComponent(urlPath)));
  return p.startsWith(ROOT) ? p : null;
}

async function serveTs(res: import("node:http").ServerResponse, path: string) {
  const src = await readFile(path, "utf8");
  const js = stripTypeScriptTypes(src, { mode: "strip" });
  res.writeHead(200, { "content-type": MIME[".js"] });
  res.end(js);
}

async function serveFile(
  res: import("node:http").ServerResponse, path: string, range?: string,
) {
  const st = await stat(path);
  const type = MIME[extname(path)] ?? "application/octet-stream";
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      const fh = await readFile(path);
      res.writeHead(206, {
        "content-type": type,
        "content-range": `bytes ${start}-${end}/${st.size}`,
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
      });
      res.end(fh.subarray(start, end + 1));
      return;
    }
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": st.size,
    "accept-ranges": "bytes",
  });
  res.end(await readFile(path));
}

async function saveExport(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) {
  let body = "";
  for await (const chunk of req) body += chunk;
  const report = JSON.parse(body);
  await mkdir(join(ROOT, "artifacts"), { recursive: true });
  const name = `export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const path = join(ROOT, "artifacts", name);
  await writeFile(path, JSON.stringify(report, null, 2));
  res.writeHead(200, { "content-type": MIME[".json"] });
  res.end(JSON.stringify({ saved: `artifacts/${name}` }));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/export" && req.method === "POST") {
      return await saveExport(req, res);
    }
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const fsPath = safePath(path);
    if (!fsPath) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (fsPath.endsWith(".ts")) {
      return await serveTs(res, fsPath);
    }
    await serveFile(res, fsPath, req.headers.range);
  } catch (err) {
    res.writeHead(404).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`reverse-replay server: http://localhost:${PORT}/`);
});
