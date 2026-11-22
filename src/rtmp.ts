import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { decodeAmf0All, encodeAmf0, type AmfValue } from "./amf0.ts";
import { parseAudioTag, parseVideoTag } from "./flv.ts";
import type { FlvCallbacks } from "./flv.ts";

interface ChunkState {
  timestamp: number;
  delta: number;
  length: number;
  type: number;
  streamId: number;
  parts: Buffer[];
  received: number;
  extended: boolean;
}

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_SIZE = 1024 * 1024;

export interface RtmpSessionOptions {
  onReady?: () => void;
  onError: (error: Error) => void;
}

export class RtmpSession {
  private buffer = Buffer.alloc(0);
  private handshake: "c0c1" | "c2" | "chunks" = "c0c1";
  private chunkSize = 128;
  private chunks = new Map<number, ChunkState>();
  private readonly media: Pick<FlvCallbacks, "onVideoConfig" | "onAudioConfig" | "onSample">;
  private closed = false;
  private readonly socket: Socket;
  private readonly options: RtmpSessionOptions;
  private receivedBytes = 0;
  private acknowledgedBytes = 0;
  private peerWindowSize = 2500000;

  constructor(socket: Socket, callbacks: RtmpSessionOptions & Pick<FlvCallbacks, "onVideoConfig" | "onAudioConfig" | "onSample">) {
    this.socket = socket;
    this.media = callbacks;
    this.options = callbacks;
  }

  feed(chunk: Uint8Array): void {
    if (this.closed) return;
    this.receivedBytes += chunk.byteLength;
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, Buffer.from(chunk)])
      : Buffer.from(chunk);
    try {
      if (this.handshake === "c0c1") this.readC0C1();
      if (this.handshake === "c2") this.readC2();
      if (this.handshake === "chunks") this.readChunks();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(): void {
    this.closed = true;
    this.chunks.clear();
  }

  private readC0C1(): void {
    if (this.buffer.length < 1537) return;
    if (this.buffer[0] !== 3) throw new Error("Unsupported RTMP version");
    const c1 = this.buffer.subarray(1, 1537);
    const s1 = Buffer.allocUnsafe(1536);
    randomBytes(1528).copy(s1, 8);
    s1.writeUInt32BE(0, 0);
    s1.writeUInt32BE(0, 4);
    const response = Buffer.concat([Buffer.from([3]), s1, c1]);
    this.socket.write(response);
    this.buffer = this.buffer.subarray(1537);
    this.handshake = "c2";
  }

  private readC2(): void {
    if (this.buffer.length < 1536) return;
    this.buffer = this.buffer.subarray(1536);
    this.handshake = "chunks";
    this.options.onReady?.();
  }

  private readChunks(): void {
    while (this.buffer.length > 0) {
      const parsed = this.readOneChunk();
      if (!parsed) return;
    }
  }

  private readOneChunk(): boolean {
    const startLength = this.buffer.length;
    let offset = 0;
    if (startLength < 1) return false;
    const first = this.buffer[offset++];
    const fmt = first >> 6;
    let csid = first & 0x3f;
    if (csid === 0) {
      if (this.buffer.length < offset + 1) return false;
      csid = 64 + this.buffer[offset++];
    } else if (csid === 1) {
      if (this.buffer.length < offset + 2) return false;
      csid = 64 + this.buffer[offset] + this.buffer[offset + 1] * 256;
      offset += 2;
    }
    const existing = this.chunks.get(csid);
    const state: ChunkState = existing
      ? { ...existing, parts: existing.parts }
      : {
          timestamp: 0,
          delta: 0,
          length: 0,
          type: 0,
          streamId: 0,
          parts: [],
          received: 0,
          extended: false,
        };
    const continuation = state.received > 0;
    let headerLength = 0;
    if (fmt === 0) headerLength = 11;
    else if (fmt === 1) headerLength = 7;
    else if (fmt === 2) headerLength = 3;
    if (this.buffer.length < offset + headerLength) return false;

    if (!continuation) {
      if (fmt === 0) {
        state.timestamp = this.buffer.readUIntBE(offset, 3);
        state.length = this.buffer.readUIntBE(offset + 3, 3);
        state.type = this.buffer[offset + 6];
        state.streamId = this.buffer.readUInt32LE(offset + 7);
      } else if (fmt === 1) {
        state.delta = this.buffer.readUIntBE(offset, 3);
        state.length = this.buffer.readUIntBE(offset + 3, 3);
        state.type = this.buffer[offset + 6];
        state.timestamp = (state.timestamp + state.delta) >>> 0;
      } else if (fmt === 2) {
        state.delta = this.buffer.readUIntBE(offset, 3);
        state.timestamp = (state.timestamp + state.delta) >>> 0;
      } else {
        state.timestamp = (state.timestamp + state.delta) >>> 0;
      }
      state.parts = [];
      state.received = 0;
    }
    offset += headerLength;

    const rawTimestamp =
      fmt === 0
        ? state.timestamp
        : fmt === 1 || fmt === 2
          ? state.delta
          : state.delta;
    const hadExtended = state.extended;
    state.extended = rawTimestamp === 0xffffff || (fmt === 3 && hadExtended);
    if (state.extended) {
      if (this.buffer.length < offset + 4) return false;
      const extended = this.buffer.readUInt32BE(offset);
      offset += 4;
      if (!continuation) {
        if (fmt === 0) state.timestamp = extended;
        else state.timestamp = (state.timestamp - (fmt === 3 ? 0 : state.delta) + extended) >>> 0;
      }
    }
    if (state.length > MAX_MESSAGE_BYTES) throw new Error("RTMP message is too large");

    const remaining = state.length - state.received;
    const payloadLength = Math.min(this.chunkSize, remaining);
    if (this.buffer.length < offset + payloadLength) return false;
    if (payloadLength > 0) {
      state.parts.push(this.buffer.subarray(offset, offset + payloadLength));
      state.received += payloadLength;
    }
    offset += payloadLength;
    this.buffer = this.buffer.subarray(offset);

    if (state.received >= state.length) {
      const payload = Buffer.concat(state.parts);
      state.parts = [];
      state.received = 0;
      this.chunks.set(csid, state);
      this.handleMessage(state.type, payload, state.timestamp, state.streamId);
      this.maybeAcknowledge();
    } else {
      this.chunks.set(csid, state);
    }
    return true;
  }

  private handleMessage(type: number, payload: Buffer, timestamp: number, streamId: number): void {
    if (type === 1) {
      if (payload.length >= 4) {
        const size = payload.readUInt32BE(0) & 0x7fffffff;
        if (size < 1 || size > MAX_CHUNK_SIZE) throw new Error("Invalid RTMP chunk size");
        this.chunkSize = size;
      }
      return;
    }
    if (type === 20 || type === 18) {
      if (process.env.DEBUG_RTMP === "1") {
        try {
          console.error("[rtmp] command", streamId, decodeAmf0All(payload).slice(0, 3));
        } catch {
          console.error("[rtmp] command decode failed");
        }
      }
      this.handleCommand(payload, streamId);
      return;
    }
    if (type === 5) {
      if (payload.length >= 4) this.peerWindowSize = payload.readUInt32BE(0) || 2500000;
      return;
    }
    if (type === 3) return;
    if (type === 8) {
      parseAudioTag(payload, timestamp, this.media);
      return;
    }
    if (type === 9) {
      parseVideoTag(payload, timestamp, this.media);
    }
  }

  private handleCommand(payload: Buffer, streamId: number): void {
    let values: AmfValue[];
    try {
      values = decodeAmf0All(payload);
    } catch (error) {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const name = typeof values[0] === "string" ? values[0] : "";
    const transaction = typeof values[1] === "number" ? values[1] : 0;
    if (name === "connect") {
      this.sendControl(5, u32(2500000));
      this.sendControl(6, Buffer.concat([u32(2500000), Buffer.from([2])]));
      this.sendControl(1, u32(4096));
      this.sendCommand([
        "_result",
        transaction,
        { fmsVer: "FMS/3,0,1,123", capabilities: 31 },
        { level: "status", code: "NetConnection.Connect.Success", description: "LAN relay" },
      ]);
    } else if (name === "createStream") {
      this.sendCommand(["_result", transaction, null, 1]);
    } else if (name === "publish" || name === "play") {
      this.sendCommand([
        "onStatus",
        0,
        null,
        {
          level: "status",
          code: name === "publish" ? "NetStream.Publish.Start" : "NetStream.Play.Start",
          description: "LAN relay ready",
        },
      ], streamId || 1);
    } else if (name === "releaseStream" || name === "FCPublish" || name === "_checkbw") {
      if (transaction > 0) this.sendCommand(["_result", transaction, null, undefined]);
    }
  }

  private sendControl(type: number, payload: Buffer): void {
    this.sendMessage(type, 2, payload);
  }

  private maybeAcknowledge(): void {
    if (this.receivedBytes - this.acknowledgedBytes < this.peerWindowSize) return;
    this.acknowledgedBytes = this.receivedBytes;
    this.sendControl(3, u32(this.receivedBytes >>> 0));
  }

  private sendCommand(values: AmfValue[], streamId = 0): void {
    this.sendMessage(20, streamId, encodeAmf0(values));
  }

  private sendMessage(type: number, streamId: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const header = Buffer.allocUnsafe(12);
    header[0] = 2;
    header.writeUIntBE(0, 1, 3);
    header.writeUIntBE(payload.length, 4, 3);
    header[7] = type;
    header.writeUInt32LE(streamId, 8);
    this.socket.write(Buffer.concat([header, payload]));
  }

  private fail(error: Error): void {
    console.error(`[rtmp] ${error.message}`);
    this.options.onError(error);
    this.closed = true;
    this.socket.destroy();
  }
}

function u32(value: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32BE(value, 0);
  return out;
}
