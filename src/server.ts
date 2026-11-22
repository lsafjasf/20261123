import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { FlvParser } from "./flv.ts";
import type { ClientMetrics } from "./media.ts";
import { RelayHub, type RelayClient } from "./relay.ts";
import { RtmpSession } from "./rtmp.ts";
import { acceptWebSocket, SocketPeer } from "./ws.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC_ROOT = resolve(ROOT, "public");
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8080);
const RTMP_PORT = Number(process.env.RTMP_PORT ?? 1935);
const HOST = process.env.HOST ?? "0.0.0.0";

class ViewerPeer implements RelayClient {
  readonly id: number;
  readonly remote: string;
  readonly connectedAt = Date.now();
  readonly socket: SocketPeer;

  constructor(id: number, socket: SocketPeer) {
    this.id = id;
    this.remote = socket.remote;
    this.socket = socket;
  }

  push(frame: Buffer, _media: boolean, _keyframe: boolean): void {
    this.socket.sendBinary(frame);
  }

  pushText(text: string): void {
    this.socket.sendText(text);
  }

  close(reason: string): void {
    this.socket.close(reason);
  }

  metrics(now: number): ClientMetrics {
    return {
      ...this.socket.metrics(now),
      id: this.id,
      remote: this.remote,
      connectedAt: this.connectedAt,
    };
  }
}

const hub = new RelayHub({
  gopCacheBytes: Number(process.env.GOP_CACHE_BYTES ?? 24 * 1024 * 1024),
  gopCacheCount: Number(process.env.GOP_CACHE_COUNT ?? 3),
  clientQueueBytes: Number(process.env.CLIENT_QUEUE_BYTES ?? 8 * 1024 * 1024),
});

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

const transformCache = new Map<string, { mtimeMs: number; body: string }>();

async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = resolve(PUBLIC_ROOT, relative);
  if (!file.startsWith(PUBLIC_ROOT + "/")) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Not a file");
    let body: string | Buffer;
    if (file.endsWith(".ts")) {
      const cached = transformCache.get(file);
      if (cached?.mtimeMs === info.mtimeMs) {
        body = cached.body;
      } else {
        const source = await readFile(file, "utf8");
        const transformed = stripTypeScriptTypes(source, {
          mode: "strip",
          sourceUrl: pathname,
        });
        body = transformed;
        transformCache.set(file, { mtimeMs: info.mtimeMs, body: transformed });
      }
    } else {
      body = await readFile(file);
    }
    response.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": file.endsWith(".ts") ? "no-cache" : "public, max-age=30",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

function attachFlvSocket(socket: Socket, protocol: string, prefix: Buffer): void {
  let generation = 0;
  let finished = false;
  const finish = (reason: string): void => {
    if (finished) return;
    finished = true;
    hub.endSource(generation, reason);
  };
  const parser = new FlvParser(
    {
      onVideoConfig: (track) => {
        if (hub.isCurrentSource(generation)) hub.setVideoConfig(track);
      },
      onAudioConfig: (track) => {
        if (hub.isCurrentSource(generation)) hub.setAudioConfig(track);
      },
      onSample: (sample) => {
        if (hub.isCurrentSource(generation)) hub.ingest(sample);
      },
      onError: () => socket.destroy(),
    },
    hub.limits.maxFrameBytes,
  );
  generation = hub.beginSource(protocol, () => socket.destroy());
  socket.on("data", (chunk) => parser.feed(chunk));
  socket.on("error", () => finish("source-error"));
  socket.on("close", () => finish("source-disconnected"));
  if (prefix.length) parser.feed(prefix);
}

function attachRtmpSocket(socket: Socket, prefix: Buffer): void {
  let generation = 0;
  let finished = false;
  const finish = (reason: string): void => {
    if (finished) return;
    finished = true;
    hub.endSource(generation, reason);
  };
  const session = new RtmpSession(socket, {
    onReady: () => {
      if (process.env.DEBUG_RTMP === "1") console.error("[rtmp] handshake complete");
    },
    onVideoConfig: (track) => {
      if (hub.isCurrentSource(generation)) hub.setVideoConfig(track);
    },
    onAudioConfig: (track) => {
      if (hub.isCurrentSource(generation)) hub.setAudioConfig(track);
    },
    onSample: (sample) => {
      if (hub.isCurrentSource(generation)) hub.ingest(sample);
    },
    onError: (error) => {
      console.error(`[rtmp] session error: ${error.message}`);
      socket.destroy();
    },
  });
  generation = hub.beginSource("rtmp", () => socket.destroy());
  socket.on("data", (chunk) => session.feed(chunk));
  socket.on("error", () => finish("source-error"));
  socket.on("close", () => {
    session.close();
    finish("source-disconnected");
  });
  if (prefix.length) session.feed(prefix);
}

function acceptTcpSource(socket: Socket): void {
  socket.setNoDelay(true);
  socket.setTimeout(30000, () => socket.destroy());
  let prefix = Buffer.alloc(0);
  let resolved = false;
  const detect = (chunk: Buffer): void => {
    if (resolved) return;
    prefix = Buffer.concat([prefix, chunk]);
    if (prefix.length === 0) return;
    if (prefix[0] === 0x03) {
      resolved = true;
      socket.off("data", detect);
      attachRtmpSocket(socket, prefix);
      return;
    }
    if (prefix.length < 3) return;
    if (prefix.subarray(0, 3).toString("ascii") === "FLV") {
      resolved = true;
      socket.off("data", detect);
      attachFlvSocket(socket, "flv-tcp", prefix);
      return;
    }
    socket.destroy();
  };
  socket.on("data", detect);
  socket.on("error", () => socket.destroy());
}

function attachViewerWebSocket(request: IncomingMessage, socket: Socket, head: Buffer): void {
  if (!acceptWebSocket(request, socket, head)) return;
  let peer: ViewerPeer;
  const transport = new SocketPeer({
    socket,
    remote: `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`,
    maxQueueBytes: hub.limits.clientQueueBytes,
    onBinary: () => undefined,
    onClose: () => hub.detachClient(peer.id),
    onSlow: () => hub.noteSlowEvent(),
    onText: (text) => {
      try {
        const message = JSON.parse(text) as { type?: string; queueMs?: number };
        if (message.type === "stats") {
          transport.noteAck(Number(message.queueMs ?? 0));
        } else if (message.type === "request-keyframe") {
          hub.replay(peer);
        }
      } catch {
        peer.close("bad-json");
      }
    },
  });
  peer = new ViewerPeer(hub.nextId(), transport);
  hub.attachClient(peer);
}

function attachSourceWebSocket(request: IncomingMessage, socket: Socket, head: Buffer): void {
  if (!acceptWebSocket(request, socket, head)) return;
  let generation = 0;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    hub.endSource(generation, "source-disconnected");
  };
  const parser = new FlvParser(
    {
      onVideoConfig: (track) => {
        if (hub.isCurrentSource(generation)) hub.setVideoConfig(track);
      },
      onAudioConfig: (track) => {
        if (hub.isCurrentSource(generation)) hub.setAudioConfig(track);
      },
      onSample: (sample) => {
        if (hub.isCurrentSource(generation)) hub.ingest(sample);
      },
      onError: () => socket.destroy(),
    },
    hub.limits.maxFrameBytes,
  );
  const transport = new SocketPeer({
    socket,
    remote: `source:${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`,
    maxQueueBytes: 1024 * 1024,
    onText: () => undefined,
    onBinary: (data) => {
      if (hub.isCurrentSource(generation)) parser.feed(data);
    },
    onClose: finish,
    onSlow: () => undefined,
  });
  generation = hub.beginSource("flv-ws", () => transport.close("source-timeout"));
}

const httpServer = createHttpServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://relay.local");
  if (url.pathname === "/api/status") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(hub.stats(), null, 2));
    return;
  }
  if (url.pathname === "/api/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, source: hub.getSource().state }));
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end("Method not allowed");
    return;
  }
  await serveStatic(response, url.pathname);
});

httpServer.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", "http://relay.local").pathname;
  if (pathname === "/ws") attachViewerWebSocket(request, socket, head);
  else if (pathname === "/source") attachSourceWebSocket(request, socket, head);
  else socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
});

const sourceServer = createNetServer((socket) => acceptTcpSource(socket));

const tickTimer = setInterval(() => hub.tick(), 500);
tickTimer.unref();

httpServer.listen(HTTP_PORT, HOST, () => {
  console.log(`[relay] console  http://localhost:${HTTP_PORT}`);
  console.log(`[relay] viewer   ws://localhost:${HTTP_PORT}/ws`);
  console.log(`[relay] FLV/TCP  tcp://${HOST}:${RTMP_PORT} (auto-detect FLV or RTMP)`);
});

sourceServer.listen(RTMP_PORT, HOST, () => {
  console.log(`[relay] ingest   tcp://${HOST}:${RTMP_PORT}`);
});

function shutdown(): void {
  clearInterval(tickTimer);
  httpServer.close();
  sourceServer.close();
  setTimeout(() => process.exit(0), 250).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
