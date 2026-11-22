/**
 * 单条 WebSocket 连接的封装：负责握手、帧收发、关闭与错误传播。
 * 服务端发出的帧不带掩码，客户端帧必须带掩码（由 WsDecoder 保证）。
 */

import type { Socket } from 'node:net';
import {
  encodeClose,
  encodeFrame,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_PING,
  OPCODE_PONG,
  OPCODE_TEXT,
  WsDecoder,
  WsProtocolError,
} from '../shared/ws.ts';

export interface ConnectionEvents {
  onText: (text: string) => void;
  onBinary: (bytes: Uint8Array) => void;
  onClose: (code: number, reason: string) => void;
  onError: (error: Error) => void;
}

export class WsConnection {
  private readonly socket: Socket;
  private readonly decoder = new WsDecoder();
  private readonly events: ConnectionEvents;
  private closed = false;

  constructor(socket: Socket, events: ConnectionEvents) {
    this.socket = socket;
    this.events = events;
    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.events.onClose(1006, 'tcp closed');
      }
    });
    socket.on('error', (error) => this.events.onError(error));
  }

  private handleData(chunk: Buffer): void {
    try {
      const frames = this.decoder.push(new Uint8Array(chunk));
      for (const frame of frames) {
        if (frame.opcode === OPCODE_TEXT) {
          this.events.onText(new TextDecoder().decode(frame.payload));
        } else if (frame.opcode === OPCODE_BINARY) {
          this.events.onBinary(frame.payload);
        } else if (frame.opcode === OPCODE_CLOSE) {
          const code =
            frame.payload.length >= 2
              ? new DataView(
                  frame.payload.buffer,
                  frame.payload.byteOffset,
                  2,
                ).getUint16(0, false)
              : 1000;
          const reason = new TextDecoder().decode(frame.payload.subarray(2));
          this.close(code, reason);
        } else if (frame.opcode === OPCODE_PING) {
          this.sendRaw(encodeFrame(OPCODE_PONG, frame.payload));
        }
      }
    } catch (error) {
      if (error instanceof WsProtocolError) {
        this.close(1002, 'protocol error');
        this.events.onError(error);
      } else {
        this.events.onError(error as Error);
      }
    }
  }

  sendText(text: string): void {
    this.sendRaw(
      encodeFrame(OPCODE_TEXT, new TextEncoder().encode(text)),
    );
  }

  sendBinary(bytes: Uint8Array): void {
    this.sendRaw(encodeFrame(OPCODE_BINARY, bytes));
  }

  private sendRaw(frame: Uint8Array): void {
    if (this.closed) {
      return;
    }
    this.socket.write(Buffer.from(frame));
  }

  close(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.sendRaw(encodeFrame(OPCODE_CLOSE, encodeClose(code, reason)));
    } finally {
      this.socket.end();
      this.events.onClose(code, reason);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
