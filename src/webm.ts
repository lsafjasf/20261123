import type { RenderResult } from "./synth.js";

const textEncoder = new TextEncoder();

interface EncoderChunk {
  timestamp: number;
  duration: number | null;
  data: Uint8Array;
}

interface EncoderMetadata {
  decoderConfig?: {
    description?: ArrayBuffer | ArrayBufferView;
  };
}

interface AudioEncoderLike {
  encode(data: AudioData): void;
  flush(): Promise<void>;
  close(): void;
  configure(config: Record<string, unknown>): void;
}

interface AudioEncoderConstructor {
  new (init: { output: (chunk: EncoderChunkLike, meta?: EncoderMetadata) => void; error: (error: Error) => void }): AudioEncoderLike;
  isConfigSupported(config: Record<string, unknown>): Promise<{ supported?: boolean; config?: Record<string, unknown> }>;
}

interface EncoderChunkLike {
  timestamp: number;
  duration: number | null;
  copyTo(destination: Uint8Array): void;
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function encodeSize(value: number): Uint8Array {
  let length = 1;
  while (length < 8 && value >= 2 ** (7 * length) - 1) length += 1;
  const output = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  output[0] |= 1 << (8 - length);
  return output;
}

function element(id: Uint8Array, payload: Uint8Array): Uint8Array {
  return concat([id, encodeSize(payload.length), payload]);
}

function uintElement(id: Uint8Array, value: number, width = 0): Uint8Array {
  let length = width;
  if (length === 0) {
    length = 1;
    while (length < 8 && value >= 2 ** (8 * length)) length += 1;
  }
  const output = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return element(id, output);
}

function floatElement(id: Uint8Array, value: number): Uint8Array {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, value, false);
  return element(id, payload);
}

function stringElement(id: Uint8Array, value: string): Uint8Array {
  return element(id, textEncoder.encode(value));
}

function int16(value: number): Uint8Array {
  const output = new Uint8Array(2);
  new DataView(output.buffer).setInt16(0, Math.max(-32768, Math.min(32767, value)), false);
  return output;
}

function makeOpusHead(channels: number, preSkip = 312): Uint8Array {
  const head = new Uint8Array(19);
  head.set(textEncoder.encode("OpusHead"), 0);
  const view = new DataView(head.buffer);
  view.setUint8(8, 1);
  view.setUint8(9, channels);
  view.setUint16(10, preSkip, true);
  view.setUint32(12, 48_000, true);
  view.setInt16(16, 0, true);
  view.setUint8(18, 0);
  return head;
}

function buildWebm(
  chunks: EncoderChunk[],
  description: Uint8Array | null,
  channels: number,
  durationMs: number,
): Uint8Array {
  const ebml = element(bytes(0x1a, 0x45, 0xdf, 0xa3), concat([
    uintElement(bytes(0x42, 0x86), 1),
    uintElement(bytes(0x42, 0xf7), 1),
    uintElement(bytes(0x42, 0xf2), 4),
    uintElement(bytes(0x42, 0xf3), 8),
    stringElement(bytes(0x42, 0x82), "webm"),
    uintElement(bytes(0x42, 0x87), 4),
    uintElement(bytes(0x42, 0x85), 2),
  ]));

  const info = element(bytes(0x15, 0x49, 0xa9, 0x66), concat([
    uintElement(bytes(0x2a, 0xd7, 0xb1), 1_000_000),
    floatElement(bytes(0x44, 0x89), durationMs),
    stringElement(bytes(0x4d, 0x80), "Apex Tape Stop"),
    stringElement(bytes(0x57, 0x41), "Apex Tape Stop TS"),
  ]));

  const audio = element(bytes(0xe1), concat([
    floatElement(bytes(0xb5), 48_000),
    uintElement(bytes(0x9f), channels),
  ]));

  const track = element(bytes(0xae), concat([
    uintElement(bytes(0xd7), 1),
    uintElement(bytes(0x73, 0xc5), 1),
    uintElement(bytes(0x83), 2),
    uintElement(bytes(0x9c), 0),
    stringElement(bytes(0x86), "A_OPUS"),
    element(bytes(0x63, 0xa2), description ?? makeOpusHead(channels)),
    uintElement(bytes(0x23, 0xe3, 0x83), 20_000_000),
    audio,
  ]));
  const tracks = element(bytes(0x16, 0x54, 0xae, 0x6b), track);

  const blocks = chunks.map((chunk) => element(
    bytes(0xa3),
    concat([
      bytes(0x81),
      int16(Math.round(chunk.timestamp / 1000)),
      bytes(0x80),
      chunk.data,
    ]),
  ));
  const cluster = element(bytes(0x1f, 0x43, 0xb6, 0x75), concat([
    uintElement(bytes(0xe7), 0),
    ...blocks,
  ]));

  const segment = element(bytes(0x18, 0x53, 0x80, 0x67), concat([info, tracks, cluster]));
  return concat([ebml, segment]);
}

export function webCodecsStatus(): { available: boolean; reason: string } {
  const globals = globalThis as unknown as {
    AudioEncoder?: AudioEncoderConstructor;
    AudioData?: unknown;
  };
  if (typeof globals.AudioEncoder !== "function") {
    return { available: false, reason: "AudioEncoder unavailable" };
  }
  if (typeof globals.AudioData !== "function") {
    return { available: false, reason: "AudioData unavailable" };
  }
  return { available: true, reason: "AudioEncoder ready" };
}

export interface OpusWebmResult {
  blob: Blob;
  mimeType: string;
  packets: number;
  encodedBytes: number;
  durationMs: number;
}

export async function encodeOpusWebm(result: RenderResult): Promise<OpusWebmResult> {
  const globals = globalThis as unknown as {
    AudioEncoder: AudioEncoderConstructor;
    AudioData: new (init: Record<string, unknown>) => AudioData & { close(): void };
  };
  if (!webCodecsStatus().available) throw new Error(webCodecsStatus().reason);

  const config: Record<string, unknown> = {
    codec: "opus",
    sampleRate: result.timing.sampleRate,
    numberOfChannels: 2,
    bitrate: 160_000,
  };
  const support = await globals.AudioEncoder.isConfigSupported(config);
  if (support.supported === false) throw new Error("Opus AudioEncoder config unsupported");

  const chunks: EncoderChunk[] = [];
  let description: Uint8Array | null = null;
  let encodeError: Error | null = null;

  const encoder = new globals.AudioEncoder({
    output: (chunk, metadata) => {
      const bytesOut = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytesOut);
      chunks.push({
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data: bytesOut,
      });
      const rawDescription = metadata?.decoderConfig?.description;
      if (rawDescription && description === null) {
        description = rawDescription instanceof ArrayBuffer
          ? new Uint8Array(rawDescription.slice(0))
          : new Uint8Array(rawDescription.buffer.slice(
            rawDescription.byteOffset,
            rawDescription.byteOffset + rawDescription.byteLength,
          ));
      }
    },
    error: (error) => {
      encodeError = error;
    },
  });

  try {
    encoder.configure(support.config ?? config);
    const frameSize = 960;
    const total = result.timing.totalSamples;
    for (let offset = 0; offset < total; offset += frameSize) {
      const frameCount = Math.min(frameSize, total - offset);
      const planar = new Float32Array(frameSize * 2);
      planar.set(result.left.subarray(offset, offset + frameCount), 0);
      planar.set(result.right.subarray(offset, offset + frameCount), frameSize);
      const audioData = new globals.AudioData({
        format: "f32-planar",
        sampleRate: result.timing.sampleRate,
        numberOfFrames: frameSize,
        numberOfChannels: 2,
        timestamp: Math.round((offset / result.timing.sampleRate) * 1_000_000),
        data: planar,
      });
      encoder.encode(audioData);
      audioData.close();
    }
    await encoder.flush();
  } finally {
    encoder.close();
  }

  if (encodeError) throw encodeError;
  if (chunks.length === 0) throw new Error("AudioEncoder returned no packets");
  chunks.sort((a, b) => a.timestamp - b.timestamp);
  const durationMs = (result.timing.totalSamples / result.timing.sampleRate) * 1000;
  const webm = buildWebm(chunks, description, 2, durationMs);
  const encodedBytes = chunks.reduce((total, chunk) => total + chunk.data.length, 0);
  return {
    blob: new Blob([webm], { type: "audio/webm; codecs=opus" }),
    mimeType: "audio/webm; codecs=opus",
    packets: chunks.length,
    encodedBytes,
    durationMs,
  };
}
