/**
 * 最小可用的 RFC 6455 WebSocket 帧编解码（仅服务端视角：接收必须掩码，
 * 发送不掩码）。不依赖任何第三方包。
 */

export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

export class WsProtocolError extends Error {}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export async function acceptKey(key: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(key + GUID).digest('base64');
}

function applyMask(data: Uint8Array, mask: Uint8Array): void {
  for (let i = 0; i < data.length; i += 1) {
    data[i] = data[i] ^ mask[i % 4];
  }
}

export function encodeFrame(
  opcode: number,
  payload: Uint8Array,
  fin = true,
): Uint8Array {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 65536) {
    headerLen += 8;
  } else if (len > 125) {
    headerLen += 2;
  }
  const out = new Uint8Array(headerLen + len);
  out[0] = (fin ? 0x80 : 0) | opcode;
  if (len >= 65536) {
    out[1] = 127;
    const view = new DataView(out.buffer);
    view.setBigUint64(2, BigInt(len), false);
  } else if (len > 125) {
    out[1] = 126;
    new DataView(out.buffer).setUint16(2, len, false);
  } else {
    out[1] = len;
  }
  out.set(payload, headerLen);
  return out;
}

export function encodeClose(code: number, reason: string): Uint8Array {
  const body = new TextEncoder().encode(reason);
  const out = new Uint8Array(2 + body.length);
  new DataView(out.buffer).setUint16(0, code, false);
  out.set(body, 2);
  return out;
}

/**
 * 流式解码器：浏览器端帧必须带掩码。分片消息会被重组为完整帧再吐出。
 */
export class WsDecoder {
 private buffer: Uint8Array = new Uint8Array(0);
  private fragments: Uint8Array[] = [];
  private fragmentOpcode = -1;
  private maxPayload: number;

  constructor(maxPayload = 16 * 1024 * 1024) {
    this.maxPayload = maxPayload;
  }

  push(chunk: Uint8Array): WsFrame[] {
    this.buffer = concat(this.buffer, chunk);
    const frames: WsFrame[] = [];
    for (;;) {
      const parsed = this.tryParseOne();
      if (parsed === null) {
        break;
      }
      const { fin, opcode, payload } = parsed;
      if (opcode === OPCODE_CONTINUATION) {
        if (this.fragmentOpcode < 0) {
          throw new WsProtocolError('收到未预期的 continuation 帧');
        }
        this.fragments.push(payload);
        if (fin) {
          frames.push({
            fin: true,
            opcode: this.fragmentOpcode,
            payload: concatAll(this.fragments),
          });
          this.fragments = [];
          this.fragmentOpcode = -1;
        }
      } else if (opcode >= OPCODE_CLOSE) {
        frames.push({ fin, opcode, payload });
      } else if (fin) {
        frames.push({ fin, opcode, payload });
      } else {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      }
    }
    return frames;
  }

  private tryParseOne(): WsFrame | null {
    const buf = this.buffer;
    if (buf.length < 2) {
      return null;
    }
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let offset = 2;
    if (payloadLen === 126) {
      if (buf.length < offset + 2) {
        return null;
      }
      payloadLen = new DataView(
        buf.buffer,
        buf.byteOffset + offset,
        2,
      ).getUint16(0, false);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) {
        return null;
      }
      const big = new DataView(
        buf.buffer,
        buf.byteOffset + offset,
        8,
      ).getBigUint64(0, false);
      if (big > BigInt(this.maxPayload)) {
        throw new WsProtocolError('负载超过上限');
      }
      payloadLen = Number(big);
      offset += 8;
    }
    if (!masked) {
      throw new WsProtocolError('客户端帧必须带掩码');
    }
    if (buf.length < offset + 4 + payloadLen) {
      return null;
    }
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = buf.slice(offset, offset + payloadLen);
    applyMask(payload, mask);
    this.buffer = buf.subarray(offset + payloadLen);
    return { fin, opcode, payload };
  }
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}
