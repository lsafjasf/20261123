import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync, createReadStream } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = resolve(process.cwd());
const publicDir = join(root, "public");
const projectPath = join(root, "fixtures", "project.json");
const exportDir = join(root, "exports");
const port = Number(process.env.PORT ?? 8080);

const mimeTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

async function serveTypeScript(response: ServerResponse, filePath: string): Promise<void> {
  const source = await readFile(filePath, "utf8");
  const javascript = stripTypeScriptTypes(source, { mode: "strip" });
  response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
  response.end(javascript);
}

function serveStatic(response: ServerResponse, filePath: string): void {
  const stat = statSync(filePath);
  const stream = createReadStream(filePath);
  response.writeHead(200, {
    "content-type": mimeTypes.get(extname(filePath)) ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-cache",
  });
  stream.on("error", () => {
    if (!response.headersSent) {
      sendJson(response, 500, { error: "read failed" });
    }
    response.end();
  });
  stream.pipe(response);
}

async function readBody(request: IncomingMessage, limitBytes = 512 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new Error("request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleExport(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(request)) as {
    manifest: unknown;
    videoBase64: string;
  };
  await mkdir(exportDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "");
  const videoPath = join(exportDir, `documentary-${stamp}.webm`);
  const manifestPath = join(exportDir, `documentary-${stamp}.json`);
  const video = Buffer.from(body.videoBase64, "base64");
  await writeFile(videoPath, video);
  await writeFile(manifestPath, `${JSON.stringify(body.manifest, null, 2)}\n`);
  sendJson(response, 200, {
    videoUrl: `/exports/${videoPath.slice(exportDir.length + 1)}`,
    manifestUrl: `/exports/${manifestPath.slice(exportDir.length + 1)}`,
  });
}

async function resolvePath(urlPath: string): Promise<string | undefined> {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0]));
  if (clean.includes("..")) {
    return undefined;
  }
  const candidates: string[] = [];
  if (clean === "/") {
    candidates.push(join(publicDir, "index.html"));
  } else if (clean.startsWith("/src/")) {
    candidates.push(join(root, clean));
  } else if (clean.startsWith("/fixtures/") || clean.startsWith("/exports/")) {
    candidates.push(join(root, clean));
  } else {
    candidates.push(join(publicDir, clean));
  }
  const filePath = candidates[0];
  return existsSync(filePath) && statSync(filePath).isFile() ? filePath : undefined;
}

const server = createServer(async (request, response) => {
  try {
    const url = request.url ?? "/";
    if (url === "/api/project" && request.method === "GET") {
      const project = await readFile(projectPath, "utf8");
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(project);
      return;
    }
    if (url === "/api/exports" && request.method === "POST") {
      await handleExport(request, response);
      return;
    }
    const filePath = await resolvePath(url);
    if (!filePath) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    if (extname(filePath) === ".ts") {
      await serveTypeScript(response, filePath);
      return;
    }
    serveStatic(response, filePath);
  } catch (error) {
    sendJson(response, 500, { error: (error as Error).message });
  }
});

process.on("uncaughtException", (error) => {
  console.error("uncaughtException", error);
});
process.on("unhandledRejection", (error) => {
  console.error("unhandledRejection", error);
});

server.listen(port, () => {
  console.log(`documentary workbench listening on http://localhost:${port}`);
});
