export interface EncodedAudioFrame {
  timestampUs: number;
  data: Uint8Array;
  keyframe?: boolean;
}

export interface OpusWebMOptions {
  durationMs: number;
  sampleRate: number;
  channels: number;
  description?: Uint8Array;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  let value = id;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return Uint8Array.from(bytes.length > 0 ? bytes : [0]);
}

function sizeBytes(size: number, length?: number): Uint8Array {
  let width = length ?? 1;
  if (!length) {
    while (width < 8 && size >= Math.pow(2, 7 * width) - 1) width += 1;
  }
  const output = new Uint8Array(width);
  let value = size;
  for (let index = width - 1; index >= 0; index -= 1) {
    output[index] = value & 0xff;
    value = Math.floor(value / 256);
  }
  output[0] |= 1 << (8 - width);
  return output;
}

function element(id: number, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), sizeBytes(payload.length), payload]);
}

function uintBytes(value: number): Uint8Array {
  if (value <= 0) return new Uint8Array([0]);
  const bytes: number[] = [];
  let remaining = Math.floor(value);
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Uint8Array.from(bytes);
}

function float64Bytes(value: number): Uint8Array {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setFloat64(0, value, false);
  return output;
}

function stringBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function uintElement(id: number, value: number): Uint8Array {
  return element(id, uintBytes(value));
}

function floatElement(id: number, value: number): Uint8Array {
  return element(id, float64Bytes(value));
}

function stringElement(id: number, value: string): Uint8Array {
  return element(id, stringBytes(value));
}

function defaultOpusHead(channels: number, sampleRate: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  const view = new DataView(head.buffer);
  view.setUint8(8, 1);
  view.setUint8(9, channels);
  view.setUint16(10, 312, true);
  view.setUint32(12, sampleRate, true);
  view.setInt16(16, 0, true);
  view.setUint8(18, 0);
  return head;
}

function simpleBlock(frame: EncodedAudioFrame, clusterTimeMs: number): Uint8Array {
  const relative = Math.round(frame.timestampUs / 1000) - clusterTimeMs;
  const header = new Uint8Array(4);
  header[0] = 0x81;
  new DataView(header.buffer).setInt16(1, Math.max(-32768, Math.min(32767, relative)), false);
  header[3] = frame.keyframe === false ? 0 : 0x80;
  return element(0xa3, concat([header, frame.data]));
}

function makeCluster(frames: readonly EncodedAudioFrame[]): Uint8Array {
  const first = frames[0];
  const clusterTimeMs = first ? Math.round(first.timestampUs / 1000) : 0;
  const blocks = frames.map((frame) => simpleBlock(frame, clusterTimeMs));
  return element(0x1f43b675, concat([uintElement(0xe7, clusterTimeMs), ...blocks]));
}

export function muxOpusWebM(
  frames: readonly EncodedAudioFrame[],
  options: OpusWebMOptions
): Uint8Array {
  const ebml = element(0x1a45dfa3, concat([
    uintElement(0x4286, 1),
    uintElement(0x42f7, 1),
    uintElement(0x42f2, 4),
    uintElement(0x42f3, 8),
    stringElement(0x4282, "webm"),
    uintElement(0x4287, 4),
    uintElement(0x4285, 2)
  ]));
  const info = element(0x1549a966, concat([
    uintElement(0x2ad7b1, 1_000_000),
    floatElement(0x4489, options.durationMs),
    stringElement(0x4d80, "car-voice-lab"),
    stringElement(0x5741, "car-voice-lab")
  ]));
  const description = options.description && options.description.length > 0
    ? options.description
    : defaultOpusHead(options.channels, options.sampleRate);
  const audio = element(0xe1, concat([
    floatElement(0xb5, options.sampleRate),
    uintElement(0x9f, options.channels)
  ]));
  const track = element(0xae, concat([
    uintElement(0xd7, 1),
    uintElement(0x73c5, 1),
    uintElement(0x83, 2),
    uintElement(0x56aa, 6_500_000),
    uintElement(0x56bb, 80_000_000),
    stringElement(0x86, "A_OPUS"),
    element(0x63a2, description),
    audio
  ]));
  const tracks = element(0x1654ae6b, track);
  const clusters: Uint8Array[] = [];
  for (let index = 0; index < frames.length; index += 120) {
    const slice = frames.slice(index, index + 120);
    if (slice.length > 0) clusters.push(makeCluster(slice));
  }
  const segment = element(0x18538067, concat([info, tracks, ...clusters]));
  return concat([ebml, segment]);
}
