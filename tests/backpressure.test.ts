import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Socket } from "node:net";
import { SocketPeer } from "../src/ws.ts";
import { encodeMediaFrame, WireFlags, WireKind } from "../src/wire.ts";

class FakeSocket extends EventEmitter {
  writableNeedDrain = true;
  writableLength = 0;
  destroyed = false;
  readonly writes: Buffer[] = [];

  setNoDelay(): void {}

  write(data: Uint8Array): boolean {
    this.writes.push(Buffer.from(data));
    return true;
  }

  end(): void {}

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

function mediaFrame(bytes: number, keyframe: boolean): Buffer {
  return encodeMediaFrame(
    WireKind.VideoSample,
    { ptsMs: 1000, durationMs: 33.3 },
    Buffer.alloc(bytes, 1),
    keyframe ? WireFlags.Keyframe : 0,
    1,
  );
}

test("slow client queue drops media and waits for a keyframe", () => {
  const socket = new FakeSocket();
  let slowEvents = 0;
  const peer = new SocketPeer({
    socket: socket as unknown as Socket,
    remote: "test",
    maxQueueBytes: 1000,
    onText: () => undefined,
    onBinary: () => undefined,
    onClose: () => undefined,
    onSlow: () => slowEvents++,
  });
  const config = encodeMediaFrame(
    WireKind.VideoConfig,
    { ptsMs: 0, durationMs: 0 },
    Buffer.alloc(64, 2),
    WireFlags.Replay,
    0,
  );
  peer.sendBinary(config);
  peer.sendBinary(mediaFrame(600, true));
  peer.sendBinary(mediaFrame(600, false));
  const overflow = peer.metrics(Date.now());
  assert.equal(overflow.state, "slow");
  assert.equal(overflow.droppedBytes > 0, true);
  assert.equal(slowEvents, 1);
  peer.sendBinary(mediaFrame(600, true));
  socket.writableNeedDrain = false;
  socket.emit("drain");
  const drained = peer.metrics(Date.now());
  assert.equal(drained.state, "live");
  assert.equal(socket.writes.length > 0, true);
  peer.close("test-done");
});
