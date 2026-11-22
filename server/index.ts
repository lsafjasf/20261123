import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLicenseAuthority } from "./licensing.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const publicRoot = join(root, "public");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4317);
const authority = createLicenseAuthority();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
    "media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.byteLength,
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) {
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("INVALID_BODY");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function apiError(error: unknown): { status: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  if (message === "SESSION_EXPIRED") {
    return { status: 401, code: "SESSION_EXPIRED", message: "会话已过期，请重新联机建立许可会话。" };
  }
  if (message === "BODY_TOO_LARGE" || message === "INVALID_JSON" || message === "INVALID_BODY") {
    return { status: 400, code: message, message: "请求格式不正确。" };
  }
  if (message.startsWith("Unknown segment")) {
    return { status: 400, code: "UNKNOWN_SEGMENT", message: "清单中不存在该片段。" };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "本地许可服务发生异常。" };
}

async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/api/")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, mode: "local", now: Date.now() });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/manifest") {
    sendJson(response, 200, { manifest: authority.getManifest(), serverTime: Date.now() });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/session") {
    sendJson(response, 200, authority.createSession());
    return true;
  }

  if (request.method === "POST" && pathname === "/api/licenses") {
    try {
      const body = await readJsonBody(request);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const segmentIds = Array.isArray(body.segmentIds)
        ? body.segmentIds.filter((value): value is string => typeof value === "string")
        : [];
      if (!sessionId || segmentIds.length === 0) {
        throw new Error("INVALID_BODY");
      }
      const licenses = authority.issueLicenses(sessionId, segmentIds);
      sendJson(response, 200, {
        serverTime: Date.now(),
        licenses,
        policy: authority.getManifest().policy,
      });
    } catch (error) {
      const failure = apiError(error);
      sendJson(response, failure.status, { error: failure.code, message: failure.message });
    }
    return true;
  }

  sendJson(response, 404, { error: "NOT_FOUND", message: "接口不存在。" });
  return true;
}

async function handleStatic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "仅支持 GET。" });
    return;
  }

  const decoded = decodeURIComponent(pathname);
  const requestPath = decoded === "/" ? "/index.html" : decoded;
  const normalized = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const target = join(publicRoot, normalized);
  if (!target.startsWith(publicRoot)) {
    sendJson(response, 403, { error: "FORBIDDEN", message: "路径不合法。" });
    return;
  }

  try {
    const file = await stat(target);
    if (!file.isFile()) {
      throw new Error("NOT_A_FILE");
    }
    const extension = extname(target).toLowerCase();
    const contentType = MIME_TYPES[extension];
    if (!contentType) {
      sendJson(response, 404, { error: "NOT_FOUND", message: "资源不存在。" });
      return;
    }
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": contentType,
      "Content-Length": file.size,
      "Cache-Control": "no-cache",
      ...(requestPath === "/js/sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(target).pipe(response);
  } catch {
    sendJson(response, 404, { error: "NOT_FOUND", message: "资源不存在。" });
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (await handleApi(request, response, url.pathname)) {
      return;
    }
    await handleStatic(request, response, url.pathname);
  } catch (error) {
    console.error("[server]", error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "INTERNAL_ERROR", message: "本地服务异常。" });
    } else {
      response.end();
    }
  }
});

server.listen(port, host, () => {
  console.log("");
  console.log("  NIMBUS 离线受控播放原型");
  console.log(`  http://${host}:${port}`);
  console.log("  密钥代次: epoch-01-a → epoch-02-b");
  console.log("  许可窗口: 30s（暂停继续计时）");
  console.log("");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
