import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { ClientMetrics } from "./media.ts";
import { WireKind, WIRE_VERSION } from "./wire.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_INBOUND_MESSAGE = 4 * 1024 * 1024;

interface QueueItem {
  frame: Buffer;
  bytes: number;
  media: boolean;
  keyframe: boolean;
}

export interface SocketPeerOptions {
  socket: Socket;
  remote: string;
  maxQueueBytes: number;
  onText: (text: string) => void;
  onBinary: (data: Buffer) => void;
  onClose: () => void;
  onSlow: () => void;
}

export function acceptWebSocket(request: IncomingMessage, socket: Socket, head: Buffer): boolean {
  const key = request.headers["sec-websocket-key"];
  const upgrade = request.headers.upgrade?.toLowerCase();
  if (!key || upgrade !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return false;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  if (head.length) socket.unshift(head);
  return true;
}

export class SocketPeer {
  readonly remote: string;
  private readonly socket: Socket;
  private readonly maxQueueBytes: number;
  private readonly callbacks: Omit<SocketPeerOptions, "socket" | "remote" | "maxQueueBytes">;
  private receive = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  private queue: QueueItem[] = [];
  private queuedBytes = 0;
  private droppedBytes = 0;
  private skippedFrames = 0;
  private sentBytes = 0;
  private configs = new Map<number, Buffer>();
  private needsKeyframe = false;
  private closed = false;
  private lastPongAt = Date.now();
  private lastAckAt = 0;
  private reportedQueueMs = 0;
  private pingTimer: NodeJS.Timeout;

  constructor(options: SocketPeerOptions) {
    this.socket = options.socket;
    this.remote = options.remote;
    this.maxQueueBytes = options.maxQueueBytes;
    this.callbacks = options;
    this.socket.setNoDelay(true);
    this.socket.on("data", (chunk) => this.read(chunk));
    this.socket.on("drain", () => this.pump());
    this.socket.on("error", () => this.finish());
    this.socket.on("close", () => this.finish());
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongAt > 45000) {
        this.socket.destroy();
        return;
      }
      this.writeFrame(0x09, Buffer.alloc(0));
    }, 15000);
  }

  sendText(text: string): void {
    this.enqueue(this.textFrame(text), false, false);
  }

  sendBinary(payload: Buffer): void {
    const kind = payload.length >= 6 && payload.readUInt8(4) === WIRE_VERSION ? payload.readUInt8(5) : 0;
    const isConfig = kind === WireKind.VideoConfig || kind === WireKind.AudioConfig;
    if (isConfig) {
      this.configs.set(kind, payload);
      this.enqueue(this.binaryFrame(payload), false, true);
      return;
    }
    const keyframe = (payload.length >= 7 && (payload[6] & 1) !== 0) || kind === 0;
    if (this.needsKeyframe) {
      if (!keyframe) {
        this.skippedFrames++;
        this.droppedBytes += payload.length;
        return;
      }
      for (const config of this.configs.values()) {
        this.enqueue(this.binaryFrame(config), false, true);
      }
      this.needsKeyframe = false;
    }
    this.enqueue(this.binaryFrame(payload), true, keyframe);
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    const body = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(1000, 0);
    body.write(reason, 2);
    this.writeFrame(0x08, body);
    this.closed = true;
    clearInterval(this.pingTimer);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 500).unref();
    this.callbacks.onClose();
  }

  metrics(now: number): ClientMetrics {
    const totalQueued = this.queuedBytes + this.socket.writableLength;
    let state: ClientMetrics["state"] = "live";
    if (this.closed) state = "closed";
    else if (this.needsKeyframe || totalQueued > this.maxQueueBytes * 0.6) state = "slow";
    return {
      id: 0,
      remote: this.remote,
      connectedAt: 0,
      state,
      queuedBytes: totalQueued,
      droppedBytes: this.droppedBytes,
      skippedFrames: this.skippedFrames,
      sentBytes: this.sentBytes,
      lastAckAt: this.lastAckAt,
      reportedQueueMs: this.reportedQueueMs,
    };
  }

  noteAck(queueMs: number): void {
    this.lastAckAt = Date.now();
    this.reportedQueueMs = Math.max(0, Math.round(queueMs));
  }

  private enqueue(frame: Buffer, media: boolean, keyframe: boolean): void {
    if (this.closed) return;
    const bytes = frame.length;
    if (media && this.queuedBytes + bytes > this.maxQueueBytes) {
      this.dropQueuedMedia();
      this.needsKeyframe = true;
      this.callbacks.onSlow();
      if (!keyframe) {
        this.skippedFrames++;
        this.droppedBytes += bytes;
        return;
      }
      for (const config of this.configs.values()) {
        this.queue.push({ frame: this.binaryFrame(config), bytes: config.length + 14, media: false, keyframe: true });
        this.queuedBytes += config.length + 14;
      }
      this.needsKeyframe = false;
    }
    if (!media && this.queuedBytes + bytes > this.maxQueueBytes * 1.5) {
      this.close("control-queue-overflow");
      return;
    }
    this.queue.push({ frame, bytes, media, keyframe });
    this.queuedBytes += bytes;
    this.pump();
  }

  private dropQueuedMedia(): void {
    this.queue = this.queue.filter((item) => {
      if (!item.media) return true;
      this.droppedBytes += item.bytes;
      return false;
    });
    this.queuedBytes = this.queue.reduce((sum, item) => sum + item.bytes, 0);
  }

  private pump(): void {
    if (this.closed || this.socket.destroyed) return;
    while (this.queue.length > 0 && !this.socket.writableNeedDrain) {
      const item = this.queue.shift();
      if (!item) break;
      this.queuedBytes -= item.bytes;
      this.sentBytes += item.bytes;
      this.socket.write(item.frame);
    }
  }

  private read(chunk: Buffer): void {
    if (this.closed) return;
    this.receive = this.receive.length ? Buffer.concat([this.receive, chunk]) : chunk;
    if (this.receive.length > MAX_INBOUND_MESSAGE + 14) {
      this.close("inbound-overflow");
      return;
    }
    try {
      while (this.readFrame()) {
        if (this.closed) return;
      }
    } catch {
      this.close("protocol-error");
    }
  }

  private readFrame(): boolean {
    if (this.receive.length < 2) return false;
    const first = this.receive[0];
    const second = this.receive[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.receive.length < 4) return false;
      length = this.receive.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.receive.length < 10) return false;
      const high = this.receive.readUInt32BE(2);
      if (high !== 0) throw new Error("WebSocket frame too large");
      length = this.receive.readUInt32BE(6);
      offset = 10;
    }
    if (length > MAX_INBOUND_MESSAGE) {
      this.close("frame-too-large");
      return false;
    }
    const maskLength = masked ? 4 : 0;
    if (this.receive.length < offset + maskLength + length) return false;
    let payload: Buffer;
    if (masked) {
      const mask = this.receive.subarray(offset, offset + 4);
      offset += 4;
      payload = Buffer.from(this.receive.subarray(offset, offset + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    } else {
      payload = Buffer.from(this.receive.subarray(offset, offset + length));
    }
    this.receive = this.receive.subarray(offset + length);
    this.handleFrame(opcode, fin, payload);
    return true;
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x08) {
      this.close("peer-close");
      return;
    }
    if (opcode === 0x09) {
      this.writeFrame(0x0a, payload);
      return;
    }
    if (opcode === 0x0a) {
      this.lastPongAt = Date.now();
      return;
    }
    if (opcode === 0x00) {
      if (!this.fragmentOpcode) return;
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_INBOUND_MESSAGE) {
        this.close("fragment-overflow");
        return;
      }
      if (fin) this.dispatchMessage(this.fragmentOpcode, Buffer.concat(this.fragments));
      return;
    }
    if (opcode === 0x01 || opcode === 0x02) {
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return;
      }
      this.dispatchMessage(opcode, payload);
    }
  }

  private dispatchMessage(opcode: number, payload: Buffer): void {
    const wasText = opcode === 0x01 || this.fragmentOpcode === 0x01;
    this.fragmentOpcode = 0;
    this.fragments = [];
    this.fragmentBytes = 0;
    if (wasText) this.callbacks.onText(payload.toString("utf8"));
    else this.callbacks.onBinary(payload);
  }

  private textFrame(text: string): Buffer {
    return this.wrapFrame(0x01, Buffer.from(text, "utf8"));
  }

  private binaryFrame(payload: Buffer): Buffer {
    return this.wrapFrame(0x02, payload);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.closed && !this.socket.destroyed) this.socket.write(this.wrapFrame(opcode, payload));
  }

  private wrapFrame(opcode: number, payload: Buffer): Buffer {
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    return Buffer.concat([header, payload]);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    this.callbacks.onClose();
  }
}
