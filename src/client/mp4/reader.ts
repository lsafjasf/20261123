import { ascii, hexByte, readI32, readU16, readU32, readU64, slice } from "./bytes.js";

export interface Mp4Box {
  type: string;
  start: number;
  dataStart: number;
  end: number;
}

export interface Mp4Sample {
  offset: number;
  size: number;
  dts: number;
  cts: number;
  duration: number;
  isKey: boolean;
}

export interface Mp4Track {
  id: number;
  kind: "video" | "audio" | "other";
  handler: string;
  timescale: number;
  duration: number;
  samples: Mp4Sample[];
  codec: string;
  width: number;
  height: number;
  sampleEntry: Uint8Array | null;
  description: Uint8Array | null;
  editMediaTime: number;
  editDurationMovie: number | null;
  emptyEditDelayMovie: number;
  presentationStartSeconds: number;
  displayDurationSeconds: number;
}

export interface Mp4File {
  tracks: Mp4Track[];
  video: Mp4Track;
  audio: Mp4Track | null;
  movieTimescale: number;
  duration: number;
  warnings: string[];
  bytes: Uint8Array;
}

export function readBoxes(bytes: Uint8Array, start = 0, end = bytes.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = readU32(bytes, cursor);
    const type = ascii(bytes, cursor + 4, cursor + 8);
    let header = 8;
    if (size === 1) {
      if (cursor + 16 > end) break;
      size = readU64(bytes, cursor + 8);
      header = 16;
    } else if (size === 0) {
      size = end - cursor;
    }
    if (size < header || cursor + size > end) break;
    boxes.push({ type, start: cursor, dataStart: cursor + header, end: cursor + size });
    cursor += size;
  }
  return boxes;
}

export function childBox(bytes: Uint8Array, parent: Mp4Box, type: string): Mp4Box | null {
  return readBoxes(bytes, parent.dataStart, parent.end).find((candidate) => candidate.type === type) ?? null;
}

function childBytes(bytes: Uint8Array, parent: Mp4Box, type: string): Uint8Array | null {
  const child = childBox(bytes, parent, type);
  return child ? slice(bytes, child.dataStart, child.end) : null;
}

function requiredChild(bytes: Uint8Array, parent: Mp4Box, type: string): Mp4Box {
  const child = childBox(bytes, parent, type);
  if (!child) throw new Error(`MP4 缺少 ${type} box`);
  return child;
}

function parseMvhd(bytes: Uint8Array, moov: Mp4Box): { timescale: number; duration: number } {
  const mvhd = requiredChild(bytes, moov, "mvhd");
  const version = bytes[mvhd.dataStart];
  if (version === 1) {
    return { timescale: readU32(bytes, mvhd.dataStart + 20), duration: readU64(bytes, mvhd.dataStart + 24) };
  }
  return { timescale: readU32(bytes, mvhd.dataStart + 12), duration: readU32(bytes, mvhd.dataStart + 16) };
}

function parseMdhd(bytes: Uint8Array, mdia: Mp4Box): { timescale: number; duration: number } {
  const mdhd = requiredChild(bytes, mdia, "mdhd");
  const version = bytes[mdhd.dataStart];
  if (version === 1) {
    return { timescale: readU32(bytes, mdhd.dataStart + 20), duration: readU64(bytes, mdhd.dataStart + 24) };
  }
  return { timescale: readU32(bytes, mdhd.dataStart + 12), duration: readU32(bytes, mdhd.dataStart + 16) };
}

function parseHandler(bytes: Uint8Array, mdia: Mp4Box): string {
  const hdlr = requiredChild(bytes, mdia, "hdlr");
  return ascii(bytes, hdlr.dataStart + 8, hdlr.dataStart + 12);
}

function parseStts(bytes: Uint8Array, stbl: Mp4Box): Array<{ count: number; delta: number }> {
  const stts = requiredChild(bytes, stbl, "stts");
  const count = readU32(bytes, stts.dataStart + 4);
  const entries: Array<{ count: number; delta: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const offset = stts.dataStart + 8 + index * 8;
    entries.push({ count: readU32(bytes, offset), delta: readU32(bytes, offset + 4) });
  }
  return entries;
}

function parseCtts(bytes: Uint8Array, stbl: Mp4Box): Array<{ count: number; offset: number }> {
  const ctts = childBox(bytes, stbl, "ctts");
  if (!ctts) return [];
  const count = readU32(bytes, ctts.dataStart + 4);
  const entries: Array<{ count: number; offset: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const offset = ctts.dataStart + 8 + index * 8;
    entries.push({ count: readU32(bytes, offset), offset: readI32(bytes, offset + 4) });
  }
  return entries;
}

function parseSizes(bytes: Uint8Array, stbl: Mp4Box): number[] {
  const stsz = requiredChild(bytes, stbl, "stsz");
  const uniform = readU32(bytes, stsz.dataStart + 4);
  const count = readU32(bytes, stsz.dataStart + 8);
  if (uniform > 0) return new Array(count).fill(uniform);
  const sizes: number[] = [];
  for (let index = 0; index < count; index += 1) sizes.push(readU32(bytes, stsz.dataStart + 12 + index * 4));
  return sizes;
}

function parseChunkOffsets(bytes: Uint8Array, stbl: Mp4Box): number[] {
  const stco = childBox(bytes, stbl, "stco");
  if (stco) {
    const count = readU32(bytes, stco.dataStart + 4);
    return Array.from({ length: count }, (_, index) => readU32(bytes, stco.dataStart + 8 + index * 4));
  }
  const co64 = childBox(bytes, stbl, "co64");
  if (!co64) throw new Error("MP4 缺少 stco/co64 box");
  const count = readU32(bytes, co64.dataStart + 4);
  return Array.from({ length: count }, (_, index) => readU64(bytes, co64.dataStart + 8 + index * 8));
}

function parseStsc(bytes: Uint8Array, stbl: Mp4Box): Array<{ firstChunk: number; samplesPerChunk: number }> {
  const stsc = requiredChild(bytes, stbl, "stsc");
  const count = readU32(bytes, stsc.dataStart + 4);
  return Array.from({ length: count }, (_, index) => {
    const offset = stsc.dataStart + 8 + index * 12;
    return { firstChunk: readU32(bytes, offset), samplesPerChunk: readU32(bytes, offset + 4) };
  });
}

function parseKeyframes(bytes: Uint8Array, stbl: Mp4Box, count: number): Set<number> {
  const stss = childBox(bytes, stbl, "stss");
  if (!stss) return new Set(Array.from({ length: count }, (_, index) => index + 1));
  const entryCount = readU32(bytes, stss.dataStart + 4);
  const keys = new Set<number>();
  for (let index = 0; index < entryCount; index += 1) {
    keys.add(readU32(bytes, stss.dataStart + 8 + index * 4));
  }
  return keys;
}

interface SampleEntryInfo {
  sampleEntry: Uint8Array;
  type: string;
  width: number;
  height: number;
  codec: string;
  description: Uint8Array | null;
}

function parseSampleEntry(bytes: Uint8Array, stbl: Mp4Box): SampleEntryInfo | null {
  const stsd = childBox(bytes, stbl, "stsd");
  if (!stsd) return null;
  const count = readU32(bytes, stsd.dataStart + 4);
  if (count < 1) return null;
  const start = stsd.dataStart + 8;
  const boxes = readBoxes(bytes, start, stsd.end);
  const entry = boxes[0];
  if (!entry) return null;
  const sampleEntry = slice(bytes, entry.start, entry.end);
  const type = entry.type;
  if (type === "avc1" || type === "avc3") {
    const width = readU16(bytes, entry.start + 32);
    const height = readU16(bytes, entry.start + 34);
    const childStart = entry.start + 86;
    const avcC = readBoxes(bytes, childStart, entry.end).find((box) => box.type === "avcC");
    if (!avcC) throw new Error("AVC 轨道缺少 avcC 配置");
    const description = slice(bytes, avcC.dataStart, avcC.end);
    const profile = bytes[avcC.dataStart + 1];
    const compatibility = bytes[avcC.dataStart + 2];
    const level = bytes[avcC.dataStart + 3];
    const codec = `${type}.${hexByte(profile)}${hexByte(compatibility)}${hexByte(level)}`;
    return { sampleEntry, type, width, height, codec, description };
  }
  if (type === "mp4a") {
    return { sampleEntry, type, width: 0, height: 0, codec: "mp4a.40.2", description: childBytes(bytes, entry, "esds") };
  }
  return { sampleEntry, type, width: 0, height: 0, codec: type, description: null };
}

function parseEditList(bytes: Uint8Array, trak: Mp4Box): { mediaTime: number; durationMovie: number | null; emptyDelayMovie: number } {
  const edts = childBox(bytes, trak, "edts");
  const elst = edts ? childBox(bytes, edts, "elst") : null;
  if (!elst) return { mediaTime: 0, durationMovie: null, emptyDelayMovie: 0 };
  const version = bytes[elst.dataStart];
  const count = readU32(bytes, elst.dataStart + 4);
  let cursor = elst.dataStart + 8;
  let mediaTime = 0;
  let durationMovie: number | null = null;
  let emptyDelayMovie = 0;
  let foundNormal = false;
  for (let index = 0; index < count; index += 1) {
    if (version === 1) {
      const segmentDuration = readU64(bytes, cursor);
      const media = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(cursor + 8, false));
      if (media === -1) {
        emptyDelayMovie += segmentDuration;
      } else if (!foundNormal) {
        mediaTime = media;
        durationMovie = segmentDuration;
        foundNormal = true;
      }
      cursor += 20;
    } else {
      const segmentDuration = readU32(bytes, cursor);
      const media = readI32(bytes, cursor + 4);
      if (media === -1) {
        emptyDelayMovie += segmentDuration;
      } else if (!foundNormal) {
        mediaTime = media;
        durationMovie = segmentDuration;
        foundNormal = true;
      }
      cursor += 12;
    }
  }
  return { mediaTime, durationMovie, emptyDelayMovie };
}

function parseTrack(bytes: Uint8Array, trak: Mp4Box, movieTimescale: number): Mp4Track {
  const tkhd = requiredChild(bytes, trak, "tkhd");
  const id = readU32(bytes, tkhd.dataStart + (bytes[tkhd.dataStart] === 1 ? 20 : 12));
  const mdia = requiredChild(bytes, trak, "mdia");
  const { timescale, duration } = parseMdhd(bytes, mdia);
  const handler = parseHandler(bytes, mdia);
  const stbl = requiredChild(bytes, requiredChild(bytes, mdia, "minf"), "stbl");
  const sizes = parseSizes(bytes, stbl);
  const chunkOffsets = parseChunkOffsets(bytes, stbl);
  const stsc = parseStsc(bytes, stbl);
  const stts = parseStts(bytes, stbl);
  const ctts = parseCtts(bytes, stbl);
  const keyframes = parseKeyframes(bytes, stbl, sizes.length);
  const entry = parseSampleEntry(bytes, stbl);
  const edits = parseEditList(bytes, trak);

  const deltas: number[] = [];
  for (const timing of stts) {
    for (let index = 0; index < timing.count; index += 1) deltas.push(timing.delta);
  }
  const compositionOffsets: number[] = [];
  for (const timing of ctts) {
    for (let index = 0; index < timing.count; index += 1) compositionOffsets.push(timing.offset);
  }

  const samples: Mp4Sample[] = [];
  let sampleIndex = 0;
  let dts = 0;
  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex += 1) {
    let run = stsc[0];
    for (let index = 0; index < stsc.length; index += 1) {
      if (stsc[index].firstChunk <= chunkIndex + 1) run = stsc[index];
    }
    let offset = chunkOffsets[chunkIndex];
    for (let inChunk = 0; inChunk < run.samplesPerChunk && sampleIndex < sizes.length; inChunk += 1) {
      const size = sizes[sampleIndex];
      const delta = deltas[sampleIndex] ?? deltas[deltas.length - 1] ?? 0;
      samples.push({
        offset,
        size,
        dts,
        cts: dts + (compositionOffsets[sampleIndex] ?? 0),
        duration: delta,
        isKey: keyframes.has(sampleIndex + 1)
      });
      offset += size;
      dts += delta;
      sampleIndex += 1;
    }
  }

  const kind: Mp4Track["kind"] = handler === "vide" ? "video" : handler === "soun" ? "audio" : "other";
  const firstCts = samples.length > 0 ? Math.min(...samples.map((sample) => sample.cts)) : 0;
  const presentationStartSeconds =
    edits.emptyDelayMovie / movieTimescale + (firstCts - edits.mediaTime) / timescale;
  const displayDurationSeconds =
    edits.durationMovie !== null ? edits.durationMovie / movieTimescale : duration / timescale;
  return {
    id,
    kind,
    handler,
    timescale,
    duration,
    samples,
    codec: entry?.codec ?? handler,
    width: entry?.width ?? 0,
    height: entry?.height ?? 0,
    sampleEntry: entry?.sampleEntry ?? null,
    description: entry?.description ?? null,
    editMediaTime: edits.mediaTime,
    editDurationMovie: edits.durationMovie,
    emptyEditDelayMovie: edits.emptyDelayMovie,
    presentationStartSeconds,
    displayDurationSeconds
  };
}

export function parseMp4(bytes: Uint8Array): Mp4File {
  const top = readBoxes(bytes);
  if (!top.some((box) => box.type === "ftyp")) throw new Error("不是有效的 MP4 文件（缺少 ftyp）");
  const moov = top.find((box) => box.type === "moov");
  if (!moov) throw new Error("MP4 缺少 moov；请确认文件已正常封装");
  const movie = parseMvhd(bytes, moov);
  const warnings: string[] = [];
  const tracks: Mp4Track[] = [];
  for (const box of readBoxes(bytes, moov.dataStart, moov.end)) {
    if (box.type !== "trak") continue;
    try {
      tracks.push(parseTrack(bytes, box, movie.timescale));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  const video = tracks.find((track) => track.kind === "video" && track.samples.length > 0);
  if (!video) throw new Error(`未找到可解码的视频轨道${warnings.length ? `：${warnings.join("；")}` : ""}`);
  if (video.codec.startsWith("hvc1") || video.codec.startsWith("hev1")) warnings.push("HEVC 解码取决于浏览器 WebCodecs 支持");
  if (video.codec === "av01") warnings.push("AV1 解码取决于浏览器 WebCodecs 支持");
  if (video.samples.length === 0) warnings.push("视频轨道没有样本");
  const audio = tracks.find((track) => track.kind === "audio" && track.samples.length > 0) ?? null;
  if (!audio) warnings.push("未发现音频轨道；导出将只有视频");
  if (audio && audio.codec !== "mp4a.40.2") warnings.push(`音频编码 ${audio.codec} 将按原始样本透传`);

  return {
    tracks,
    video,
    audio,
    movieTimescale: movie.timescale,
    duration: movie.duration,
    warnings,
    bytes
  };
}

export function sampleToSeconds(sample: Mp4Sample, track: Mp4Track): number {
  return sample.cts / track.timescale;
}

export function trackStartSeconds(track: Mp4Track): number {
  if (track.samples.length === 0) return 0;
  return Math.min(...track.samples.slice(0, 32).map((sample) => sample.cts / track.timescale));
}

export function trackEndSeconds(track: Mp4Track): number {
  if (track.samples.length === 0) return 0;
  let end = 0;
  for (const sample of track.samples) end = Math.max(end, (sample.cts + sample.duration) / track.timescale);
  return end;
}
