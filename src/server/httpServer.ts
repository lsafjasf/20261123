import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import type {
  ClaimRequest,
  FinishReport,
  ProgressReport,
  SseEvent,
  TaskSpec,
} from "../shared/protocol.ts";
import type { Scheduler } from "./scheduler.ts";
import { ensureDir } from "./util/atomic.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..");
const publicDir = join(projectRoot, "src", "browser");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createHttpServer(scheduler: Scheduler) {
  const sseClients = new Set<ServerResponse>();

  const broadcast = (event: SseEvent) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of sseClients) {
      response.write(payload);
    }
  };

  scheduler.events.on("task", () => {
    for (const task of scheduler.listTasks()) {
      broadcast({ type: "task-upsert", task });
    }
  });
  scheduler.events.on("metrics", () => {
    const metrics = scheduler.monitor.latest();
    if (metrics) broadcast({ type: "metrics", metrics });
  });
  scheduler.events.on("decision", () => {
    const decision = scheduler.decisions().at(-1);
    if (decision) broadcast({ type: "decision", decision });
  });

  const server = createServer(async (request, response) => {
    try {
      await route(request, response, scheduler, sseClients);
    } catch (err) {
      sendJson(response, 500, { ok: false, error: (err as Error).message });
    }
  });

  return { server, broadcast };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  scheduler: Scheduler,
  sseClients: Set<ServerResponse>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (path === "/api/events" && method === "GET") {
    return await handleSse(request, response, scheduler, sseClients);
  }
  if (path === "/api/tasks" && method === "POST") {
    const body = (await readBody(request)) as Omit<TaskSpec, "id" | "createdAt">;
    return sendJson(response, 200, scheduler.submit(body));
  }
  if (path === "/api/tasks" && method === "GET") {
    return sendJson(response, 200, { ok: true, tasks: scheduler.listTasks() });
  }
  if (path === "/api/reset" && method === "POST") {
    await scheduler.resetAll();
    return sendJson(response, 200, { ok: true });
  }
  if (path === "/api/metrics" && method === "GET") {
    return sendJson(response, 200, { ok: true, metrics: scheduler.metricsHistory(), quota: scheduler.quota });
  }
  if (path === "/api/outputs" && method === "GET") {
    const { readdir } = await import("node:fs/promises");
    const outputsRoot = join(projectRoot, "data", "outputs");
    let names: string[] = [];
    try {
      names = (await readdir(outputsRoot)).filter((name) => !name.startsWith("."));
    } catch {
      names = [];
    }
    return sendJson(response, 200, { ok: true, outputs: names });
  }
  if (path === "/api/file" || path.startsWith("/api/file/")) {
    const name = url.searchParams.get("name") ?? decodeURIComponent(path.slice("/api/file/".length));
    const outputsRoot = join(projectRoot, "data", "outputs");
    const target = join(outputsRoot, name);
    if (!target.startsWith(outputsRoot) || name.includes("..")) {
      return sendJson(response, 400, { ok: false, error: "非法路径" });
    }
    const { createReadStream } = await import("node:fs");
    const { stat } = await import("node:fs/promises");
    try {
      const info = await stat(target);
      response.writeHead(200, {
        "Content-Type": name.endsWith(".webm") ? "video/webm" : "application/octet-stream",
        "Content-Length": info.size,
      });
      createReadStream(target).pipe(response);
      return;
    } catch {
      return sendJson(response, 404, { ok: false, error: "文件不存在" });
    }
  }

  const control = /^\/api\/tasks\/([\w-]+)\/(pause|resume|cancel)$/.exec(path);
  if (control && method === "POST") {
    const [, taskId, action] = control;
    const result =
      action === "pause"
        ? scheduler.pause(taskId!)
        : action === "resume"
          ? scheduler.resume(taskId!)
          : scheduler.cancel(taskId!);
    return sendJson(response, 200, result);
  }

  // 浏览器 WebCodecs Worker 的租约接口
  if (path === "/api/claim" && method === "POST") {
    const body = (await readBody(request)) as ClaimRequest;
    const task = scheduler.claimForBrowser(body.workerId);
    return sendJson(response, 200, { ok: true, task });
  }
  if (path === "/api/progress" && method === "POST") {
    const body = (await readBody(request)) as ProgressReport;
    const ok = scheduler.browser.reportProgress(
      body.taskId,
      body.workerId,
      body.checkpoint,
      body.progress,
      body.residentMB,
    );
    const task = scheduler.getTask(body.taskId);
    const signal = scheduler.browser.pollSignal(body.taskId);
    return sendJson(response, 200, {
      ok,
      state: task?.state ?? null,
      signal,
    });
  }
  if (path === "/api/finish" && method === "POST") {
    const body = (await readBody(request)) as FinishReport;
    const ok = scheduler.browser.finishTask(body.taskId, body.workerId, body.checkpoint);
    if (ok) scheduler.notifySuccess(body.taskId, body.checkpoint);
    return sendJson(response, 200, { ok });
  }
  if (path === "/api/paused" && method === "POST") {
    const body = (await readBody(request)) as FinishReport;
    scheduler.notifyPaused(body.taskId, body.checkpoint);
    return sendJson(response, 200, { ok: true });
  }
  if (path === "/api/fail" && method === "POST") {
    const body = (await readBody(request)) as FinishReport;
    const ok = scheduler.browser.failTask(body.taskId, body.workerId, body.error ?? "浏览器执行失败");
    if (ok) scheduler.notifyFailure(body.taskId, body.error ?? "浏览器执行失败");
    return sendJson(response, 200, { ok });
  }
  if (path === "/api/worker/leave" && method === "POST") {
    const body = (await readBody(request)) as ClaimRequest;
    scheduler.browser.unregisterWorker(body.workerId);
    return sendJson(response, 200, { ok: true });
  }

  const segmentMatch = /^\/api\/segments\/([\w-]+)\/([\w.-]+)$/.exec(path);
  if (segmentMatch && method === "POST") {
    const [, taskId, name] = segmentMatch;
    const task = scheduler.getTask(taskId!);
    if (!task) return sendJson(response, 404, { ok: false, error: "任务不存在" });
    if (name!.includes("/") || name!.includes("..")) {
      return sendJson(response, 400, { ok: false, error: "非法分段名" });
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const { writeFile } = await import("node:fs/promises");
    const target = join(projectRoot, "data", "staging", taskId!, name!);
    const stagingRoot = join(projectRoot, "data", "staging");
    if (!target.startsWith(stagingRoot)) return sendJson(response, 400, { ok: false, error: "路径越界" });
    await ensureDir(join(projectRoot, "data", "staging", taskId!));
    await writeFile(target, Buffer.concat(chunks));
    return sendJson(response, 200, { ok: true, bytes: Buffer.concat(chunks).length });
  }

  if (method === "GET") return serveStatic(path, response);
  sendJson(response, 404, { ok: false, error: "not found" });
}

async function handleSse(
  request: IncomingMessage,
  response: ServerResponse,
  scheduler: Scheduler,
  sseClients: Set<ServerResponse>,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  response.write(`retry: 2000\n\n`);
  const snapshot: SseEvent = {
    type: "snapshot",
    tasks: scheduler.listTasks(),
    metrics: scheduler.monitor.latest() ?? (await scheduler.monitor.sample()),
    quota: scheduler.quota,
    decisions: scheduler.decisions(),
  };
  response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  sseClients.add(response);
  request.on("close", () => sseClients.delete(response));
}

async function serveStatic(path: string, response: ServerResponse): Promise<void> {
  const safePath = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath === "/" ? "index.html" : safePath);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  const extension = extname(filePath);
  let content = await readFile(filePath, "utf8");
  if (extension === ".ts") {
    content = stripTypeScriptTypes(content, { mode: "transform" });
  }
  response.writeHead(200, { "Content-Type": MIME[extension] ?? "application/octet-stream" });
  response.end(content);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
