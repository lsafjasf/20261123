import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml"
};

const handler = async (req, res) => {
  const pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  const clean = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, clean);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin"
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
};

function listen(candidate, attempt = 0) {
  const server = createServer(handler);
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempt < 20) {
      console.log(`Port ${candidate} busy, trying ${candidate + 1}…`);
      listen(candidate + 1, attempt + 1);
      return;
    }
    throw error;
  });
  server.listen(candidate, "127.0.0.1", () => {
    console.log(`Spliceframe offline: http://127.0.0.1:${candidate}`);
  });
}

listen(port);
