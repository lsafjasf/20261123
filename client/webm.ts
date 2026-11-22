export interface MuxFrame {
  track: "video" | "audio";
  timestampUs: number;
  keyframe: boolean;
  data: Uint8Array;
}

export interface WebMInitOptions {
  width: number;
  height: number;
  fps: number;
  totalDurationMs: number;
  audioSampleRate: number;
  audioChannels: number;
  opusHead?: Uint8Array | null;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function idBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function sizeBytes(value: number): Uint8Array {
  for (let length = 1; length <= 8; length += 1) {
    if (value < 2 ** (7 * length) - 1) {
      const output = new Uint8Array(length);
      let remaining = value;
      for (let index = length - 1; index >= 0; index -= 1) {
        output[index] = remaining % 256;
        remaining = Math.floor(remaining / 256);
      }
      output[0] = (output[0] ?? 0) | (1 << (8 - length));
      return output;
    }
  }
  throw new Error("WebM element is too large");
}

function element(id: string, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), sizeBytes(payload.byteLength), payload]);
}

function master(id: string, children: Uint8Array[], unknownSize = false): Uint8Array {
  const payload = concat(children);
  const size = unknownSize ? new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : sizeBytes(payload.length);
  return concat([idBytes(id), size, payload]);
}

function uintPayload(value: number): Uint8Array {
  if (value === 0) {
    return new Uint8Array([0]);
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return new Uint8Array(bytes);
}

function uint(id: string, value: number): Uint8Array {
  return element(id, uintPayload(value));
}

function string(id: string, value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value));
}

function float(id: string, value: number): Uint8Array {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, value, false);
  return element(id, payload);
}

function buildOpusHead(sampleRate: number, channels: number): Uint8Array {
  const bytes = new Uint8Array(19);
  bytes.set(new TextEncoder().encode("OpusHead"), 0);
  const view = new DataView(bytes.buffer);
  bytes[8] = 1;
  bytes[9] = channels;
  view.setUint16(10, 312, true);
  view.setUint32(12, sampleRate, true);
  view.setInt16(16, 0, true);
  bytes[18] = 0;
  return bytes;
}

function ebmlHeader(): Uint8Array {
  return element(
    "1a45dfa3",
    concat([
      uint("4286", 1),
      uint("42f7", 1),
      uint("42f2", 4),
      uint("42f3", 8),
      string("4282", "webm"),
      uint("4287", 4),
      uint("4285", 2),
    ]),
  );
}

function info(durationMs: number): Uint8Array {
  return element(
    "1549a966",
    concat([
      uint("2ad7b1", 1_000_000),
      float("4489", durationMs),
      string("4d80", "nimbus-webcodecs-muxer"),
      string("5741", "nimbus-controlled-player"),
    ]),
  );
}

function videoTrack(options: WebMInitOptions): Uint8Array {
  return element(
    "ae",
    concat([
      uint("d7", 1),
      uint("73c5", 1),
      uint("83", 1),
      uint("9c", 0),
      string("86", "V_VP8"),
      uint("23e383", Math.round(1_000_000_000 / options.fps)),
      element("e0", concat([uint("b0", options.width), uint("ba", options.height)])),
    ]),
  );
}

function audioTrack(options: WebMInitOptions): Uint8Array {
  const opusHead = options.opusHead ?? buildOpusHead(options.audioSampleRate, options.audioChannels);
  return element(
    "ae",
    concat([
      uint("d7", 2),
      uint("73c5", 2),
      uint("83", 2),
      uint("9c", 0),
      string("86", "A_OPUS"),
      element("63a2", opusHead),
      uint("56aa", 0),
      uint("56bb", 80_000_000),
      element(
        "e1",
        concat([
          float("b5", options.audioSampleRate),
          uint("9f", options.audioChannels),
        ]),
      ),
    ]),
  );
}

export function buildInitSegment(options: WebMInitOptions): Uint8Array {
  const tracks = element("1654ae6b", concat([videoTrack(options), audioTrack(options)]));
  return concat([ebmlHeader(), master("18538067", [info(options.totalDurationMs), tracks], true)]);
}

function simpleBlock(frame: MuxFrame, clusterTimeMs: number): Uint8Array {
  const relativeMs = Math.max(-32768, Math.min(32767, Math.round(frame.timestampUs / 1000) - clusterTimeMs));
  const header = new Uint8Array(4);
  header[0] = frame.track === "video" ? 0x81 : 0x82;
  new DataView(header.buffer).setInt16(1, relativeMs, false);
  header[3] = frame.track === "video" && frame.keyframe ? 0x80 : 0x00;
  return element("a3", concat([header, frame.data]));
}

export function buildMediaCluster(frames: MuxFrame[], clusterTimeMs: number): Uint8Array {
  const ordered = [...frames].sort((left, right) => {
    if (left.timestampUs !== right.timestampUs) {
      return left.timestampUs - right.timestampUs;
    }
    return left.track === right.track ? 0 : left.track === "video" ? -1 : 1;
  });
  const blocks = ordered.map((frame) => simpleBlock(frame, clusterTimeMs));
  return element("1f43b675", concat([uint("e7", clusterTimeMs), ...blocks]));
}
