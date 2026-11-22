// Minimal MP4 (ISO BMFF) demuxer. No third-party code.
// Parses the sample tables needed to locate, in decode order, every video
// and audio sample in a time range, starting from the nearest keyframe
// at or before a given presentation time.

export interface Mp4Box {
  type: string;
  start: number; // offset of box header
  size: number;  // total box size including header
  headerSize: number;
  dataStart: number;
  dataEnd: number;
  children: Mp4Box[];
}

const CONTAINER_BOXES = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta",
]);

export function parseBoxes(buf: Uint8Array, start: number, end: number): Mp4Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes: Mp4Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    let headerSize = 8;
    if (size === 1) {
      const hi = view.getUint32(pos + 8);
      const lo = view.getUint32(pos + 12);
      size = hi * 2 ** 32 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) break;
    const box: Mp4Box = {
      type, start: pos, size, headerSize,
      dataStart: pos + headerSize, dataEnd: pos + size, children: [],
    };
    if (CONTAINER_BOXES.has(type)) {
      box.children = parseBoxes(buf, box.dataStart, box.dataEnd);
    }
    boxes.push(box);
    pos += size;
  }
  return boxes;
}

export function findBox(boxes: Mp4Box[], type: string): Mp4Box | null {
  for (const b of boxes) if (b.type === type) return b;
  return null;
}

export function findPath(boxes: Mp4Box[], path: string[]): Mp4Box | null {
  let cur: Mp4Box[] = boxes;
  let found: Mp4Box | null = null;
  for (const t of path) {
    found = findBox(cur, t);
    if (!found) return null;
    cur = found.children;
  }
  return found;
}

export interface Sample {
  index: number;
  offset: number;   // file offset of sample data
  size: number;
  dts: number;      // seconds, decode timeline
  cts: number;      // seconds, presentation timeline (dts + ctts offset)
  duration: number; // seconds
  keyframe: boolean;
}

export interface Track {
  kind: "video" | "audio";
  trackId: number;
  timescale: number;
  codec: string;         // e.g. "avc1.64001f" or "mp4a.40.2"
  codecDescription: Uint8Array | null; // avcC payload for video
  channelCount: number;
  sampleRate: number;
  width: number;
  height: number;
  samples: Sample[];     // decode order
  durationSec: number;
}

function readU32(view: DataView, o: number): number { return view.getUint32(o); }

// Returns the presentation-time shift (seconds) from the first elst entry
// with a non-negative media_time. B-frame encoders delay CTS by the reorder
// depth and cancel it with an edit list; we must apply the same shift.
function editListShift(buf: Uint8Array, trak: Mp4Box, timescale: number): number {
  const elst = findPath(trak.children, ["edts", "elst"]);
  if (!elst || !timescale) return 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = view.getUint8(elst.dataStart);
  const count = readU32(view, elst.dataStart + 4);
  let p = elst.dataStart + 8;
  for (let i = 0; i < count; i++) {
    let mediaTime: number;
    if (version === 1) {
      mediaTime = readU32(view, p + 8) * 2 ** 32 + readU32(view, p + 12);
      p += 20;
    } else {
      mediaTime = readU32(view, p + 4);
      p += 12;
    }
    if (mediaTime >= 0 && mediaTime !== 0xffffffff && mediaTime !== 0xffffffffffffffff) {
      return mediaTime / timescale;
    }
  }
  return 0;
}

function codecFromAvcC(avcC: Uint8Array): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

// Reads stsd and returns codec info for the first entry.
function parseStsd(buf: Uint8Array, box: Mp4Box, kind: "video" | "audio") {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const o = box.dataStart + 8; // skip version/flags + entry_count
  const fmt = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
  const info = {
    codec: "", description: null as Uint8Array | null,
    channelCount: 0, sampleRate: 0, width: 0, height: 0,
  };
  if (kind === "video" && (fmt === "avc1" || fmt === "avc3")) {
    info.width = view.getUint16(o + 32);
    info.height = view.getUint16(o + 34);
    // child boxes of the sample entry start at o + 86
    const children = parseBoxes(buf, o + 86, o + readU32(view, o));
    const avcC = findBox(children, "avcC");
    if (avcC) {
      info.description = buf.slice(avcC.dataStart, avcC.dataEnd);
      info.codec = codecFromAvcC(info.description);
    } else {
      info.codec = "avc1";
    }
  } else if (kind === "audio" && (fmt === "mp4a" || fmt === "aac ")) {
    info.channelCount = view.getUint16(o + 24);
    info.sampleRate = readU32(view, o + 32) >>> 16;
    const children = parseBoxes(buf, o + 36, o + readU32(view, o));
    const esds = findBox(children, "esds");
    info.codec = "mp4a.40.2"; // AAC LC; refined from esds when present
    if (esds) {
      const objType = buf[esds.dataStart + 12 + 4]; // best-effort
      if (objType === 0x40 || objType === 0x66 || objType === 0x67) {
        info.codec = `mp4a.${objType.toString(16)}.2`;
      }
    }
  } else {
    info.codec = fmt;
  }
  return info;
}

interface TableCtx {
  buf: Uint8Array;
  view: DataView;
  stbl: Mp4Box;
}

function expandStts(ctx: TableCtx): { dts: number[]; durations: number[] } {
  const box = findBox(ctx.stbl.children, "stts");
  if (!box) throw new Error("missing stts");
  const v = ctx.view;
  const count = readU32(v, box.dataStart + 4);
  const dts: number[] = [];
  const durations: number[] = [];
  let p = box.dataStart + 8;
  let t = 0;
  for (let i = 0; i < count; i++, p += 8) {
    const n = readU32(v, p);
    const delta = readU32(v, p + 4);
    for (let j = 0; j < n; j++) {
      dts.push(t);
      durations.push(delta);
      t += delta;
    }
  }
  return { dts, durations };
}

function expandCtts(ctx: TableCtx, sampleCount: number): number[] {
  const offsets = new Array<number>(sampleCount).fill(0);
  const box = findBox(ctx.stbl.children, "ctts");
  if (!box) return offsets;
  const v = ctx.view;
  const version = v.getUint8(box.dataStart);
  const count = readU32(v, box.dataStart + 4);
  let p = box.dataStart + 8;
  let idx = 0;
  for (let i = 0; i < count && idx < sampleCount; i++, p += 8) {
    const n = readU32(v, p);
    let off = readU32(v, p + 4);
    if (version === 1 && off >= 0x80000000) off = off - 0x100000000;
    for (let j = 0; j < n && idx < sampleCount; j++, idx++) offsets[idx] = off;
  }
  return offsets;
}

export interface DemuxResult {
  video: Track | null;
  audio: Track | null;
  durationSec: number;
  data: Uint8Array; // whole file, kept for sample extraction
}

export function demux(buf: Uint8Array): DemuxResult {
  const top = parseBoxes(buf, 0, buf.byteLength);
  const moov = findBox(top, "moov");
  if (!moov) throw new Error("no moov box");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const mvhd = findBox(moov.children, "mvhd");
  let movieDuration = 0;
  if (mvhd) {
    const ver = view.getUint8(mvhd.dataStart);
    const ts = readU32(view, mvhd.dataStart + (ver === 1 ? 16 : 12));
    const dur = ver === 1
      ? readU32(view, mvhd.dataStart + 20) * 2 ** 32 + readU32(view, mvhd.dataStart + 24)
      : readU32(view, mvhd.dataStart + 16);
    movieDuration = ts ? dur / ts : 0;
  }
  const result: DemuxResult = { video: null, audio: null, durationSec: movieDuration, data: buf };
  for (const trak of moov.children) {
    if (trak.type !== "trak") continue;
    const mdia = findBox(trak.children, "mdia");
    if (!mdia) continue;
    const hdlr = findBox(mdia.children, "hdlr");
    if (!hdlr) continue;
    const handler = String.fromCharCode(
      buf[hdlr.dataStart + 8], buf[hdlr.dataStart + 9],
      buf[hdlr.dataStart + 10], buf[hdlr.dataStart + 11]);
    const kind = handler === "vide" ? "video" : handler === "soun" ? "audio" : null;
    if (!kind || (kind === "video" && result.video) || (kind === "audio" && result.audio)) {
      continue;
    }
    const mdhd = findBox(mdia.children, "mdhd");
    if (!mdhd) continue;
    const ver = view.getUint8(mdhd.dataStart);
    const timescale = readU32(view, mdhd.dataStart + (ver === 1 ? 20 : 12));
    const tkhd = findBox(trak.children, "tkhd");
    const trackId = tkhd ? readU32(view, tkhd.dataStart + (view.getUint8(tkhd.dataStart) === 1 ? 20 : 12)) : 0;
    const stbl = findPath(mdia.children, ["minf", "stbl"]);
    if (!stbl) continue;
    const stsd = findBox(stbl.children, "stsd");
    if (!stsd) continue;
    const info = parseStsd(buf, stsd, kind);
    const ctx: TableCtx = { buf, view, stbl };
    const sizes = sampleSizes(ctx);
    const { dts, durations } = expandStts(ctx);
    const ctts = expandCtts(ctx, sizes.length);
    const keys = expandStss(ctx, sizes.length);
    const offsets = sampleOffsets(ctx, sizes);
    const shift = editListShift(buf, trak, timescale);
    const samples: Sample[] = sizes.map((size, i) => ({
      index: i,
      offset: offsets[i],
      size,
      dts: dts[i] / timescale,
      cts: (dts[i] + ctts[i]) / timescale - shift,
      duration: durations[i] / timescale,
      keyframe: keys[i],
    }));
    const track: Track = {
      kind, trackId, timescale,
      codec: info.codec,
      codecDescription: info.description,
      channelCount: info.channelCount,
      sampleRate: info.sampleRate,
      width: info.width,
      height: info.height,
      samples,
      durationSec: sizes.length ? (dts[dts.length - 1] + durations[durations.length - 1]) / timescale : 0,
    };
    if (kind === "video") result.video = track; else result.audio = track;
  }
  return result;
}

// Samples in decode order covering presentation range [startSec, endSec],
// expanded backwards to the nearest keyframe at or before startSec.
export function samplesForRange(track: Track, startSec: number, endSec: number): Sample[] {
  const byCts = track.samples.filter(s => s.cts + s.duration > startSec && s.cts < endSec);
  if (byCts.length === 0) return [];
  let first = byCts[0].index;
  if (track.kind === "video") {
    while (first > 0 && !track.samples[first].keyframe) first--;
  }
  const last = byCts[byCts.length - 1].index;
  return track.samples.slice(first, last + 1);
}

export function extractSample(data: Uint8Array, s: Sample): Uint8Array {
  return data.slice(s.offset, s.offset + s.size);
}

function expandStss(ctx: TableCtx, sampleCount: number): boolean[] {
  const key = new Array<boolean>(sampleCount).fill(true);
  const box = findBox(ctx.stbl.children, "stss");
  if (!box) return key; // no stss => every sample is a sync sample
  key.fill(false);
  const v = ctx.view;
  const count = readU32(v, box.dataStart + 4);
  let p = box.dataStart + 8;
  for (let i = 0; i < count; i++, p += 4) {
    const s = readU32(v, p) - 1;
    if (s >= 0 && s < sampleCount) key[s] = true;
  }
  return key;
}

function sampleSizes(ctx: TableCtx): number[] {
  const box = findBox(ctx.stbl.children, "stsz");
  if (!box) throw new Error("missing stsz");
  const v = ctx.view;
  const defSize = readU32(v, box.dataStart + 4);
  const count = readU32(v, box.dataStart + 8);
  const sizes = new Array<number>(count);
  if (defSize !== 0) {
    sizes.fill(defSize);
    return sizes;
  }
  let p = box.dataStart + 12;
  for (let i = 0; i < count; i++, p += 4) sizes[i] = readU32(v, p);
  return sizes;
}

function chunkOffsets(ctx: TableCtx): number[] {
  const v = ctx.view;
  const co64 = findBox(ctx.stbl.children, "co64");
  if (co64) {
    const count = readU32(v, co64.dataStart + 4);
    const out = new Array<number>(count);
    let p = co64.dataStart + 8;
    for (let i = 0; i < count; i++, p += 8) {
      out[i] = readU32(v, p) * 2 ** 32 + readU32(v, p + 4);
    }
    return out;
  }
  const stco = findBox(ctx.stbl.children, "stco");
  if (!stco) throw new Error("missing stco/co64");
  const count = readU32(v, stco.dataStart + 4);
  const out = new Array<number>(count);
  let p = stco.dataStart + 8;
  for (let i = 0; i < count; i++, p += 4) out[i] = readU32(v, p);
  return out;
}

// Maps each sample to its file offset using stsc + chunk offsets + sizes.
function sampleOffsets(ctx: TableCtx, sizes: number[]): number[] {
  const stsc = findBox(ctx.stbl.children, "stsc");
  if (!stsc) throw new Error("missing stsc");
  const v = ctx.view;
  const entryCount = readU32(v, stsc.dataStart + 4);
  const firstChunk: number[] = [];
  const perChunk: number[] = [];
  let p = stsc.dataStart + 8;
  for (let i = 0; i < entryCount; i++, p += 12) {
    firstChunk.push(readU32(v, p));
    perChunk.push(readU32(v, p + 4));
  }
  const chunks = chunkOffsets(ctx);
  const offsets = new Array<number>(sizes.length);
  let sample = 0;
  for (let c = 0; c < chunks.length; c++) {
    const chunkNo = c + 1;
    let entry = 0;
    for (let e = 0; e < firstChunk.length; e++) {
      if (firstChunk[e] <= chunkNo) entry = e; else break;
    }
    let off = chunks[c];
    for (let s = 0; s < perChunk[entry] && sample < sizes.length; s++, sample++) {
      offsets[sample] = off;
      off += sizes[sample];
    }
  }
  return offsets;
}
