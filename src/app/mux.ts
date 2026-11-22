// Minimal fragmented-MP4 muxer (single video track, avc1, one fragment).
// Produces an init segment (ftyp+moov) and a media segment (moof+mdat)
// suitable for MediaSource and for download as a plain .mp4 file.

function u8(n: number): Uint8Array { return new Uint8Array(n); }

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  let size = 8;
  for (const p of parts) size += p.length;
  const out = u8(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]) {
  const h = u8(4);
  h[0] = version;
  h[1] = (flags >> 16) & 0xff;
  h[2] = (flags >> 8) & 0xff;
  h[3] = flags & 0xff;
  return box(type, h, ...parts);
}

function be32(...nums: number[]): Uint8Array {
  const out = u8(4 * nums.length);
  const v = new DataView(out.buffer);
  nums.forEach((n, i) => v.setUint32(i * 4, n >>> 0));
  return out;
}

function be16(...nums: number[]): Uint8Array {
  const out = u8(2 * nums.length);
  const v = new DataView(out.buffer);
  nums.forEach((n, i) => v.setUint16(i * 2, n & 0xffff));
  return out;
}

function str(s: string): Uint8Array {
  const out = u8(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export interface MuxSample {
  data: Uint8Array;
  duration: number;  // in track timescale units
  ctsOffset: number; // pts - dts, in track timescale units
  keyframe: boolean;
}

export interface MuxConfig {
  codec: string;          // e.g. "avc1.64001f"
  width: number;
  height: number;
  timescale: number;      // e.g. 90000
  description: Uint8Array; // avcC payload
}

const VIDEO_HDLR = (() => {
  const h = u8(20); // pre_defined(4) + handler_type(4) + reserved(12)
  h[4] = 0x76; h[5] = 0x69; h[6] = 0x64; h[7] = 0x65; // "vide"
  return fullBox("hdlr", 0, 0, h, str("VideoHandler\0"));
})();

function avc1Box(cfg: MuxConfig): Uint8Array {
  const entry = u8(78);
  const v = new DataView(entry.buffer);
  v.setUint16(6, 1);            // data_reference_index
  v.setUint16(24, cfg.width);
  v.setUint16(26, cfg.height);
  v.setUint32(28, 0x00480000);  // horizresolution 72dpi
  v.setUint32(32, 0x00480000);
  v.setUint16(40, 1);           // frame_count
  v.setUint16(74, 0x0018);      // depth 24
  v.setInt16(76, -1);
  return box("avc1", entry, box("avcC", cfg.description));
}

export function initSegment(cfg: MuxConfig): Uint8Array {
  const ftyp = box("ftyp", str("isom"), be32(1), str("isom"), str("iso6"), str("avc1"), str("mp41"));
  const mvhd = fullBox("mvhd", 0, 0,
    be32(0, 0, 1000, 0), be32(0x00010000, 0x0100, 0),
    u8(10),
    be32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000),
    u8(24), be32(2));
  const tkhd = fullBox("tkhd", 0, 7,
    be32(0, 0, 1, 0, 0), u8(8),
    be16(0, 0, 0),
    be32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000),
    be32(cfg.width << 16, cfg.height << 16));
  const mdhd = fullBox("mdhd", 0, 0, be32(0, 0, cfg.timescale, 0), be16(0x55c4, 0));
  const vmhd = fullBox("vmhd", 0, 1, be16(0, 0, 0, 0));
  const dref = fullBox("dref", 0, 0, be32(1), fullBox("url ", 0, 1));
  const dinf = box("dinf", dref);
  const stsd = fullBox("stsd", 0, 0, be32(1), avc1Box(cfg));
  const stbl = box("stbl", stsd,
    fullBox("stts", 0, 0, be32(0)),
    fullBox("stsc", 0, 0, be32(0)),
    fullBox("stsz", 0, 0, be32(0, 0)),
    fullBox("stco", 0, 0, be32(0)));
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, VIDEO_HDLR, minf);
  const trak = box("trak", tkhd, mdia);
  const trex = fullBox("trex", 0, 0, be32(1, 1, 0, 0, 0));
  const mvex = box("mvex", trex);
  const moov = box("moov", mvhd, trak, mvex);
  return concat(ftyp, moov);
}

export function mediaSegment(samples: MuxSample[], baseDecodeTime: number): Uint8Array {
  const mfhd = fullBox("mfhd", 0, 0, be32(1));
  const tfhd = fullBox("tfhd", 0, 0x020000, be32(1)); // default-base-is-moof
  const tfdt = fullBox("tfdt", 1, 0, be32(Math.floor(baseDecodeTime / 2 ** 32), baseDecodeTime >>> 0));
  const trunData = u8(8 + samples.length * 16);
  const tv = new DataView(trunData.buffer);
  tv.setUint32(0, samples.length);
  let o = 8;
  for (const s of samples) {
    tv.setUint32(o, s.duration);
    tv.setUint32(o + 4, s.data.length);
    tv.setUint32(o + 8, s.keyframe ? 0x02000000 : 0x01010000);
    tv.setInt32(o + 12, s.ctsOffset);
    o += 16;
  }
  const trun = fullBox("trun", 1, 0x000f01, trunData);
  const traf = box("traf", tfhd, tfdt, trun);
  const moof = box("moof", mfhd, traf);
  const mdatPayload = concat(...samples.map(s => s.data));
  const mdat = box("mdat", mdatPayload);
  // Patch data_offset (moof start -> mdat payload). Layout inside moof:
  // moof hdr(8) mfhd(16) traf hdr(8) tfhd(16) tfdt(20) trun hdr(8+4)
  // then sample_count(4) and data_offset(4).
  const dataOffsetPos = 8 + 16 + 8 + 16 + 20 + 12 + 4;
  new DataView(moof.buffer).setUint32(dataOffsetPos, moof.length + 8);
  return concat(moof, mdat);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = u8(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function concatSegments(...parts: Uint8Array[]): Uint8Array {
  return concat(...parts);
}
