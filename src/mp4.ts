// 极简 MP4 / 碎片化 MP4 (fMP4) 复用器与解析器。
// 仅依赖 Uint8Array/DataView，Node 与浏览器通用。
// 时间戳一律为整数 tick（BigInt），写入什么读出什么，不经过浮点秒。

export class ByteWriter {
  private parts: Uint8Array[] = [];
  private len = 0;

  u8(v: number): this {
    this.parts.push(Uint8Array.of(v & 0xff));
    this.len += 1;
    return this;
  }
  u16(v: number): this {
    return this.bytes(Uint8Array.of((v >>> 8) & 0xff, v & 0xff));
  }
  u24(v: number): this {
    return this.bytes(
      Uint8Array.of((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff),
    );
  }
  u32(v: number): this {
    return this.bytes(
      Uint8Array.of(
        (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff,
      ),
    );
  }
  i32(v: number): this {
    return this.u32(v >>> 0);
  }
  u64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, false);
    return this.bytes(b);
  }
  str(s: string): this {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return this.bytes(b);
  }
  bytes(b: Uint8Array): this {
    this.parts.push(b);
    this.len += b.length;
    return this;
  }
  get length(): number {
    return this.len;
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

export function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const w = new ByteWriter();
  let size = 8;
  for (const p of payloads) size += p.length;
  w.u32(size).str(type);
  for (const p of payloads) w.bytes(p);
  return w.concat();
}

export function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payloads: Uint8Array[]
): Uint8Array {
  const w = new ByteWriter();
  w.u8(version).u24(flags);
  for (const p of payloads) w.bytes(p);
  return box(type, w.concat());
}

export function concatAll(parts: Uint8Array[]): Uint8Array {
  const w = new ByteWriter();
  for (const p of parts) w.bytes(p);
  return w.concat();
}

// ---------------- 初始化段（ftyp + moov） ----------------

export interface TrackInit {
  id: number;
  kind: "video" | "audio";
  timescale: number;
  width?: number; // video
  height?: number; // video
  avcC?: Uint8Array; // video: AVCDecoderConfigurationRecord
  audioSpecificConfig?: Uint8Array; // audio
  sampleRate?: number; // audio
  channels?: number; // audio
}

export const MOVIE_TIMESCALE = 1000;

function ftyp(): Uint8Array {
  const w = new ByteWriter();
  w.str("isom").u32(0x200).str("isom").str("iso6").str("avc1").str("mp41");
  return box("ftyp", w.concat());
}

function mvhd(): Uint8Array {
  const w = new ByteWriter();
  w.u32(0).u32(0); // creation/modification time
  w.u32(MOVIE_TIMESCALE).u32(0); // timescale, duration=0（fMP4 由片段决定）
  w.u32(0x00010000).u16(0x0100).u16(0); // rate, volume, reserved
  w.u32(0).u32(0); // reserved
  // unity matrix
  w.u32(0x00010000).u32(0).u32(0);
  w.u32(0).u32(0x00010000).u32(0);
  w.u32(0).u32(0).u32(0x40000000);
  for (let i = 0; i < 6; i++) w.u32(0); // pre_defined
  w.u32(0xffffffff); // next_track_ID（占位）
  return fullBox("mvhd", 0, 0, w.concat());
}

function tkhd(t: TrackInit): Uint8Array {
  const w = new ByteWriter();
  w.u32(0).u32(0); // creation/modification
  w.u32(t.id).u32(0); // track_ID, reserved
  w.u32(0); // duration = 0
  w.u32(0).u32(0); // reserved
  w.u16(0).u16(0); // layer, alternate_group
  w.u16(t.kind === "audio" ? 0x0100 : 0).u16(0); // volume, reserved
  w.u32(0x00010000).u32(0).u32(0);
  w.u32(0).u32(0x00010000).u32(0);
  w.u32(0).u32(0).u32(0x40000000);
  w.u32((t.width ?? 0) << 16).u32((t.height ?? 0) << 16); // 16.16 定点
  // flags: in_movie(0x2) | in_preview(0x4) 不需要；enabled(0x1) 即可
  return fullBox("tkhd", 0, 0x1, w.concat());
}

function mdhd(t: TrackInit): Uint8Array {
  const w = new ByteWriter();
  w.u32(0).u32(0); // creation/modification
  w.u32(t.timescale).u32(0); // timescale, duration=0
  w.u16(0x55c4).u16(0); // language 'und', pre_defined
  return fullBox("mdhd", 0, 0, w.concat());
}

function hdlr(t: TrackInit): Uint8Array {
  const w = new ByteWriter();
  w.u32(0); // pre_defined
  w.str(t.kind === "video" ? "vide" : "soun");
  w.u32(0).u32(0).u32(0); // reserved
  w.str(t.kind === "video" ? "VideoHandler\0" : "SoundHandler\0");
  return fullBox("hdlr", 0, 0, w.concat());
}

function avc1(t: TrackInit): Uint8Array {
  const w = new ByteWriter();
  w.u32(0).u16(0).u16(1); // reserved, reserved, data_reference_index
  w.u16(0).u16(0); // pre_defined, reserved
  w.u32(0).u32(0).u32(0); // pre_defined
  w.u16(t.width!).u16(t.height!);
  w.u32(0x00480000).u32(0x00480000); // 72dpi
  w.u32(0); // reserved
  w.u16(1); // frame_count
  const name = new Uint8Array(32); // compressorname
  w.bytes(name);
  w.u16(0x0018).u16(0xffff); // depth, pre_defined
  w.bytes(box("avcC", t.avcC!));
  return box("avc1", w.concat());
}

function esds(t: TrackInit): Uint8Array {
  const asc = t.audioSpecificConfig!;
  const w = new ByteWriter();
  const esBody = new ByteWriter();
  esBody.u16(t.id).u8(0); // ES_ID, flags
  const dcd = new ByteWriter();
  dcd.u8(0x40).u8(0x15); // objectTypeIndication=AAC, streamType=audio
  dcd.u24(0).u32(0).u32(0); // bufferSizeDB, max/avg bitrate
  const dsi = new ByteWriter();
  dsi.u8(0x05).u8(asc.length).bytes(asc); // DecoderSpecificInfo
  dcd.bytes(dsi.concat());
  const dcdBytes = dcd.concat();
  esBody.u8(0x04).u8(dcdBytes.length).bytes(dcdBytes);
  esBody.u8(0x06).u8(1).u8(0x02); // SLConfigDescriptor predefined=2
  const esBytes = esBody.concat();
  w.u8(0x03).u8(esBytes.length).bytes(esBytes); // ES_Descriptor
  return fullBox("esds", 0, 0, w.concat());
}

function mp4a(t: TrackInit): Uint8Array {
  const w = new ByteWriter();
  w.u32(0).u16(0).u16(1); // reserved, reserved, data_reference_index
  w.u32(0).u32(0); // reserved
  w.u16(t.channels ?? 1).u16(16); // channelcount, samplesize
  w.u16(0).u16(0); // pre_defined, reserved
  w.u32((t.sampleRate ?? 44100) << 16); // samplerate 16.16
  w.bytes(esds(t));
  return box("mp4a", w.concat());
}

function stbl(t: TrackInit): Uint8Array {
  const stsd = fullBox(
    "stsd", 0, 0,
    new ByteWriter().u32(1).concat(),
    t.kind === "video" ? avc1(t) : mp4a(t),
  );
  const empty = (name: string) => fullBox(name, 0, 0, new ByteWriter().u32(0).concat());
  return box(
    "stbl",
    stsd,
    empty("stts"),
    empty("stsc"),
    fullBox("stsz", 0, 0, new ByteWriter().u32(0).u32(0).concat()),
    empty("stco"),
  );
}

function minf(t: TrackInit): Uint8Array {
  const mediaHeader =
    t.kind === "video"
      ? fullBox("vmhd", 0, 1, new ByteWriter().u16(0).u16(0).u16(0).u16(0).concat())
      : fullBox("smhd", 0, 0, new ByteWriter().u16(0).u16(0).concat());
  const dref = fullBox(
    "dref", 0, 0,
    new ByteWriter().u32(1).concat(),
    fullBox("url ", 0, 1),
  );
  return box("minf", mediaHeader, box("dinf", dref), stbl(t));
}

function mdia(t: TrackInit): Uint8Array {
  return box("mdia", mdhd(t), hdlr(t), minf(t));
}

function trak(t: TrackInit): Uint8Array {
  return box("trak", tkhd(t), mdia(t));
}

// trex：声明轨道存在碎片样本（默认值均为 0，实际值在 trun 中给出）。
function trex(t: TrackInit): Uint8Array {
  const w = new ByteWriter();
  w.u32(t.id).u32(1).u32(0).u32(0).u32(0);
  return fullBox("trex", 0, 0, w.concat());
}

// ftyp + moov，可作为 MSE 初始化段。
export function makeInitSegment(tracks: TrackInit[]): Uint8Array {
  const mvex = box("mvex", ...tracks.map(trex));
  const moov = box("moov", mvhd(), ...tracks.map(trak), mvex);
  return concatAll([ftyp(), moov]);
}

// ---------------- 媒体片段（moof + mdat） ----------------

export interface SampleInput {
  data: Uint8Array;
  duration: number; // 本轨 timescale 的 tick
  cto?: number; // composition time offset，默认 0
  isSync?: boolean; // 默认 true（本工程全部样本为关键帧/独立帧）
}

export interface FragmentTrack {
  trackId: number;
  baseDecodeTime: bigint; // tfdt，本轨 timescale 的 tick
  samples: SampleInput[];
}

export interface FragmentInput {
  sequenceNumber: number;
  tracks: FragmentTrack[];
}

function mfhd(seq: number): Uint8Array {
  return fullBox("mfhd", 0, 0, new ByteWriter().u32(seq).concat());
}

// tfhd: default-base-is-moof，样本参数全部在 trun 中显式给出。
function tfhd(trackId: number): Uint8Array {
  return fullBox("tfhd", 0, 0x020000, new ByteWriter().u32(trackId).concat());
}

function tfdt(baseDecodeTime: bigint): Uint8Array {
  return fullBox("tfdt", 1, 0, new ByteWriter().u64(baseDecodeTime).concat());
}

const TRUN_FLAGS = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;

function trun(ft: FragmentTrack, dataOffset: number): Uint8Array {
  const w = new ByteWriter();
  w.u32(ft.samples.length);
  w.i32(dataOffset);
  for (const s of ft.samples) {
    w.u32(s.duration);
    w.u32(s.data.length);
    w.u32(s.isSync === false ? 0x00010000 : 0x02000000);
    w.u32(s.cto ?? 0);
  }
  return fullBox("trun", 0, TRUN_FLAGS, w.concat());
}

// 生成一个 moof+mdat 对。trun 的 data_offset 相对 moof 起点
// （配合 tfhd 的 default-base-is-moof）。
export function makeFragment(frag: FragmentInput): Uint8Array {
  // 先算 moof 长度：traf 数与 trun 长度已知（data_offset 字段定长）
  // tfhd=16, tfdt(v1)=20, trun 头=8+4+4+4=20
  const trafHeaderLen = 16 + 20 + 20;
  let moofLen = 8 + 16; // moof 头 + mfhd(头8 + v/f4 + seq4)
  for (const ft of frag.tracks) {
    moofLen += 8 + trafHeaderLen + ft.samples.length * 16;
  }
  const mdatHeaderLen = 8;
  const trafs: Uint8Array[] = [];
  const mdat = new ByteWriter();
  let dataOffset = moofLen + mdatHeaderLen;
  for (const ft of frag.tracks) {
    trafs.push(
      box("traf", tfhd(ft.trackId), tfdt(ft.baseDecodeTime), trun(ft, dataOffset)),
    );
    for (const s of ft.samples) {
      mdat.bytes(s.data);
      dataOffset += s.data.length;
    }
  }
  const moof = box("moof", mfhd(frag.sequenceNumber), ...trafs);
  if (moof.length !== moofLen) {
    throw new Error(`moof 长度预估错误: ${moof.length} != ${moofLen}`);
  }
  const mdatBox = box("mdat", mdat.concat());
  return concatAll([moof, mdatBox]);
}

// 便捷：完整 fMP4 文件 = 初始化段 + 若干片段。
export function makeFragmentedMp4(
  tracks: TrackInit[],
  fragments: FragmentInput[],
): Uint8Array {
  const parts = [makeInitSegment(tracks)];
  for (const f of fragments) parts.push(makeFragment(f));
  return concatAll(parts);
}

// ---------------- 解析器 ----------------

export interface BoxHeader {
  type: string;
  start: number; // box 起始（含头）
  size: number; // 整盒长度
  headerSize: number;
}

export function* walkBoxes(
  data: Uint8Array,
  start: number,
  end: number,
): Generator<BoxHeader> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
    );
    let headerSize = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) {
      throw new Error(`坏 box: ${type} @${pos} size=${size}`);
    }
    yield { type, start: pos, size, headerSize };
    pos += size;
  }
}

function findChild(
  data: Uint8Array,
  parent: BoxHeader,
  type: string,
): BoxHeader | undefined {
  const bodyStart = parent.start + parent.headerSize;
  for (const b of walkBoxes(data, bodyStart, parent.start + parent.size)) {
    if (b.type === type) return b;
  }
  return undefined;
}

function findChildren(
  data: Uint8Array,
  parent: BoxHeader,
  type: string,
): BoxHeader[] {
  const out: BoxHeader[] = [];
  const bodyStart = parent.start + parent.headerSize;
  for (const b of walkBoxes(data, bodyStart, parent.start + parent.size)) {
    if (b.type === type) out.push(b);
  }
  return out;
}

function childPayload(data: Uint8Array, b: BoxHeader): Uint8Array {
  return data.subarray(b.start + b.headerSize, b.start + b.size);
}

export interface SampleInfo {
  dts: bigint; // 本轨 timescale tick
  cts: bigint;
  duration: number;
  size: number;
  sync: boolean;
  dataOffset: number; // 文件内绝对偏移
}

export interface TrackSamples {
  trackId: number;
  kind: "video" | "audio" | "other";
  timescale: number;
  codec: string;
  avcC?: Uint8Array; // 视频：avcC 盒载荷
  width?: number;
  height?: number;
  audioSpecificConfig?: Uint8Array; // 音频：esds 中的 ASC
  sampleRate?: number;
  channels?: number;
  samples: SampleInfo[];
}

export interface Mp4Info {
  fragmented: boolean;
  tracks: TrackSamples[];
}

interface StblData {
  codec: string;
  codecConfig?: Uint8Array; // avcC 载荷或 ASC
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  stts: { count: number; delta: number }[];
  ctts: { count: number; offset: number }[];
  stsc: { firstChunk: number; samplesPerChunk: number; descIndex: number }[];
  stsz: number[];
  stco: number[];
}

// 在 esds 描述符树中取 DecoderSpecificInfo (tag 0x05) 的载荷。
function extractAsc(esdsPayload: Uint8Array): Uint8Array | undefined {
  let i = 4; // 跳过 fullbox 版本/标志
  while (i + 2 <= esdsPayload.length) {
    const tag = esdsPayload[i];
    let len = esdsPayload[i + 1];
    let hdr = 2;
    if (len === 0x80) return undefined; // 不支持长格式，放弃
    if (tag === 0x05) {
      return esdsPayload.subarray(i + hdr, i + hdr + len);
    }
    // 进入嵌套描述符（0x03 ES_Descriptor / 0x04 DecoderConfigDescriptor）
    if (tag === 0x03) {
      i += hdr + 3; // ES_ID(2) + flags(1)
      continue;
    }
    if (tag === 0x04) {
      i += hdr + 13; // objectType+streamType+bufferSize+max/avgBitrate
      continue;
    }
    i += hdr + len;
  }
  return undefined;
}

// 解析 stsd 第一个样本条目，提取编解码私有数据。
function parseSampleEntry(data: Uint8Array, stsd: BoxHeader, out: StblData): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entry = stsd.start + stsd.headerSize + 8; // 跳过 v/f + entry_count
  if (entry + 8 > stsd.start + stsd.size) return;
  const codec = String.fromCharCode(
    data[entry + 4], data[entry + 5], data[entry + 6], data[entry + 7],
  );
  out.codec = codec;
  if (codec === "avc1" || codec === "avc3") {
    out.width = view.getUint16(entry + 32);
    out.height = view.getUint16(entry + 34);
    const childStart = entry + 8 + 78;
    for (const b of walkBoxes(data, childStart, entry + view.getUint32(entry))) {
      if (b.type === "avcC") {
        out.codecConfig = childPayload(data, b).slice();
      }
    }
  } else if (codec === "mp4a") {
    out.channels = view.getUint16(entry + 24);
    out.sampleRate = view.getUint32(entry + 32) >>> 16;
    const childStart = entry + 8 + 28;
    for (const b of walkBoxes(data, childStart, entry + view.getUint32(entry))) {
      if (b.type === "esds") {
        out.codecConfig = extractAsc(childPayload(data, b));
      }
    }
  }
}

function parseStbl(data: Uint8Array, stbl: BoxHeader): StblData {
  const out: StblData = {
    codec: "unknown", stts: [], ctts: [], stsc: [], stsz: [], stco: [],
  };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stsd = findChild(data, stbl, "stsd");
  if (stsd) {
    parseSampleEntry(data, stsd, out);
  }
  const stts = findChild(data, stbl, "stts");
  if (stts) {
    const p = stts.start + stts.headerSize + 4;
    const n = view.getUint32(p);
    for (let i = 0; i < n; i++) {
      out.stts.push({
        count: view.getUint32(p + 4 + i * 8),
        delta: view.getUint32(p + 8 + i * 8),
      });
    }
  }
  const ctts = findChild(data, stbl, "ctts");
  if (ctts) {
    const p = ctts.start + ctts.headerSize + 4;
    const n = view.getUint32(p);
    for (let i = 0; i < n; i++) {
      out.ctts.push({
        count: view.getUint32(p + 4 + i * 8),
        offset: view.getUint32(p + 8 + i * 8),
      });
    }
  }
  const stsc = findChild(data, stbl, "stsc");
  if (stsc) {
    const p = stsc.start + stsc.headerSize + 4;
    const n = view.getUint32(p);
    for (let i = 0; i < n; i++) {
      out.stsc.push({
        firstChunk: view.getUint32(p + 4 + i * 12),
        samplesPerChunk: view.getUint32(p + 8 + i * 12),
        descIndex: view.getUint32(p + 12 + i * 12),
      });
    }
  }
  const stsz = findChild(data, stbl, "stsz");
  if (stsz) {
    const p = stsz.start + stsz.headerSize + 4;
    const sampleSize = view.getUint32(p);
    const n = view.getUint32(p + 4);
    for (let i = 0; i < n; i++) {
      out.stsz.push(sampleSize !== 0 ? sampleSize : view.getUint32(p + 8 + i * 4));
    }
  }
  const stco = findChild(data, stbl, "stco") ?? findChild(data, stbl, "co64");
  if (stco) {
    const wide = stco.type === "co64";
    const p = stco.start + stco.headerSize + 4;
    const n = view.getUint32(p);
    for (let i = 0; i < n; i++) {
      out.stco.push(
        wide
          ? Number(view.getBigUint64(p + 4 + i * 8))
          : view.getUint32(p + 4 + i * 4),
      );
    }
  }
  return out;
}

function samplesFromStbl(st: StblData): SampleInfo[] {
  const durations: number[] = [];
  for (const e of st.stts) {
    for (let i = 0; i < e.count; i++) durations.push(e.delta);
  }
  const ctos: number[] = new Array(durations.length).fill(0);
  let ci = 0;
  for (const e of st.ctts) {
    for (let i = 0; i < e.count && ci < ctos.length; i++, ci++) ctos[ci] = e.offset;
  }
  // stsc -> 每样本所在 chunk 与 chunk 内序号
  const offsets: number[] = new Array(durations.length).fill(0);
  let sampleIndex = 0;
  for (let chunk = 1; chunk <= st.stco.length; chunk++) {
    let spc = 0;
    for (let e = 0; e < st.stsc.length; e++) {
      const next = e + 1 < st.stsc.length ? st.stsc[e + 1].firstChunk : Infinity;
      if (st.stsc[e].firstChunk <= chunk && chunk < next) spc = st.stsc[e].samplesPerChunk;
    }
    let off = st.stco[chunk - 1];
    for (let i = 0; i < spc && sampleIndex < durations.length; i++, sampleIndex++) {
      offsets[sampleIndex] = off;
      off += st.stsz[sampleIndex];
    }
  }
  const samples: SampleInfo[] = [];
  let dts = 0n;
  for (let i = 0; i < durations.length; i++) {
    samples.push({
      dts,
      cts: dts + BigInt(ctos[i]),
      duration: durations[i],
      size: st.stsz[i],
      sync: true,
      dataOffset: offsets[i],
    });
    dts += BigInt(durations[i]);
  }
  return samples;
}

interface MoofTrackRun {
  trackId: number;
  baseDecodeTime: bigint;
  samples: SampleInfo[];
}

function parseMoof(
  data: Uint8Array,
  moof: BoxHeader,
  byTrackId: Map<number, TrackSamples>,
): MoofTrackRun[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const runs: MoofTrackRun[] = [];
  for (const traf of findChildren(data, moof, "traf")) {
    const tfhd = findChild(data, traf, "tfhd");
    if (!tfhd) continue;
    let p = tfhd.start + tfhd.headerSize;
    const tfFlags = view.getUint32(p) & 0xffffff;
    p += 4;
    const trackId = view.getUint32(p);
    p += 4;
    let baseDataOffset: bigint | undefined;
    let defaultDuration = 0;
    let defaultSize = 0;
    let defaultFlags = 0;
    if (tfFlags & 0x000001) {
      baseDataOffset = view.getBigUint64(p);
      p += 8;
    }
    if (tfFlags & 0x000008) p += 4; // sample_description_index
    if (tfFlags & 0x000010) {
      defaultDuration = view.getUint32(p);
      p += 4;
    }
    if (tfFlags & 0x000020) {
      defaultSize = view.getUint32(p);
      p += 4;
    }
    if (tfFlags & 0x000040) {
      defaultFlags = view.getUint32(p);
      p += 4;
    }
    const defaultBaseIsMoof = (tfFlags & 0x020000) !== 0;

    let baseDecodeTime = 0n;
    const tfdt = findChild(data, traf, "tfdt");
    if (tfdt) {
      const tp = tfdt.start + tfdt.headerSize;
      const version = data[tp];
      baseDecodeTime =
        version === 1
          ? view.getBigUint64(tp + 4)
          : BigInt(view.getUint32(tp + 4));
    }

    const track = byTrackId.get(trackId);
    const run: MoofTrackRun = { trackId, baseDecodeTime, samples: [] };
    let dts = baseDecodeTime;
    for (const trunBox of findChildren(data, traf, "trun")) {
      let q = trunBox.start + trunBox.headerSize;
      const version = data[q];
      const trFlags = view.getUint32(q) & 0xffffff;
      q += 4;
      const count = view.getUint32(q);
      q += 4;
      let dataOffset: bigint | undefined;
      if (trFlags & 0x000001) {
        dataOffset = BigInt(view.getInt32(q));
        q += 4;
      }
      if (trFlags & 0x000004) q += 4; // first_sample_flags
      const hasDur = (trFlags & 0x000100) !== 0;
      const hasSize = (trFlags & 0x000200) !== 0;
      const hasFlags = (trFlags & 0x000400) !== 0;
      const hasCto = (trFlags & 0x000800) !== 0;
      let absData: number;
      if (dataOffset !== undefined) {
        const base = baseDataOffset ?? (defaultBaseIsMoof ? BigInt(moof.start) : 0n);
        absData = Number(base + dataOffset);
      } else {
        absData = Number(baseDataOffset ?? 0n);
      }
      for (let i = 0; i < count; i++) {
        const dur = hasDur ? view.getUint32(q) : defaultDuration;
        if (hasDur) q += 4;
        const size = hasSize ? view.getUint32(q) : defaultSize;
        if (hasSize) q += 4;
        const flags = hasFlags ? view.getUint32(q) : defaultFlags;
        if (hasFlags) q += 4;
        let cto = 0;
        if (hasCto) {
          cto = version === 1 ? view.getInt32(q) : view.getUint32(q);
          q += 4;
        }
        run.samples.push({
          dts,
          cts: dts + BigInt(cto),
          duration: dur,
          size,
          sync: (flags & 0x00010000) === 0,
          dataOffset: absData,
        });
        dts += BigInt(dur);
        absData += size;
      }
    }
    if (track) track.samples.push(...run.samples);
    runs.push(run);
  }
  return runs;
}

// 解析整个文件：moov 中收集轨道元数据与（非碎片场景的）样本表，
// moof 中收集碎片样本。返回的 dts/cts 均为整数 tick。
export function parseMp4(data: Uint8Array): Mp4Info {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const byTrackId = new Map<number, TrackSamples>();
  const order: TrackSamples[] = [];
  let fragmented = false;

  for (const top of walkBoxes(data, 0, data.length)) {
    if (top.type === "moov") {
      for (const trak of findChildren(data, top, "trak")) {
        const tkhd = findChild(data, trak, "tkhd");
        const mdia = findChild(data, trak, "mdia");
        if (!tkhd || !mdia) continue;
        const tp = tkhd.start + tkhd.headerSize;
        const trackId = view.getUint32(tp + 4 + 8); // version0: vf+cre+mod
        const mdhd = findChild(data, mdia, "mdhd");
        const hdlr = findChild(data, mdia, "hdlr");
        const minf = findChild(data, mdia, "minf");
        const timescale = mdhd
          ? view.getUint32(mdhd.start + mdhd.headerSize + 4 + 8)
          : 0;
        let kind: TrackSamples["kind"] = "other";
        if (hdlr) {
          const hp = hdlr.start + hdlr.headerSize + 4 + 4;
          const h = String.fromCharCode(
            data[hp], data[hp + 1], data[hp + 2], data[hp + 3],
          );
          if (h === "vide") kind = "video";
          else if (h === "soun") kind = "audio";
        }
        const track: TrackSamples = {
          trackId, kind, timescale, codec: "unknown", samples: [],
        };
        const stbl = minf ? findChild(data, minf, "stbl") : undefined;
        if (stbl) {
          const st = parseStbl(data, stbl);
          track.codec = st.codec;
          if (st.codecConfig) {
            if (kind === "video") track.avcC = st.codecConfig;
            else track.audioSpecificConfig = st.codecConfig;
          }
          track.width = st.width;
          track.height = st.height;
          track.sampleRate = st.sampleRate;
          track.channels = st.channels;
          track.samples.push(...samplesFromStbl(st));
        }
        byTrackId.set(trackId, track);
        order.push(track);
      }
    } else if (top.type === "moof") {
      fragmented = true;
      parseMoof(data, top, byTrackId);
    }
  }
  return { fragmented, tracks: order };
}
