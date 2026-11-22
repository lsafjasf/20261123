import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export interface MediaProbe {
  container: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  sampleRate: number | null;
}

interface Box {
  type: string;
  start: number;
  dataStart: number;
  end: number;
}

interface TrackInfo {
  handler: string;
  timescale: number;
  duration: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  fps: number | null;
  channels: number | null;
  sampleRate: number | null;
}

const MAX_MOOV_BYTES = 128 * 1024 * 1024;

function readBox(buffer: Buffer, offset: number, limit: number): Box | null {
  if (offset + 8 > limit) return null;
  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString("latin1", offset + 4, offset + 8);
  let dataStart = offset + 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const large = buffer.readBigUInt64BE(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    dataStart = offset + 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < dataStart - offset || offset + size > limit) return null;
  return { type, start: offset, dataStart, end: offset + size };
}

function childBoxes(buffer: Buffer, parent: Box | null = null): Box[] {
  if (!parent) return [];
  const result: Box[] = [];
  let cursor = parent.dataStart;
  while (cursor + 8 <= parent.end) {
    const box = readBox(buffer, cursor, parent.end);
    if (!box || box.type.trim() === "") break;
    result.push(box);
    cursor = box.end;
  }
  return result;
}

function firstChild(buffer: Buffer, parent: Box | null, type: string): Box | null {
  return childBoxes(buffer, parent).find((box) => box.type === type) ?? null;
}

function childPath(buffer: Buffer, parent: Box | null, types: string[]): Box | null {
  let current = parent;
  for (const type of types) {
    current = firstChild(buffer, current, type);
    if (!current) return null;
  }
  return current;
}

function parseTimescale(buffer: Buffer, box: Box | null): { timescale: number; duration: number } {
  if (!box || box.dataStart + 20 > box.end) return { timescale: 0, duration: 0 };
  const version = buffer.readUInt8(box.dataStart);
  if (version === 1) {
    const timescale = buffer.readUInt32BE(box.dataStart + 20);
    const duration = Number(buffer.readBigUInt64BE(box.dataStart + 24));
    return { timescale, duration };
  }
  return {
    timescale: buffer.readUInt32BE(box.dataStart + 12),
    duration: buffer.readUInt32BE(box.dataStart + 16)
  };
}

function parseHandler(buffer: Buffer, box: Box | null): string {
  if (!box || box.dataStart + 12 > box.end) return "";
  return buffer.toString("latin1", box.dataStart + 8, box.dataStart + 12).trim();
}

function parseFps(
  buffer: Buffer,
  stts: Box | null,
  sampleCount: number,
  timescale: number,
  trackDuration: number
): number | null {
  if (stts && stts.dataStart + 8 <= stts.end) {
    const entries = buffer.readUInt32BE(stts.dataStart + 4);
    let ticks = 0;
    let samples = 0;
    let cursor = stts.dataStart + 8;
    for (let index = 0; index < entries && cursor + 8 <= stts.end; index += 1) {
      const count = buffer.readUInt32BE(cursor);
      const delta = buffer.readUInt32BE(cursor + 4);
      samples += count;
      ticks += count * delta;
      cursor += 8;
    }
    if (samples > 0 && ticks > 0 && timescale > 0) {
      return Number(((samples * timescale) / ticks).toFixed(3));
    }
  }
  if (sampleCount > 0 && timescale > 0 && trackDuration > 0) {
    return Number(((sampleCount * timescale) / trackDuration).toFixed(3));
  }
  return null;
}

function sampleCountOf(buffer: Buffer, stsz: Box | null): number {
  if (!stsz || stsz.dataStart + 12 > stsz.end) return 0;
  return buffer.readUInt32BE(stsz.dataStart + 8);
}

function parseTrack(buffer: Buffer, trak: Box): TrackInfo {
  const mdia = firstChild(buffer, trak, "mdia");
  const handler = parseHandler(buffer, firstChild(buffer, mdia, "hdlr"));
  const timing = parseTimescale(buffer, firstChild(buffer, mdia, "mdhd"));
  const tkhd = firstChild(buffer, trak, "tkhd");
  const stbl = childPath(buffer, mdia, ["minf", "stbl"]);
  const stsd = firstChild(buffer, stbl, "stsd");
  const stts = firstChild(buffer, stbl, "stts");
  const stsz = firstChild(buffer, stbl, "stsz");

  let width: number | null = null;
  let height: number | null = null;
  let codec: string | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;

  if (tkhd && tkhd.end - 8 >= tkhd.dataStart) {
    const fixedWidth = buffer.readUInt32BE(tkhd.end - 8) / 65536;
    const fixedHeight = buffer.readUInt32BE(tkhd.end - 4) / 65536;
    if (fixedWidth > 0) width = Math.round(fixedWidth);
    if (fixedHeight > 0) height = Math.round(fixedHeight);
  }

  if (stsd && stsd.dataStart + 16 <= stsd.end) {
    const entry = readBox(buffer, stsd.dataStart + 8, stsd.end);
    if (entry) {
      codec = entry.type;
      if (handler === "vide" && entry.dataStart + 28 <= entry.end) {
        const codedWidth = buffer.readUInt16BE(entry.dataStart + 24);
        const codedHeight = buffer.readUInt16BE(entry.dataStart + 26);
        if (codedWidth > 0) width = codedWidth;
        if (codedHeight > 0) height = codedHeight;
      }
      if (handler === "soun" && entry.dataStart + 28 <= entry.end) {
        channels = buffer.readUInt16BE(entry.dataStart + 16);
        const rateFixed = buffer.readUInt32BE(entry.dataStart + 24);
        if (rateFixed > 0) sampleRate = Math.round(rateFixed / 65536);
      }
    }
  }

  return {
    handler,
    timescale: timing.timescale,
    duration: timing.duration,
    width,
    height,
    codec,
    fps: handler === "vide"
      ? parseFps(buffer, stts, sampleCountOf(buffer, stsz), timing.timescale, timing.duration)
      : null,
    channels,
    sampleRate
  };
}

async function findMoov(handle: FileHandle, fileSize: number): Promise<{ buffer: Buffer; brand: string | null } | null> {
  let offset = 0;
  let brand: string | null = null;
  while (offset + 8 <= fileSize) {
    const header = Buffer.alloc(Math.min(16, fileSize - offset));
    const { bytesRead } = await handle.read(header, 0, header.length, offset);
    if (bytesRead < 8) return null;
    let size = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (bytesRead < 16) return null;
      const large = header.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (size < headerSize || offset + size > fileSize) return null;
    if (type === "ftyp") {
      const ftyp = Buffer.alloc(Math.min(size, 32));
      await handle.read(ftyp, 0, ftyp.length, offset);
      if (ftyp.length >= headerSize + 4) {
        brand = ftyp.toString("latin1", headerSize, headerSize + 4);
      }
    }
    if (type === "moov") {
      if (size > MAX_MOOV_BYTES) return null;
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, offset);
      return { buffer, brand };
    }
    offset += size;
  }
  return null;
}

export async function probeMp4File(filePath: string): Promise<MediaProbe | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, "r");
    const stat = await handle.stat();
    const found = await findMoov(handle, stat.size);
    if (!found) return null;
    const { buffer, brand } = found;
    const moov = readBox(buffer, 0, buffer.length);
    if (!moov || moov.type !== "moov") return null;
    const tracks = childBoxes(buffer, moov)
      .filter((box) => box.type === "trak")
      .map((track) => parseTrack(buffer, track));
    const movieTiming = parseTimescale(buffer, firstChild(buffer, moov, "mvhd"));
    const video = tracks.find((track) => track.handler === "vide") ?? null;
    const audio = tracks.find((track) => track.handler === "soun") ?? null;
    const trackDurations = tracks
      .filter((track) => track.timescale > 0)
      .map((track) => track.duration / track.timescale)
      .filter((duration) => Number.isFinite(duration) && duration > 0);
    const movieDuration = movieTiming.timescale > 0
      ? movieTiming.duration / movieTiming.timescale
      : 0;
    const duration = movieDuration > 0
      ? movieDuration
      : trackDurations.length > 0
        ? Math.max(...trackDurations)
        : null;

    return {
      container: brand ? `mp4:${brand.trim()}` : "mp4",
      duration: duration ? Number(duration.toFixed(3)) : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      fps: video?.fps ?? null,
      videoCodec: video?.codec ?? null,
      audioCodec: audio?.codec ?? null,
      audioChannels: audio?.channels ?? null,
      sampleRate: audio?.sampleRate ?? null
    };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
