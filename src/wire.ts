import type { MediaSample, SourceSnapshot } from "./media.ts";

export const WIRE_MAGIC = 0x45465231;
export const WIRE_VERSION = 1;
export const WIRE_HEADER_BYTES = 24;

export const WireKind = {
  VideoConfig: 1,
  AudioConfig: 2,
  VideoSample: 3,
  AudioSample: 4,
} as const;

export const WireFlags = {
  Keyframe: 1,
  GopStart: 2,
  Replay: 4,
  EndOfSource: 8,
} as const;

export type WireKindValue = (typeof WireKind)[keyof typeof WireKind];

export interface ParsedWirePacket {
  kind: WireKindValue;
  flags: number;
  ptsMs: number;
  durationMs: number;
  seq: number;
  payload: Uint8Array;
}

export function encodeMediaFrame(
  kind: WireKindValue,
  sample: Pick<MediaSample, "ptsMs" | "durationMs">,
  payload: Uint8Array,
  flags: number,
  seq: number,
): Buffer {
  const out = Buffer.allocUnsafe(WIRE_HEADER_BYTES + payload.byteLength);
  out.writeUInt32LE(WIRE_MAGIC, 0);
  out.writeUInt8(WIRE_VERSION, 4);
  out.writeUInt8(kind, 5);
  out.writeUInt8(flags & 0xff, 6);
  out.writeUInt8(0, 7);
  out.writeDoubleLE(sample.ptsMs, 8);
  out.writeFloatLE(sample.durationMs, 16);
  out.writeUInt32LE(seq >>> 0, 20);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, WIRE_HEADER_BYTES);
  return out;
}

export function parseWireFrame(frame: ArrayBuffer | Uint8Array): ParsedWirePacket | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < WIRE_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== WIRE_MAGIC || view.getUint8(4) !== WIRE_VERSION) return null;
  const kind = view.getUint8(5);
  if (kind < WireKind.VideoConfig || kind > WireKind.AudioSample) return null;
  return {
    kind: kind as WireKindValue,
    flags: view.getUint8(6),
    ptsMs: view.getFloat64(8, true),
    durationMs: view.getFloat32(16, true),
    seq: view.getUint32(20, true),
    payload: bytes.subarray(WIRE_HEADER_BYTES),
  };
}

export function sourceWireState(source: SourceSnapshot): Record<string, unknown> {
  return {
    state: source.state,
    generation: source.generation,
    since: source.since,
    protocol: source.protocol,
    lastSeenAt: source.lastSeenAt,
    reconnectCount: source.reconnectCount,
    video: source.video
      ? {
          codec: source.video.codec,
          width: source.video.width,
          height: source.video.height,
        }
      : null,
    audio: source.audio
      ? {
          codec: source.audio.codec,
          sampleRate: source.audio.sampleRate,
          channels: source.audio.channels,
        }
      : null,
  };
}
