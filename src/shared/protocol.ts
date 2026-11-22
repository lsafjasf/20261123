/**
 * 线协议定义，浏览器端与 Node 服务端共用、且可被 Node 内置测试直接导入。
 *
 * 媒体帧（二进制）布局（小端）：
 *   magic(4)="RLP1" version(1) flags(1) headerLen(2)
 *   roundId(36 ASCII, 不足补 0)
 *   seq(u32) timestampUs(f64) durationUs(f64)
 *   tSendMs(f64) tServerRxMs(f64) tServerTxMs(f64)
 *   payloadLen(u32)  + payload(WebM 分片)
 * 固定头部共 88 字节。
 *
 * 控制消息走 WebSocket 文本帧，JSON 编码。
 */

import type { DropEvent, MarkerTimeline, Role, StageId } from './types.ts';

export const FRAME_MAGIC = 'RLP1';
export const FRAME_VERSION = 1;
export const ROUND_ID_LEN = 36;
export const HEADER_LEN = 92;

export const FLAG_KEYFRAME = 0x01;

export interface MediaFrame {
  roundId: string;
  seq: number;
  timestampUs: number;
  durationUs: number;
  tSendMs: number;
  tServerRxMs: number;
  tServerTxMs: number;
  keyframe: boolean;
  payload: Uint8Array;
}

export class ProtocolError extends Error {}

export function encodeMediaFrame(frame: MediaFrame): Uint8Array {
  if (frame.roundId.length > ROUND_ID_LEN) {
    throw new ProtocolError(`roundId 长度不能超过 ${ROUND_ID_LEN}`);
  }
  const out = new Uint8Array(HEADER_LEN + frame.payload.length);
  const view = new DataView(out.buffer);
  const enc = new TextEncoder();
  out.set(enc.encode(FRAME_MAGIC), 0);
  view.setUint8(4, FRAME_VERSION);
  view.setUint8(5, frame.keyframe ? FLAG_KEYFRAME : 0);
  view.setUint16(6, HEADER_LEN, true);
  const idBytes = enc.encode(frame.roundId);
  out.set(idBytes, 8);
  view.setUint32(44, frame.seq >>> 0, true);
  view.setFloat64(48, frame.timestampUs, true);
  view.setFloat64(56, frame.durationUs, true);
  view.setFloat64(64, frame.tSendMs, true);
  view.setFloat64(72, frame.tServerRxMs, true);
  view.setFloat64(80, frame.tServerTxMs, true);
  view.setUint32(88, frame.payload.length, true);
  out.set(frame.payload, HEADER_LEN);
  return out;
}

export function decodeMediaHeader(bytes: Uint8Array): {
  frame: MediaFrame;
  headerLen: number;
} {
  if (bytes.length < HEADER_LEN) {
    throw new ProtocolError('媒体帧短于固定头部');
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== FRAME_MAGIC) {
    throw new ProtocolError(`非法 magic: ${magic}`);
  }
  if (view.getUint8(4) !== FRAME_VERSION) {
    throw new ProtocolError('协议版本不匹配');
  }
  const flags = view.getUint8(5);
  const headerLen = view.getUint16(6, true);
  if (headerLen !== HEADER_LEN) {
    throw new ProtocolError(`意外的头部长度 ${headerLen}`);
  }
  const roundId = new TextDecoder()
    .decode(bytes.subarray(8, 8 + ROUND_ID_LEN))
    .replace(/\0+$/u, '');
  const seq = view.getUint32(44, true);
  const timestampUs = view.getFloat64(48, true);
  const durationUs = view.getFloat64(56, true);
  const tSendMs = view.getFloat64(64, true);
  const tServerRxMs = view.getFloat64(72, true);
  const tServerTxMs = view.getFloat64(80, true);
  const payloadLen = view.getUint32(88, true);
  if (bytes.length < HEADER_LEN + payloadLen) {
    throw new ProtocolError('声明的 payload 长度超出实际帧长');
  }
  const payload = bytes.subarray(HEADER_LEN, HEADER_LEN + payloadLen);
  return {
    frame: {
      roundId,
      seq,
      timestampUs,
      durationUs,
      tSendMs,
      tServerRxMs,
      tServerTxMs,
      keyframe: (flags & FLAG_KEYFRAME) !== 0,
      payload: new Uint8Array(payload),
    },
    headerLen,
  };
}

/** 服务端回填时间戳后，原地修改一份新的二进制帧并返回。 */
export function stampServerTimes(
  bytes: Uint8Array,
  rxMs: number,
  txMs: number,
): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  view.setFloat64(72, rxMs, true);
  view.setFloat64(80, txMs, true);
  return copy;
}

export type ControlMessage =
  | { kind: 'hello'; role: Role; roundId: string }
  | { kind: 'subscribe'; roundId: string }
  | {
      kind: 'round-open';
      roundId: string;
      label: string;
      startedAt: number;
    }
  | { kind: 'round-close'; roundId: string; closedAt: number }
  | { kind: 'marker'; roundId: string; seq: number; t0: number }
  | {
      kind: 'stage';
      roundId: string;
      seq: number;
      stage: StageId;
      t: number;
    }
  | { kind: 'drop'; event: DropEvent }
  | { kind: 'clock-sync'; roundId: string; id: number; t0: number }
  | {
      kind: 'clock-sync-ack';
      roundId: string;
      id: number;
      t0: number;
      t1: number;
    }
  | { kind: 'error'; message: string };

export function encodeControl(msg: ControlMessage): string {
  return JSON.stringify(msg);
}

export function decodeControl(text: string): ControlMessage {
  const parsed = JSON.parse(text) as ControlMessage;
  if (typeof parsed.kind !== 'string') {
    throw new ProtocolError('控制消息缺少 kind 字段');
  }
  return parsed;
}

/** 把一条分段事件合并进标记时间线。 */
export function applyStageEvent(
  timeline: MarkerTimeline,
  stage: StageId,
  t: number,
): void {
  switch (stage) {
    case 'capture':
      timeline.t1Captured = t;
      break;
    case 'process':
      timeline.t2Processed = t;
      break;
    case 'upload':
      timeline.t3Encoded = t;
      break;
    case 'decode':
      timeline.t7Decoded = t;
      break;
    case 'output':
      timeline.t8Output = t;
      break;
  }
}
