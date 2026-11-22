/**
 * 浏览器端 WebSocket 封装：自动重连、角色 hello 绑定、
 * 文本/二进制消息分发。连接以 roundId 建立，天然按轮次隔离。
 */

import { encodeControl } from '../../shared/protocol.ts';
import type { ControlMessage } from '../../shared/protocol.ts';
import type { Role } from '../../shared/types.ts';

export interface WsClientHandlers {
  onControl: (message: ControlMessage, raw: string) => void;
  onBinary: (bytes: Uint8Array) => void;
  onStatus: (status: string) => void;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private readonly roundId: string;
  private readonly role: Role;
  private readonly handlers: WsClientHandlers;
  private reconnectAttempts = 0;
  private closedByUser = false;
  private openResolvers: Array<() => void> = [];

  constructor(roundId: string, role: Role, handlers: WsClientHandlers) {
    this.roundId = roundId;
    this.role = role;
    this.handlers = handlers;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/ws`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.attachListeners(this.ws);
  }

  connect(): void {
    this.closedByUser = false;
  }

  private attachListeners(ws: WebSocket): void {
    ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      ws.send(
        encodeControl({
          kind: 'hello',
          role: this.role,
          roundId: this.roundId,
        }),
      );
      this.handlers.onStatus('WebSocket 已连接');
      const resolvers = this.openResolvers.splice(0);
      for (const resolve of resolvers) {
        resolve();
      }
    });
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as ControlMessage;
          this.handlers.onControl(message, event.data);
        } catch {
          this.handlers.onStatus('收到无法解析的文本消息');
        }
      } else if (event.data instanceof ArrayBuffer) {
        this.handlers.onBinary(new Uint8Array(event.data));
      }
    });
    ws.addEventListener('close', () => {
      if (this.closedByUser) {
        return;
      }
      this.reconnectAttempts += 1;
      const delay = Math.min(8000, 500 * 2 ** this.reconnectAttempts);
      this.handlers.onStatus(`连接断开，${delay}ms 后重连`);
      setTimeout(() => {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const next = new WebSocket(
          `${protocol}://${window.location.host}/ws`,
        );
        next.binaryType = 'arraybuffer';
        this.ws = next;
        this.attachListeners(next);
      }, delay);
    });
    ws.addEventListener('error', () => {
      this.handlers.onStatus('WebSocket 错误');
    });
  }

  sendText(message: ControlMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeControl(message));
    }
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
    }
  }

  get raw(): WebSocket | null {
    return this.ws;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onceOpen(): Promise<void> {
    if (this.isOpen) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.openResolvers.push(resolve));
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }
}
