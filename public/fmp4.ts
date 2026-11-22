export interface MuxTrackConfig {
  kind: "video" | "audio";
  codec: string;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
  description: Uint8Array;
}

export interface MuxSample {
  data: Uint8Array;
  ptsMs: number;
  durationMs: number;
  keyframe: boolean;
}

function u8(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff);
}

function u16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u24(value: number): Uint8Array {
  return Uint8Array.of((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 0x100000000));
  view.setUint32(4, value >>> 0);
  return out;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = concat(parts);
  return concat([u32(payload.length + 8), text(type), payload]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u8(version), u24(flags), ...parts);
}

const IDENTITY_MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

function mvhd(): Uint8Array {
  return fullBox(
    "mvhd", 0, 0,
    u32(0), u32(0), u32(1000), u32(0),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
    IDENTITY_MATRIX, u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(2),
  );
}

function tkhd(kind: "video" | "audio", width: number, height: number): Uint8Array {
  return fullBox(
    "tkhd", 0, 0x000003,
    u32(0), u32(0), u32(1), u32(0), u32(0),
    u32(0), u32(0),
    u16(0), u16(0), u16(kind === "audio" ? 0x0100 : 0), u16(0),
    IDENTITY_MATRIX,
    u32(kind === "video" ? width * 0x10000 : 0),
    u32(kind === "video" ? height * 0x10000 : 0),
  );
}

function mdhd(timescale: number): Uint8Array {
  return fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
}

function hdlr(kind: "video" | "audio"): Uint8Array {
  return fullBox(
    "hdlr", 0, 0,
    u32(0), text(kind === "video" ? "vide" : "soun"),
    u32(0), u32(0), u32(0),
    text(kind === "video" ? "VideoHandler\0" : "SoundHandler\0"),
  );
}

function dinf(): Uint8Array {
  return box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
}

function avc1(config: MuxTrackConfig): Uint8Array {
  const compressor = new Uint8Array(32);
  const name = text("LAN Relay AVC");
  compressor[0] = name.length;
  compressor.set(name, 1);
  return box(
    "avc1",
    new Uint8Array(6), u16(1),
    u16(0), u16(0), new Uint8Array(12),
    u16(config.width), u16(config.height),
    u32(0x00480000), u32(0x00480000), u32(0),
    u16(1), compressor, u16(0x0018), u16(0xffff),
    box("avcC", config.description),
  );
}

function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  const parts: number[] = [];
  let length = payload.length;
  parts.unshift(length & 0x7f);
  while ((length >>>= 7) > 0) parts.unshift((length & 0x7f) | 0x80);
  return concat([u8(tag), Uint8Array.from(parts), payload]);
}

function esds(config: MuxTrackConfig): Uint8Array {
  const decoderSpecific = descriptor(5, config.description);
  const decoderConfig = descriptor(
    4,
    concat([
      u8(0x40), u8(0x15), u24(0), u32(128000), u32(128000),
      decoderSpecific,
    ]),
  );
  const slConfig = descriptor(6, u8(2));
  const esDescriptor = descriptor(3, concat([u16(1), u8(0), decoderConfig, slConfig]));
  return fullBox("esds", 0, 0, esDescriptor);
}

function mp4a(config: MuxTrackConfig): Uint8Array {
  return box(
    "mp4a",
    new Uint8Array(6), u16(1),
    new Uint8Array(8),
    u16(config.channels), u16(16), u16(0), u16(0),
    u32(Math.min(config.sampleRate, 0xffff) * 0x10000),
    esds(config),
  );
}

function stbl(config: MuxTrackConfig): Uint8Array {
  return box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), config.kind === "video" ? avc1(config) : mp4a(config)),
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)),
    fullBox("stco", 0, 0, u32(0)),
  );
}

function trak(config: MuxTrackConfig): Uint8Array {
  const header = config.kind === "video" ? fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)) : fullBox("smhd", 0, 0, u16(0), u16(0));
  return box(
    "trak",
    tkhd(config.kind, config.width, config.height),
    box("mdia", mdhd(timescale(config)), hdlr(config.kind), box("minf", header, dinf(), stbl(config))),
  );
}

function timescale(config: MuxTrackConfig): number {
  return config.kind === "video" ? 90000 : config.sampleRate;
}

export class Fmp4Track {
  readonly config: MuxTrackConfig;
  readonly mime: string;
  private sequence = 1;

  constructor(config: MuxTrackConfig) {
    this.config = config;
    this.mime = config.kind === "video" ? `video/mp4; codecs="${config.codec}"` : `audio/mp4; codecs="${config.codec}"`;
  }

  initSegment(): Uint8Array {
    return concat([
      box("ftyp", text("isom"), u32(0x200), text("isom"), text("iso6"), text("mp41")),
      box(
        "moov",
        mvhd(),
        trak(this.config),
        box("mvex", fullBox("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0))),
      ),
    ]);
  }

  fragment(sample: MuxSample, relativePtsMs: number): Uint8Array {
    const scale = timescale(this.config);
    const duration = Math.max(1, Math.round((sample.durationMs > 0 ? sample.durationMs : 33.333) * scale / 1000));
    const decodeTime = Math.max(0, Math.round(relativePtsMs * scale / 1000));
    const flags = this.config.kind === "video" && !sample.keyframe ? 0x01010000 : 0x02000000;
    const makeMoof = (dataOffset: number): Uint8Array =>
      box(
        "moof",
        fullBox("mfhd", 0, 0, u32(this.sequence)),
        box(
          "traf",
          fullBox("tfhd", 0, 0x020000, u32(1)),
          fullBox("tfdt", 1, 0, u64(decodeTime)),
          fullBox(
            "trun", 0, 0x000701,
            u32(1),
            u32(dataOffset),
            u32(duration),
            u32(sample.data.length),
            u32(flags),
          ),
        ),
      );
    const first = makeMoof(0);
    const moof = makeMoof(first.length + 8);
    const mdat = box("mdat", sample.data);
    this.sequence++;
    return concat([moof, mdat]);
  }
}
