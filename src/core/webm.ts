export interface EncodedVideoSample {
  timestampUs: number;
  durationUs: number;
  key: boolean;
  data: Uint8Array;
}

export interface WebmOptions {
  width: number;
  height: number;
  codec: "vp8" | "vp9";
  durationUs: number;
  frameRate: number;
}

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function idBytes(hex: string): Uint8Array {
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function sizeVint(value: number): Uint8Array {
  let length = 1;
  while (length < 8 && value >= 2 ** (7 * length) - 1) length += 1;
  const output = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  output[0] |= 1 << (8 - length);
  return output;
}

function uintBytes(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

function element(id: string, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), sizeVint(payload.length), payload]);
}

function uintElement(id: string, value: number): Uint8Array {
  return element(id, uintBytes(value));
}

function stringElement(id: string, value: string): Uint8Array {
  return element(id, encoder.encode(value));
}

function float64Element(id: string, value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return element(id, bytes);
}

function int16(value: number): Uint8Array {
  const output = new Uint8Array(2);
  new DataView(output.buffer).setInt16(0, value, false);
  return output;
}

function cluster(timecode: number, blocks: Uint8Array[]): Uint8Array {
  return element("1F43B675", concat([uintElement("E7", timecode), ...blocks]));
}

export function muxWebm(samples: EncodedVideoSample[], options: WebmOptions): Uint8Array {
  if (samples.length === 0) throw new Error("Cannot mux an empty video");
  const header = element(
    "1A45DFA3",
    concat([
      uintElement("4286", 1),
      uintElement("42F7", 1),
      uintElement("42F2", 4),
      uintElement("42F3", 8),
      stringElement("4282", "webm"),
      uintElement("4287", 4),
      uintElement("4285", 2)
    ])
  );

  const info = element(
    "1549A966",
    concat([
      uintElement("2AD7B1", 1_000_000),
      stringElement("4D80", "frame-lens"),
      stringElement("5741", "frame-lens"),
      float64Element("4489", options.durationUs / 1000)
    ])
  );

  const video = element(
    "E0",
    concat([
      uintElement("B0", options.width),
      uintElement("BA", options.height)
    ])
  );
  const track = element(
    "AE",
    concat([
      uintElement("D7", 1),
      uintElement("73C5", 1),
      uintElement("83", 1),
      stringElement("86", options.codec === "vp9" ? "V_VP9" : "V_VP8"),
      uintElement("23E383", Math.round(1_000_000_000 / options.frameRate)),
      video
    ])
  );
  const tracks = element("1654AE6B", track);

  const clusters: Uint8Array[] = [];
  let blockBuffer: Uint8Array[] = [];
  let clusterStart = Math.floor(samples[0].timestampUs / 1000);
  for (const sample of samples) {
    const timestamp = Math.floor(sample.timestampUs / 1000);
    if (timestamp - clusterStart > 30_000 && blockBuffer.length > 0) {
      clusters.push(cluster(clusterStart, blockBuffer));
      blockBuffer = [];
      clusterStart = timestamp;
    }
    const relative = timestamp - clusterStart;
    const flags = sample.key ? 0x80 : 0;
    const block = element(
      "A3",
      concat([Uint8Array.of(0x81), int16(relative), Uint8Array.of(flags), sample.data])
    );
    blockBuffer.push(block);
  }
  if (blockBuffer.length > 0) clusters.push(cluster(clusterStart, blockBuffer));

  const segment = element("18538067", concat([info, tracks, ...clusters]));
  return concat([header, segment]);
}
