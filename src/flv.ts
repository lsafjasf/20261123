import type { AudioTrackInfo, MediaSample, VideoTrackInfo } from "./media.ts";

export interface FlvCallbacks {
  onHeader?: () => void;
  onVideoConfig: (track: VideoTrackInfo) => void;
  onAudioConfig: (track: AudioTrackInfo) => void;
  onSample: (sample: MediaSample) => void;
  onError: (error: Error) => void;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

class BitReader {
  private bit = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const index = this.bit >> 3;
      if (index >= this.data.length) throw new Error("SPS ended early");
      value = value * 2 + ((this.data[index] >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return value;
  }

  ue(): number {
    let zeros = 0;
    while (this.read(1) === 0) {
      if (++zeros > 31) throw new Error("Invalid Exp-Golomb value");
    }
    return (2 ** zeros - 1) + (zeros === 0 ? 0 : this.read(zeros));
  }

  se(): number {
    const value = this.ue();
    return value & 1 ? (value + 1) / 2 : -(value / 2);
  }
}

function dropEmulationPrevention(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let length = 0;
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[length++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, length);
}

function parseSpsDimensions(sps: Uint8Array): { width: number; height: number } | null {
  if (sps.length < 4) return null;
  try {
    const rbsp = dropEmulationPrevention(sps.subarray(1));
    const reader = new BitReader(rbsp);
    const profile = reader.read(8);
    reader.read(16);
    reader.ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const chromaFormat = reader.ue();
      if (chromaFormat === 3) reader.read(1);
      reader.ue();
      reader.ue();
      reader.read(1);
      if (reader.read(1)) {
        const count = chromaFormat === 3 ? 12 : 8;
        for (let i = 0; i < count; i++) {
          if (reader.read(1)) {
            let last = 8;
            let next = 8;
            const size = chromaFormat === 3 ? 6 : 2;
            for (let j = 0; j < size; j++) {
              if (reader.read(1)) last += reader.se();
              if (reader.read(1)) next += reader.se();
            }
          }
        }
      }
    }
    reader.ue();
    const picOrderCntType = reader.ue();
    if (picOrderCntType === 0) {
      reader.ue();
    } else if (picOrderCntType === 1) {
      reader.read(1);
      reader.se();
      reader.se();
      const cycle = reader.ue();
      for (let i = 0; i < cycle; i++) reader.se();
    }
    reader.ue();
    reader.read(1);
    const widthMbs = reader.ue() + 1;
    const heightMapUnits = reader.ue() + 1;
    const frameMbsOnly = reader.read(1);
    if (!frameMbsOnly) reader.read(1);
    reader.read(1);
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (reader.read(1)) {
      cropLeft = reader.ue();
      cropRight = reader.ue();
      cropTop = reader.ue();
      cropBottom = reader.ue();
    }
    const width = widthMbs * 16 - (cropLeft + cropRight) * 2;
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropTop + cropBottom) * 2;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

export function parseAvcConfig(config: Uint8Array): VideoTrackInfo {
  if (config.length < 7) throw new Error("AVC configuration record is too short");
  const profile = config[1];
  const compatibility = config[2];
  const level = config[3];
  const codec = `avc1.${profile.toString(16).padStart(2, "0")}${compatibility
    .toString(16)
    .padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
  let offset = 6;
  const spsCount = config[5] & 0x1f;
  let dimensions: { width: number; height: number } | null = null;
  for (let i = 0; i < spsCount && offset + 2 <= config.length; i++) {
    const length = (config[offset] << 8) | config[offset + 1];
    offset += 2;
    if (offset + length > config.length) break;
    if (!dimensions) dimensions = parseSpsDimensions(config.subarray(offset, offset + length));
    offset += length;
  }
  return {
    codec,
    width: dimensions?.width ?? 1280,
    height: dimensions?.height ?? 720,
    description: Buffer.from(config),
  };
}

export function parseAacConfig(config: Uint8Array): AudioTrackInfo {
  if (config.length < 2) throw new Error("AAC configuration is too short");
  const objectType = config[0] >> 3;
  const rateIndex = ((config[0] & 7) << 1) | (config[1] >> 7);
  const channels = (config[1] >> 3) & 0x0f;
  return {
    codec: `mp4a.40.${objectType}`,
    sampleRate: AAC_RATES[rateIndex] ?? 48000,
    channels: channels || 2,
    description: Buffer.from(config),
  };
}

function soundRate(byte: number): number {
  switch ((byte >> 2) & 3) {
    case 0:
      return 5512;
    case 1:
      return 11025;
    case 2:
      return 22050;
    default:
      return 44100;
  }
}

export class FlvParser {
  private buffer = Buffer.alloc(0);
  private headerDone = false;
  private dataOffset = 9;
  private readonly callbacks: FlvCallbacks;
  private readonly maxFrameBytes: number;

  constructor(callbacks: FlvCallbacks, maxFrameBytes = 4 * 1024 * 1024) {
    this.callbacks = callbacks;
    this.maxFrameBytes = maxFrameBytes;
  }

  feed(chunk: Uint8Array): void {
    if (!chunk.length) return;
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, Buffer.from(chunk)])
      : Buffer.from(chunk);
    try {
      this.parse();
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private parse(): void {
    if (!this.headerDone) {
      if (this.buffer.length < 9) return;
      if (this.buffer.toString("ascii", 0, 3) !== "FLV") throw new Error("Missing FLV signature");
      this.dataOffset = this.buffer.readUInt32BE(5);
      if (this.dataOffset < 9 || this.dataOffset > 4096) throw new Error("Invalid FLV data offset");
      if (this.buffer.length < this.dataOffset + 4) return;
      this.buffer = this.buffer.subarray(this.dataOffset + 4);
      this.headerDone = true;
      this.callbacks.onHeader?.();
    }

    while (this.buffer.length >= 11) {
      const tagType = this.buffer[0];
      const bodyLength = this.buffer.readUIntBE(1, 3);
      if (bodyLength > this.maxFrameBytes) {
        throw new Error(`FLV tag is too large: ${bodyLength} bytes`);
      }
      const total = 11 + bodyLength + 4;
      if (this.buffer.length < total) return;
      const timestamp = this.buffer.readUIntBE(4, 3) | (this.buffer[7] << 24);
      const body = this.buffer.subarray(11, 11 + bodyLength);
      this.buffer = this.buffer.subarray(total);
      if (tagType === 9) parseVideoTag(body, timestamp, this.callbacks);
      else if (tagType === 8) parseAudioTag(body, timestamp, this.callbacks);
    }
  }
}

type TagCallbacks = Pick<FlvCallbacks, "onVideoConfig" | "onAudioConfig" | "onSample">;

export function parseVideoTag(body: Buffer, dts: number, callbacks: TagCallbacks): void {
  if (body.length < 2) return;
  const frameType = body[0] >> 4;
  const codecId = body[0] & 0x0f;
  if (codecId !== 7 || body.length < 5) return;
  const packetType = body[1];
  if (packetType === 0) {
    callbacks.onVideoConfig(parseAvcConfig(body.subarray(5)));
    return;
  }
  if (packetType !== 1) return;
  let composition = (body[2] << 16) | (body[3] << 8) | body[4];
  if (composition & 0x800000) composition -= 0x1000000;
  callbacks.onSample({
    kind: "video",
    ptsMs: dts + composition,
    durationMs: 1000 / 30,
    keyframe: frameType === 1,
    data: Buffer.from(body.subarray(5)),
  });
}

export function parseAudioTag(body: Buffer, timestamp: number, callbacks: TagCallbacks): void {
  if (body.length < 1) return;
  const format = body[0] >> 4;
  const rate = soundRate(body[0]);
  const channels = (body[0] & 1) ? 2 : 1;
  if (format === 10) {
    if (body.length < 3) return;
    if (body[1] === 0) {
      callbacks.onAudioConfig(parseAacConfig(body.subarray(2)));
      return;
    }
    callbacks.onSample({
      kind: "audio",
      ptsMs: timestamp,
      durationMs: (1024 / rate) * 1000,
      keyframe: true,
      data: Buffer.from(body.subarray(2)),
    });
    return;
  }
  if (format === 3) {
    const data = body.subarray(1);
    callbacks.onAudioConfig({
      codec: "pcm-s16",
      sampleRate: rate,
      channels,
      description: Buffer.alloc(0),
    });
    callbacks.onSample({
      kind: "audio",
      ptsMs: timestamp,
      durationMs: (data.length / (channels * 2) / rate) * 1000,
      keyframe: true,
      data: Buffer.from(data),
    });
    return;
  }
  if (format === 2) {
    callbacks.onAudioConfig({
      codec: "mp3",
      sampleRate: rate,
      channels,
      description: Buffer.alloc(0),
    });
    callbacks.onSample({
      kind: "audio",
      ptsMs: timestamp,
      durationMs: 26,
      keyframe: true,
      data: Buffer.from(body.subarray(1)),
    });
  }
}

export function buildFlvHeader(): Buffer {
  const header = Buffer.alloc(13);
  header.write("FLV", 0, "ascii");
  header[3] = 1;
  header[4] = 5;
  header.writeUInt32BE(9, 5);
  return header;
}

export function buildFlvTag(type: number, timestamp: number, body: Uint8Array): Buffer {
  const tag = Buffer.allocUnsafe(11 + body.length + 4);
  tag[0] = type;
  tag.writeUIntBE(body.length, 1, 3);
  tag.writeUIntBE(timestamp & 0xffffff, 4, 3);
  tag[7] = (timestamp >>> 24) & 0xff;
  tag.writeUInt32BE(11 + body.length, 11 + body.length);
  Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(tag, 11);
  return tag;
}
