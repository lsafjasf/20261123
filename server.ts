import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isMediaFile,
  isProjectFile,
  mediaMimeType,
  resolveExistingPath,
  resolveUserPath,
  scanMediaRoot,
  sha256File
} from "./src/server/media-library.ts";

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(root, "public");
const exportRoot = join(root, "exports");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4173);
const maxJsonBytes = 4 * 1024 * 1024;

const demoProject = process.env.RELINK_PROJECT ?? "sample/project.fcpxml";
const demoNewRoot = process.env.RELINK_NEW_ROOT ?? "sample/new-drive";
const demoOldRoot = process.env.RELINK_OLD_ROOT ?? "sample/old-drive";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxJsonBytes) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("请求体不是有效 JSON");
  }
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少字段 ${name}`);
  return value;
}

function safeStaticPath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = decoded === "/" ? "/index.html" : decoded;
  const target = resolve(publicRoot, `.${normalized}`);
  return target.startsWith(`${publicRoot}${sep}`) || target === publicRoot ? target : null;
}

async function serveStatic(response: ServerResponse, urlPath: string): Promise<boolean> {
  const target = safeStaticPath(urlPath);
  if (!target) return false;
  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(target).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": target.endsWith(".html") ? "no-store" : "public, max-age=60"
    });
    createReadStream(target).pipe(response);
    return true;
  } catch {
    return false;
  }
}

async function handleReadProject(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request);
  const projectPath = await resolveExistingPath(stringField(body, "path"));
  if (!isProjectFile(projectPath)) throw new Error("仅支持 .fcpxml / .xml / .json / .edl 工程文件");
  const info = await stat(projectPath);
  if (!info.isFile()) throw new Error("工程路径不是文件");
  if (info.size > 64 * 1024 * 1024) throw new Error("工程文件超过 64 MB");
  const text = await readFile(projectPath, "utf8");
  sendJson(response, 200, {
    path: projectPath,
    name: basename(projectPath),
    text,
    sha256: await sha256File(projectPath),
    size: info.size
  });
}

async function handleScan(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request);
  const result = await scanMediaRoot(stringField(body, "root"));
  sendJson(response, 200, result);
}

async function handleHash(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request);
  const filePath = await resolveExistingPath(stringField(body, "path"));
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("哈希目标不是文件");
  sendJson(response, 200, { path: filePath, sha256: await sha256File(filePath), size: info.size });
}

async function handleMedia(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const filePath = await resolveExistingPath(url.searchParams.get("path") ?? "");
  if (!isMediaFile(filePath)) throw new Error("不是允许的媒体文件");
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("媒体路径不是文件");
  const headers = {
    "Content-Type": mediaMimeType(filePath),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=30"
  };
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { ...headers, "Content-Length": info.size });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
    response.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
  if (!Number.isFinite(start) || start > end || start >= info.size) {
    response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    ...headers,
    "Content-Range": `bytes ${start}-${end}/${info.size}`,
    "Content-Length": end - start + 1
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath, { start, end }).pipe(response);
}

function checkOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).host !== request.headers.host) throw new Error("跨站请求被拒绝");
  } catch {
    throw new Error("无效请求来源");
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function handleConfig(response: ServerResponse): Promise<void> {
  sendJson(response, 200, {
    cwd: root,
    platform: process.platform,
    demo: {
      available: await exists(resolve(root, demoProject)),
      projectPath: demoProject,
      newRoot: demoNewRoot,
      oldRoot: demoOldRoot
    },
    runtime: {
      node: process.version,
      mediaAnalysis: "server-probe + browser WebCodecs/WebAudio",
      network: "loopback-only"
    }
  });
}

function posixPath(value: string): string {
  return value.split(sep).join("/");
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: unknown[][]): string {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function sanitizeExportName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}

async function handleExport(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request);
  const projectPath = await resolveExistingPath(stringField(body, "projectPath"));
  const mediaRoot = await resolveExistingPath(stringField(body, "mediaRoot"));
  if (!isProjectFile(projectPath)) throw new Error("导出工程路径无效");
  const mediaRootInfo = await stat(mediaRoot);
  if (!mediaRootInfo.isDirectory()) throw new Error("新素材根目录不是文件夹");
  const expectedProjectHash = typeof body.projectSha256 === "string" ? body.projectSha256 : "";
  const projectName = basename(projectPath);
  const projectDir = dirname(projectPath);
  const rawMappings = Array.isArray(body.mappings) ? body.mappings : [];
  const rawMissing = Array.isArray(body.missing) ? body.missing : [];
  const rawUnresolved = Array.isArray(body.unresolved) ? body.unresolved : [];
  if (rawMappings.length > 25_000 || rawMissing.length > 25_000 || rawUnresolved.length > 25_000) {
    throw new Error("导出条目过多");
  }
  const actualProjectHash = await sha256File(projectPath);
  const mappings = [];

  for (const raw of rawMappings) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.targetPath !== "string") throw new Error("映射缺少 targetPath");
    const targetPath = await resolveExistingPath(item.targetPath);
    if (!isMediaFile(targetPath)) throw new Error(`映射目标不是媒体文件: ${targetPath}`);
    const mediaRelative = relative(mediaRoot, targetPath);
    if (mediaRelative.startsWith(`..${sep}`) || mediaRelative === ".." || resolve(mediaRoot, mediaRelative) !== targetPath) {
      throw new Error(`映射目标不在新素材根目录内: ${targetPath}`);
    }
    const targetInfo = await stat(targetPath);
    mappings.push({
      assetId: String(item.assetId ?? ""),
      filename: String(item.filename ?? basename(targetPath)),
      sourcePath: String(item.sourcePath ?? ""),
      target: {
        mediaRootRelative: posixPath(relative(mediaRoot, targetPath)),
        projectRelative: posixPath(relative(projectDir, targetPath)),
        template: `\${MEDIA_ROOT}/${posixPath(relative(mediaRoot, targetPath))}`
      },
      targetSize: targetInfo.size,
      targetSha256: await sha256File(targetPath),
      confidence: Number(item.confidence ?? 0),
      decision: String(item.decision ?? "auto"),
      confirmedByUser: Boolean(item.confirmedByUser),
      evidence: item.evidence && typeof item.evidence === "object" ? item.evidence : {},
      timelineRefs: Array.isArray(item.timelineRefs) ? item.timelineRefs.slice(0, 500) : []
    });
  }

  const missing = rawMissing.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    return {
      assetId: String(item.assetId ?? ""),
      filename: String(item.filename ?? ""),
      sourcePath: String(item.sourcePath ?? ""),
      duration: typeof item.duration === "number" ? item.duration : null,
      reason: String(item.reason ?? "新盘未找到同名候选")
    };
  });
  const unresolved = rawUnresolved.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    return {
      assetId: String(item.assetId ?? ""),
      filename: String(item.filename ?? ""),
      sourcePath: String(item.sourcePath ?? ""),
      reason: String(item.reason ?? "存在多个近似候选"),
      candidates: Array.isArray(item.candidates) ? item.candidates.slice(0, 20) : []
    };
  });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const exportId = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  const exportDir = join(exportRoot, `relink-${exportId}`);
  const mediaRootRelativeToProject = posixPath(relative(projectDir, mediaRoot));
  await mkdir(exportDir, { recursive: true });
  const report = {
    schema: "relink-map/v1",
    generatedAt: new Date().toISOString(),
    portability: {
      pathBase: "project-directory",
      mediaRootToken: "${MEDIA_ROOT}",
      note: "projectRelative 是相对工程目录的 POSIX 路径；mediaRootRelative 是相对新素材根的路径；template 可直接替换根目录。"
    },
    project: {
      name: projectName,
      path: projectPath,
      sha256: actualProjectHash,
      expectedSha256: expectedProjectHash,
      timelineUntouched: true,
      projectUnchanged: !expectedProjectHash || actualProjectHash === expectedProjectHash
    },
    mediaRoot: {
      name: basename(mediaRoot),
      path: mediaRoot,
      relativeToProject: mediaRootRelativeToProject
    },
    mappings,
    missing,
    unresolved
  };

  const mappingName = "relink-map.json";
  const missingName = "missing-files.csv";
  const unresolvedName = "unresolved.csv";
  const summaryName = "summary.md";
  await writeFile(join(exportDir, mappingName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(exportDir, missingName), toCsv([
    ["asset_id", "filename", "source_path", "duration_seconds", "reason"],
    ...missing.map((item) => [item.assetId, item.filename, item.sourcePath, item.duration, item.reason])
  ]), "utf8");
  await writeFile(join(exportDir, unresolvedName), toCsv([
    ["asset_id", "filename", "source_path", "reason"],
    ...unresolved.map((item) => [item.assetId, item.filename, item.sourcePath, item.reason])
  ]), "utf8");
  await writeFile(join(exportDir, summaryName), [
    `# ${projectName} 重连报告`,
    "",
    `- 已映射：${mappings.length}`,
    `- 仍缺文件：${missing.length}`,
    `- 待确认：${unresolved.length}`,
    `- 工程时间线写入：否`,
    `- 工程哈希未变化：${report.project.projectUnchanged ? "是" : "否"}`,
    "",
    "映射路径以工程目录为基准；未确认项不会写入 mappings。",
    ""
  ].join("\n"), "utf8");

  sendJson(response, 200, {
    ok: true,
    exportId: `relink-${exportId}`,
    directory: exportDir,
    projectUnchanged: report.project.projectUnchanged,
    counts: { mapped: mappings.length, missing: missing.length, unresolved: unresolved.length },
    files: [
      { label: "相对路径映射", name: mappingName, url: `/exports/relink-${exportId}/${mappingName}` },
      { label: "缺失文件", name: missingName, url: `/exports/relink-${exportId}/${missingName}` },
      { label: "待确认", name: unresolvedName, url: `/exports/relink-${exportId}/${unresolvedName}` },
      { label: "报告摘要", name: summaryName, url: `/exports/relink-${exportId}/${summaryName}` }
    ]
  });
}

async function serveExport(response: ServerResponse, urlPath: string): Promise<boolean> {
  const target = resolve(exportRoot, `.${decodeURIComponent(urlPath.slice("/exports".length))}`);
  if (!target.startsWith(`${exportRoot}${sep}`)) return false;
  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(target)] ?? (target.endsWith(".csv") ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8"),
      "Content-Length": info.size,
      "Content-Disposition": `attachment; filename="${sanitizeExportName(basename(target))}"`,
      "Cache-Control": "no-store"
    });
    createReadStream(target).pipe(response);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    if (method === "POST") checkOrigin(request);
    if (url.pathname === "/api/config") return await handleConfig(response);
    if (url.pathname === "/api/read-project" && method === "POST") return await handleReadProject(request, response);
    if (url.pathname === "/api/scan" && method === "POST") return await handleScan(request, response);
    if (url.pathname === "/api/hash" && method === "POST") return await handleHash(request, response);
    if (url.pathname === "/api/export" && method === "POST") return await handleExport(request, response);
    if (url.pathname === "/api/media" && (method === "GET" || method === "HEAD")) {
      return await handleMedia(request, response, url);
    }
    if (url.pathname.startsWith("/exports/") && method === "GET" && await serveExport(response, url.pathname)) return;
    if ((method === "GET" || method === "HEAD") && await serveStatic(response, url.pathname)) return;
    sendError(response, 404, "未找到资源");
  } catch (error) {
    const status = /拒绝|无效|缺少|不是|仅支持|超过|过大/.test(String(error)) ? 400 : 500;
    if (!response.headersSent) sendError(response, status, error instanceof Error ? error.message : "服务器错误");
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(`Relink Desk running at http://${host}:${port}`);
});
