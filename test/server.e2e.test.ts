import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StaticServer } from '../src/server/static.ts';
import { WsConnection } from '../src/server/ws-connection.ts';
import { acceptKey } from '../src/shared/ws.ts';
import {
  decodeControl,
  decodeMediaHeader,
  encodeControl,
  encodeMediaFrame,
} from '../src/shared/protocol.ts';
import { RelayRoom } from '../src/server/relay.ts';
import { RoundStore } from '../src/server/round-store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', 'src', 'client');

interface Harness {
  port: number;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const staticServer = new StaticServer(webRoot);
  const store = new RoundStore();
  const rooms = new Map<string, RelayRoom>();
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void staticServer.serve(url.pathname).then((result) => {
      res.writeHead(result.status, result.headers ?? {});
      if (typeof result.body === 'string' || Buffer.isBuffer(result.body)) {
        res.end(result.body);
      } else if (result.body) {
        result.body.pipe(res);
      } else {
        res.end();
      }
    });
  });
  http.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    void acceptKey(key).then((accept) => {
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
        onText: (text) => route(text, connection),
        onBinary: (bytes) => roomFor(connection)?.handleBinary(connection, bytes),
        onClose: () => cleanup(connection),
        onError: () => cleanup(connection),
      });
    });
  });

  const binding = new Map<WsConnection, string>();
  function roomFor(connection: WsConnection): RelayRoom | undefined {
    const roundId = binding.get(connection);
    return roundId ? rooms.get(roundId) : undefined;
  }
  function route(text: string, connection: WsConnection): void {
    const message = decodeControl(text);
    if (message.kind === 'hello' && !binding.has(connection)) {
      let room = rooms.get(message.roundId);
      if (!room) {
        room = new RelayRoom(message.roundId, store);
        rooms.set(message.roundId, room);
      }
      binding.set(connection, message.roundId);
      room.addMember(connection, message.role);
      return;
    }
    roomFor(connection)?.handleControl(connection, text);
  }
  function cleanup(connection: WsConnection): void {
    const room = roomFor(connection);
    room?.removeMember(connection);
  }

  await new Promise<void>((resolve) => http.listen(0, resolve));
  const address = http.address();
  if (!address || typeof address === 'string') {
    throw new Error('测试服务器端口绑定失败');
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

function connect(
  harness: Harness,
  role: 'sender' | 'receiver',
  roundId: string,
): WebSocket {
  const ws = new WebSocket(`ws://localhost:${harness.port}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => {
    ws.send(encodeControl({ kind: 'hello', role, roundId }));
  });
  return ws;
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (event) => resolve(String(event.data)), {
      once: true,
    });
  });
}

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.close();
});

test('静态服务把 TS 擦除为可执行 JS', async () => {
  const response = await fetch(
    `http://localhost:${harness.port}/shared/types.ts`,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /javascript/);
  const code = await response.text();
  assert.ok(!code.includes('interface '));
  assert.ok(code.includes('STAGE_IDS'));
});

test('媒体帧在同轮次房间内中继并回填服务端时间戳', async () => {
  const roundId = 'e2e-round-1';
  const sender = connect(harness, 'sender', roundId);
  const receiver = connect(harness, 'receiver', roundId);
  await Promise.all([nextMessage(sender), nextMessage(receiver)]);

  sender.send(
    encodeControl({
      kind: 'round-open',
      roundId,
      label: '端到端轮次',
      startedAt: Date.now(),
    }),
  );
  await nextMessage(receiver);

  const binary = encodeMediaFrame({
    roundId,
    seq: 1,
    timestampUs: 0,
    durationUs: 20000,
    tSendMs: 12.5,
    tServerRxMs: 0,
    tServerTxMs: 0,
    keyframe: true,
    payload: new Uint8Array([0xde, 0xad]),
  });
  const got = new Promise<ArrayBuffer>((resolve) => {
    receiver.addEventListener(
      'message',
      (event) => {
        if (event.data instanceof ArrayBuffer) {
          resolve(event.data);
        }
      },
      { once: true },
    );
  });
  sender.send(binary);
  const buffer = await got;
  const { frame } = decodeMediaHeader(new Uint8Array(buffer));
  assert.equal(frame.roundId, roundId);
  assert.equal(frame.seq, 1);
  assert.ok(frame.tServerRxMs > 0);
  assert.ok(frame.tServerTxMs >= frame.tServerRxMs);
  assert.deepEqual(frame.payload, new Uint8Array([0xde, 0xad]));

  sender.close();
  receiver.close();
});

test('不同轮次的房间互不串数据', async () => {
  const receiverA = connect(harness, 'receiver', 'room-A');
  const senderB = connect(harness, 'sender', 'room-B');
  await Promise.all([nextMessage(receiverA), nextMessage(senderB)]);

  const leak = new Promise((resolve) => {
    receiverA.addEventListener(
      'message',
      (event) => {
        if (event.data instanceof ArrayBuffer) {
          resolve('leaked');
        }
      },
      { once: true },
    );
  });
  senderB.send(
    encodeMediaFrame({
      roundId: 'room-B',
      seq: 9,
      timestampUs: 0,
      durationUs: 1000,
      tSendMs: 1,
      tServerRxMs: 0,
      tServerTxMs: 0,
      keyframe: false,
      payload: new Uint8Array([1]),
    }),
  );
  const timed = await Promise.race([
    leak,
    new Promise((resolve) => setTimeout(() => resolve('clean'), 200)),
  ]);
  assert.equal(timed, 'clean');
  receiverA.close();
  senderB.close();
});

test('时钟同步往返返回服务端时刻', async () => {
  const roundId = 'clock-round';
  const ws = connect(harness, 'sender', roundId);
  await nextMessage(ws);
  const reply = new Promise<string>((resolve) => {
    ws.addEventListener(
      'message',
      (event) => {
        const message = decodeControl(String(event.data));
        if (message.kind === 'clock-sync-ack') {
          resolve(String(event.data));
        }
      },
      { once: true },
    );
  });
  ws.send(
    encodeControl({
      kind: 'clock-sync',
      roundId,
      id: 1,
      t0: Date.now(),
    }),
  );
  const ack = decodeControl(await reply);
  assert.equal(ack.kind, 'clock-sync-ack');
  if (ack.kind === 'clock-sync-ack') {
    assert.ok(ack.t1 >= ack.t0);
  }
  ws.close();
});
