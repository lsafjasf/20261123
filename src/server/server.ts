/**
 * 全本地测量服务器：
 * - 静态资源 + TypeScript 即时擦除；
 * - /ws 上的轮次房间 WebSocket 中继；
 * - /api/rounds 轮次列表与 /api/rounds/:id/report 报告接口。
 * 仅使用 node: 标准库。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { StaticServer } from './static.ts';
import { WsConnection } from './ws-connection.ts';
import { acceptKey } from '../shared/ws.ts';
import { decodeControl, encodeControl } from '../shared/protocol.ts';
import { RelayRoom } from './relay.ts';
import { RoundStore } from './round-store.ts';
import { buildRoundReport } from '../shared/analytics.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', 'client');
const port = Number(process.env.PORT ?? 8080);

const staticServer = new StaticServer(webRoot);
const store = new RoundStore();
const rooms = new Map<string, RelayRoom>();

const httpServer = createServer((req, res) => {
  void handleHttp(req, res);
});

httpServer.on('upgrade', (req, socket) => {
  void handleUpgrade(req, socket);
});

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(url, res);
    return;
  }
  const result = await staticServer.serve(url.pathname);
  res.writeHead(result.status, result.headers ?? {});
  if (result.body === undefined) {
    res.end();
  } else if (typeof result.body === 'string' || Buffer.isBuffer(result.body)) {
    res.end(result.body);
  } else {
    result.body.pipe(res);
  }
}

function handleApi(url: URL, res: ServerResponse): void {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[1] === 'rounds') {
    json(res, 200, store.list());
    return;
  }
  if (parts.length === 4 && parts[1] === 'rounds' && parts[3] === 'report') {
    const snapshot = store.snapshot(parts[2]);
    if (!snapshot) {
      json(res, 404, { error: '轮次不存在' });
      return;
    }
    const report = buildRoundReport({
      roundId: snapshot.meta.roundId,
      label: snapshot.meta.label,
      startedAt: snapshot.meta.startedAt,
      closedAt: snapshot.meta.closedAt,
      markers: snapshot.markers,
      drops: snapshot.drops,
      clockOffsetMs: snapshot.clockOffsetMs,
      clockRttMs: snapshot.clockRttMs,
    });
    json(res, 200, report);
    return;
  }
  json(res, 404, { error: '未知 API' });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handleUpgrade(
  req: IncomingMessage,
  socket: import('node:net').Socket,
): Promise<void> {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const accept = await acceptKey(key);
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  );

  const connection = new WsConnection(socket, {
    onText: (text) => onHelloOrMessage(text, connection),
    onBinary: (bytes) => currentRoom(connection)?.handleBinary(connection, bytes),
    onClose: () => leaveRoom(connection),
    onError: () => leaveRoom(connection),
  });
}

const memberRooms = new WeakMap<WsConnection, RelayRoom>();

function currentRoom(connection: WsConnection): RelayRoom | undefined {
  const room = memberRooms.get(connection);
  return room;
}

function onHelloOrMessage(text: string, connection: WsConnection): void {
  let message;
  try {
    message = decodeControl(text);
  } catch {
    connection.sendText(
      encodeControl({ kind: 'error', message: '控制消息解析失败' }),
    );
    return;
  }
  if (message.kind !== 'hello' || !currentRoom(connection)) {
    if (message.kind === 'hello') {
      joinRoom(connection, message.roundId, message.role);
      return;
    }
  }
  currentRoom(connection)?.handleControl(connection, text);
}

function joinRoom(
  connection: WsConnection,
  roundId: string,
  role: 'sender' | 'receiver',
): void {
  let room = rooms.get(roundId);
  if (!room) {
    room = new RelayRoom(roundId, store);
    rooms.set(roundId, room);
  }
  memberRooms.set(connection, room);
  room.addMember(connection, role);
}

function leaveRoom(connection: WsConnection): void {
  const room = memberRooms.get(connection);
  if (room) {
    room.removeMember(connection);
    if (room.isEmpty) {
      rooms.delete(room.roundId);
    }
  }
}

export function newRoundId(): string {
  return crypto.randomUUID();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  httpServer.listen(port, () => {
    console.log(`测量服务器已启动: http://localhost:${port}`);
  });
}
