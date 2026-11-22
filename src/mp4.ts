export interface ByteRangeReader {
  readonly size: number;
  read(start: number, length: number): Promise<Uint8Array>;
}

export interface Sample {
  decodeIndex: number;
  offset: number;
  size: number;
  dtsTicks: number;
  ctsTicks: number;
  durationTicks: number;
  isSync: boolean;
}

interface TrackBase {
  id: number;
  trackId: number;
  timescale: number;
  durationTicks: number;
  language: string;
  samples: Sample[];
  sampleCache: Map<number, Uint8Array>;
}

export interface VideoTrack extends TrackBase {
  kind: "video";
  width: number;
  height: number;
  codec: string;
  description: Uint8Array;
}

export interface AudioTrack extends TrackBase {
  kind: "audio";
  sampleRate: number;
  channels: number;
  codec: string;
  description: Uint8Array;
}

export type MediaTrack = VideoTrack | AudioTrack;

export interface DemuxedMedia {
  size: number;
  tracks: MediaTrack[];
  videoTracks: VideoTrack[];
  audioTracks: AudioTrack[];
  durationSeconds: number;
}

interface Box {
  type: string;
  start: number;
  size: number;
  headerSize: number;
  payloadStart: number;
  end: number;
}

class Bytes {
  readonly view: DataView;
  readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  u8(offset: number): number {
    return this.view.getUint8(offset);
  }

  u16(offset: number): number {
    return this.view.getUint16(offset);
  }

  i16(offset: number): number {
    return this.view.getInt16(offset);
  }

  u24(offset: number): number {
    return (this.u8(offset) << 16) | (this.u8(offset + 1) << 8) | this.u8(offset + 2);
  }

  u32(offset: number): number {
    return this.view.getUint32(offset);
  }

  i32(offset: number): number {
    return this.view.getInt32(offset);
  }

  u64(offset: number): number {
    const high = this.u32(offset);
    const low = this.u32(offset + 4);
    return high * 0x1_0000_0000 + low;
  }

  fourCC(offset: number): string {
    return String.fromCharCode(this.u8(offset), this.u8(offset + 1), this.u8(offset + 2), this.u8(offset + 3));
  }

  ascii(offset: number, length: number): string {
    let text = "";
    for (let index = 0; index < length; index += 1) {
      const value = this.u8(offset + index);
      if (value === 0) break;
      text += String.fromCharCode(value);
    }
    return text;
  }
}

function boxHeader(data: Bytes, offset: number, limit: number): Box | null {
  if (offset + 8 > limit) return null;
  let size = data.u32(offset);
  const type = data.fourCC(offset + 4);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    size = data.u64(offset + 8);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (!Number.isSafeInteger(size) || size < headerSize || offset + size > limit) return null;
  return {
    type,
    start: offset,
    size,
    headerSize,
    payloadStart: offset + headerSize,
    end: offset + size
  };
}

function childBoxes(data: Bytes, parent: Box): Box[] {
  const result: Box[] = [];
  let offset = parent.payloadStart;
  while (offset + 8 <= parent.end) {
    const box = boxHeader(data, offset, parent.end);
    if (!box) break;
    result.push(box);
    offset = box.end;
  }
  return result;
}

function firstBox(data: Bytes, parent: Box, type: string): Box | undefined {
  return childBoxes(data, parent).find((box) => box.type === type);
}

function descendants(data: Bytes, parent: Box, path: string[]): Box | undefined {
  let cursor: Box | undefined = parent;
  for (const type of path) {
    if (!cursor) return undefined;
    cursor = firstBox(data, cursor, type);
  }
  return cursor;
}

function fullBoxData(data: Bytes, box: Box): number {
  if (box.payloadStart + 4 > box.end) throw new Error(`Truncated ${box.type} full box`);
  return box.payloadStart + 4;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function languageFromCode(data: Bytes, offset: number): string {
  const code = data.u16(offset);
  if (code === 0) return "";
  const chars = [
    ((code >> 10) & 0x1f) + 0x60,
    ((code >> 5) & 0x1f) + 0x60,
    (code & 0x1f) + 0x60
  ];
  if (chars.some((value) => value < 0x61 || value > 0x7a)) return "";
  return String.fromCharCode(...chars);
}

export class HttpRangeReader implements ByteRangeReader {
  readonly size: number;
  private readonly url: string;

  private constructor(size: number, url: string) {
    this.size = size;
    this.url = url;
  }

  static async open(url: string): Promise<HttpRangeReader> {
    const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
    if (!response.ok) throw new Error(`无法读取视频 (${response.status})`);
    const contentRange = response.headers.get("content-range");
    const match = contentRange ? /\/(\d+)$/.exec(contentRange) : null;
    const size = match ? Number(match[1]) : Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("无法确定视频文件大小");
    return new HttpRangeReader(size, url);
  }

  async read(start: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array();
    const end = Math.min(this.size - 1, start + length - 1);
    if (start < 0 || start > end) throw new Error("无效的字节范围");
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` }
    });
    if (!response.ok) throw new Error(`读取视频失败 (${response.status})`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== end - start + 1) throw new Error("视频读取长度不一致");
    return new Uint8Array(buffer);
  }
}

export class BlobRangeReader implements ByteRangeReader {
  private readonly blob: Blob;

  constructor(blob: Blob) {
    this.blob = blob;
  }

  get size(): number {
    return this.blob.size;
  }

  async read(start: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.blob.size, start + length);
    return new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
  }
}

export class MemoryRangeReader implements ByteRangeReader {
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  async read(start: number, length: number): Promise<Uint8Array> {
    return this.bytes.slice(start, start + length);
  }
}

export class CachingRangeReader implements ByteRangeReader {
  private readonly blocks = new Map<number, Uint8Array>();
  private readonly source: ByteRangeReader;
  private readonly blockSize: number;
  private readonly maxBlocks: number;

  constructor(source: ByteRangeReader, blockSize = 64 * 1024, maxBlocks = 256) {
    this.source = source;
    this.blockSize = blockSize;
    this.maxBlocks = maxBlocks;
  }

  get size(): number {
    return this.source.size;
  }

  async read(start: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array();
    if (start < 0 || start + length > this.size) throw new Error("字节范围超出文件");
    const output = new Uint8Array(length);
    let cursor = start;
    let written = 0;
    while (written < length) {
      const blockIndex = Math.floor(cursor / this.blockSize);
      const blockStart = blockIndex * this.blockSize;
      let block = this.blocks.get(blockIndex);
      if (!block) {
        const blockLength = Math.min(this.blockSize, this.size - blockStart);
        block = await this.source.read(blockStart, blockLength);
        this.blocks.set(blockIndex, block);
        while (this.blocks.size > this.maxBlocks) {
          const oldest = this.blocks.keys().next().value;
          if (oldest === undefined) break;
          this.blocks.delete(oldest);
        }
      } else {
        this.blocks.delete(blockIndex);
        this.blocks.set(blockIndex, block);
      }
      const within = cursor - blockStart;
      const take = Math.min(length - written, block.byteLength - within);
      if (take <= 0) throw new Error("读取块为空");
      output.set(block.subarray(within, within + take), written);
      written += take;
      cursor += take;
    }
    return output;
  }
}

interface SttsEntry {
  count: number;
  delta: number;
}

interface CttsEntry {
  count: number;
  offset: number;
}

interface StscEntry {
  firstChunk: number;
  samplesPerChunk: number;
}

function boxesFrom(data: Bytes, start: number, end: number): Box[] {
  const result: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = boxHeader(data, offset, end);
    if (!box) break;
    result.push(box);
    offset = box.end;
  }
  return result;
}

function parseStts(data: Bytes, box: Box): SttsEntry[] {
  const offset = fullBoxData(data, box);
  const count = data.u32(offset);
  if (count > 1_000_000 || offset + 4 + count * 8 > box.end) throw new Error("stts 表损坏");
  const entries: SttsEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      count: data.u32(offset + 4 + index * 8),
      delta: data.u32(offset + 8 + index * 8)
    });
  }
  return entries;
}

function parseCtts(data: Bytes, box: Box): CttsEntry[] {
  const offset = fullBoxData(data, box);
  const version = data.u8(box.payloadStart);
  const count = data.u32(offset);
  if (count > 1_000_000 || offset + 4 + count * 8 > box.end) throw new Error("ctts 表损坏");
  const entries: CttsEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const raw = data.u32(offset + 8 + index * 8);
    entries.push({
      count: data.u32(offset + 4 + index * 8),
      offset: version === 1 ? (raw | 0) : raw
    });
  }
  return entries;
}

function parseStss(data: Bytes, box: Box): Set<number> {
  const offset = fullBoxData(data, box);
  const count = data.u32(offset);
  if (count > 10_000_000 || offset + 4 + count * 4 > box.end) throw new Error("stss 表损坏");
  const result = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    result.add(data.u32(offset + 4 + index * 4));
  }
  return result;
}

function parseStsc(data: Bytes, box: Box): StscEntry[] {
  const offset = fullBoxData(data, box);
  const count = data.u32(offset);
  if (count > 1_000_000 || offset + 4 + count * 12 > box.end) throw new Error("stsc 表损坏");
  const result: StscEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push({
      firstChunk: data.u32(offset + 4 + index * 12),
      samplesPerChunk: data.u32(offset + 8 + index * 12)
    });
  }
  return result;
}

function parseSampleSizes(data: Bytes, box: Box): number[] {
  const offset = fullBoxData(data, box);
  const defaultSize = data.u32(offset);
  const count = data.u32(offset + 4);
  if (count > 100_000_000) throw new Error("样本数量异常");
  if (defaultSize > 0) return new Array<number>(count).fill(defaultSize);
  if (offset + 8 + count * 4 > box.end) throw new Error("stsz 表损坏");
  const sizes = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    sizes[index] = data.u32(offset + 8 + index * 4);
  }
  return sizes;
}

function parseSampleSizesCompact(data: Bytes, box: Box): number[] {
  const offset = fullBoxData(data, box);
  const fieldSize = data.u8(offset + 3);
  const count = data.u32(offset + 4);
  if (count > 100_000_000) throw new Error("样本数量异常");
  const bytesPerSample = fieldSize / 8;
  if (![1, 2, 4].includes(bytesPerSample)) throw new Error("stz2 字段宽度无效");
  if (offset + 8 + Math.ceil((count * fieldSize) / 8) > box.end) throw new Error("stz2 表损坏");
  const sizes = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    const byteOffset = offset + 8 + Math.floor((index * fieldSize) / 8);
    if (fieldSize === 4) {
      sizes[index] = index % 2 === 0 ? data.u8(byteOffset) >> 4 : data.u8(byteOffset) & 0x0f;
    } else if (fieldSize === 8) {
      sizes[index] = data.u8(byteOffset);
    } else {
      sizes[index] = data.u16(byteOffset);
    }
  }
  return sizes;
}

function parseChunkOffsets(data: Bytes, box: Box): number[] {
  const offset = fullBoxData(data, box);
  const count = data.u32(offset);
  const bytesPerEntry = box.type === "co64" ? 8 : 4;
  if (count > 100_000_000 || offset + 4 + count * bytesPerEntry > box.end) {
    throw new Error(`${box.type} 表损坏`);
  }
  const result = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    result[index] = bytesPerEntry === 8
      ? data.u64(offset + 4 + index * 8)
      : data.u32(offset + 4 + index * 4);
  }
  return result;
}

function expandTiming(
  entries: Array<{ count: number; value: number }>,
  sampleCount: number,
  fallback: number
): number[] {
  const result: number[] = [];
  for (const entry of entries) {
    for (let index = 0; index < entry.count && result.length < sampleCount; index += 1) {
      result.push(entry.value);
    }
  }
  while (result.length < sampleCount) result.push(fallback);
  return result;
}

function parseSamples(data: Bytes, stbl: Box): Sample[] {
  const stsd = firstBox(data, stbl, "stsd");
  const stsz = firstBox(data, stbl, "stsz");
  const stz2 = firstBox(data, stbl, "stz2");
  const stsc = firstBox(data, stbl, "stsc");
  const stco = firstBox(data, stbl, "stco");
  const co64 = firstBox(data, stbl, "co64");
  if (!stsd || (!stsz && !stz2) || !stsc || (!stco && !co64)) return [];

  const sizes = stsz ? parseSampleSizes(data, stsz) : parseSampleSizesCompact(data, stz2!);
  if (sizes.length === 0) return [];
  const stts = firstBox(data, stbl, "stts");
  if (!stts) throw new Error("缺少 stts 时间表");
  const timing = parseStts(data, stts);
  const durations = expandTiming(
    timing.map((entry) => ({ count: entry.count, value: entry.delta })),
    sizes.length,
    Math.max(1, Math.round((timing.at(-1)?.delta ?? 1)))
  );
  const ctts = firstBox(data, stbl, "ctts");
  const compositionOffsets = ctts
    ? expandTiming(
        parseCtts(data, ctts).map((entry) => ({ count: entry.count, value: entry.offset })),
        sizes.length,
        0
      )
    : new Array<number>(sizes.length).fill(0);
  const stss = firstBox(data, stbl, "stss");
  const syncSamples = stss ? parseStss(data, stss) : null;
  const chunkOffsets = parseChunkOffsets(data, stco ?? co64!);
  const stscEntries = parseStsc(data, stsc);
  if (stscEntries.length === 0) return [];

  const samples: Sample[] = [];
  let sampleIndex = 0;
  let dts = 0;
  let segment = 0;
  for (let chunk = 1; chunk <= chunkOffsets.length && sampleIndex < sizes.length; chunk += 1) {
    while (segment + 1 < stscEntries.length && stscEntries[segment + 1].firstChunk <= chunk) {
      segment += 1;
    }
    let offset = chunkOffsets[chunk - 1];
    for (let within = 0; within < stscEntries[segment].samplesPerChunk && sampleIndex < sizes.length; within += 1) {
      const size = sizes[sampleIndex];
      const durationTicks = durations[sampleIndex] || 1;
      samples.push({
        decodeIndex: sampleIndex,
        offset,
        size,
        dtsTicks: dts,
        ctsTicks: dts + compositionOffsets[sampleIndex],
        durationTicks,
        isSync: syncSamples ? syncSamples.has(sampleIndex + 1) : true
      });
      dts += durationTicks;
      offset += size;
      sampleIndex += 1;
    }
  }
  return samples;
}

interface Descriptor {
  tag: number;
  start: number;
  end: number;
  next: number;
}

function readDescriptor(data: Bytes, offset: number, limit: number): Descriptor | null {
  if (offset + 2 > limit) return null;
  const tag = data.u8(offset);
  let cursor = offset + 1;
  let length = 0;
  for (let count = 0; count < 4; count += 1) {
    if (cursor >= limit) return null;
    const byte = data.u8(cursor);
    cursor += 1;
    length = (length << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  if (cursor + length > limit) return null;
  return { tag, start: cursor, end: cursor + length, next: cursor + length };
}

function parseAacConfig(data: Bytes, esds: Box): { codec: string; description: Uint8Array } {
  let descriptor = readDescriptor(data, fullBoxData(data, esds), esds.end);
  while (descriptor && descriptor.tag !== 0x03) {
    descriptor = readDescriptor(data, descriptor.next, esds.end);
  }
  if (!descriptor) throw new Error("esds 缺少 ES_Descriptor");
  let cursor = descriptor.start + 2;
  const flags = data.u8(cursor);
  cursor += 1;
  if (flags & 0x80) cursor += 2;
  if (flags & 0x40) cursor += 1 + data.u8(cursor);
  if (flags & 0x20) cursor += 2;

  let decoderConfig: Descriptor | null = null;
  while (cursor < descriptor.end) {
    const child = readDescriptor(data, cursor, descriptor.end);
    if (!child) break;
    if (child.tag === 0x04) {
      decoderConfig = child;
      break;
    }
    cursor = child.next;
  }
  if (!decoderConfig) throw new Error("esds 缺少 DecoderConfigDescriptor");
  const objectTypeIndication = data.u8(decoderConfig.start);
  if (objectTypeIndication !== 0x40) throw new Error(`暂不支持 MPEG-4 音频对象 ${objectTypeIndication}`);
  const specific = readDescriptor(data, decoderConfig.start + 13, decoderConfig.end);
  if (!specific || specific.tag !== 0x05 || specific.end === specific.start) {
    throw new Error("AAC 缺少 AudioSpecificConfig");
  }
  const audioObjectType = data.u8(specific.start) >> 3;
  return {
    codec: `mp4a.40.${audioObjectType || 2}`,
    description: data.data.slice(specific.start, specific.end)
  };
}

function parseVideoEntry(data: Bytes, entry: Box): Omit<VideoTrack, keyof TrackBase> {
  if (!["avc1", "avc3"].includes(entry.type)) throw new Error(`暂不支持视频编码 ${entry.type}`);
  const width = data.u16(entry.payloadStart + 24);
  const height = data.u16(entry.payloadStart + 26);
  const children = boxesFrom(data, entry.payloadStart + 78, entry.end);
  const avcc = children.find((box) => box.type === "avcC");
  if (!avcc || avcc.payloadStart + 4 > avcc.end) throw new Error("H.264 缺少 avcC");
  const codec = `${entry.type}.${hexByte(data.u8(avcc.payloadStart + 1))}${hexByte(
    data.u8(avcc.payloadStart + 2)
  )}${hexByte(data.u8(avcc.payloadStart + 3))}`;
  return {
    kind: "video",
    width,
    height,
    codec,
    description: data.data.slice(avcc.payloadStart, avcc.end)
  };
}

function parseAudioEntry(data: Bytes, entry: Box): Omit<AudioTrack, keyof TrackBase> {
  if (entry.type !== "mp4a") throw new Error(`暂不支持音频编码 ${entry.type}`);
  const channels = data.u16(entry.payloadStart + 16);
  const sampleRate = data.u32(entry.payloadStart + 24) / 65536;
  const children = boxesFrom(data, entry.payloadStart + 28, entry.end);
  const esds = children.find((box) => box.type === "esds");
  if (!esds) throw new Error("AAC 缺少 esds");
  const config = parseAacConfig(data, esds);
  return {
    kind: "audio",
    sampleRate,
    channels: channels || 2,
    codec: config.codec,
    description: config.description
  };
}

function parseTrack(
  data: Bytes,
  trak: Box,
  id: number,
  warnings: string[]
): MediaTrack | null {
  const tkhd = firstBox(data, trak, "tkhd");
  const mdhd = descendants(data, trak, ["mdia", "mdhd"]);
  const hdlr = descendants(data, trak, ["mdia", "hdlr"]);
  const stbl = descendants(data, trak, ["mdia", "minf", "stbl"]);
  const stsd = stbl ? firstBox(data, stbl, "stsd") : undefined;
  if (!mdhd || !hdlr || !stbl || !stsd) return null;

  const mdhdData = fullBoxData(data, mdhd);
  const version = data.u8(mdhd.payloadStart);
  const timescale = data.u32(mdhdData + (version === 1 ? 16 : 8));
  const durationTicks = version === 1
    ? data.u64(mdhdData + 20)
    : data.u32(mdhdData + 12);
  const language = languageFromCode(data, mdhdData + (version === 1 ? 28 : 16));
  const handlerOffset = fullBoxData(data, hdlr);
  const handler = data.fourCC(handlerOffset + 4);
  const tkhdData = tkhd ? fullBoxData(data, tkhd) : 0;
  const tkhdVersion = tkhd ? data.u8(tkhd.payloadStart) : 0;
  const trackId = tkhd ? data.u32(tkhdData + (tkhdVersion === 1 ? 16 : 8)) : id;
  const stsdData = fullBoxData(data, stsd);
  const entryOffset = stsdData + 4;
  const entry = boxHeader(data, entryOffset, stsd.end);
  if (!entry || !timescale) return null;

  const samples = parseSamples(data, stbl);
  if (samples.length === 0) return null;
  if (handler !== "vide" && handler !== "soun") return null;
  try {
    const base: TrackBase = {
      id,
      trackId,
      timescale,
      durationTicks,
      language,
      samples,
      sampleCache: new Map()
    };
    if (handler === "vide") {
      return { ...base, ...parseVideoEntry(data, entry) } as VideoTrack;
    }
    return { ...base, ...parseAudioEntry(data, entry) } as AudioTrack;
  } catch (error) {
    warnings.push(`轨道 ${trackId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

interface Mp4ParseResult {
  tracks: MediaTrack[];
  warnings: string[];
}

function parseMoov(data: Bytes): Mp4ParseResult {
  const moov = boxHeader(data, 0, data.data.byteLength);
  if (!moov || moov.type !== "moov") throw new Error("未找到 moov 元数据");
  const tracks: MediaTrack[] = [];
  const warnings: string[] = [];
  const traks = childBoxes(data, moov).filter((box) => box.type === "trak");
  for (let index = 0; index < traks.length; index += 1) {
    const track = parseTrack(data, traks[index], index + 1, warnings);
    if (track) tracks.push(track);
  }
  return { tracks, warnings };
}

async function readTopLevelHeader(
  source: ByteRangeReader,
  offset: number
): Promise<{ type: string; size: number; headerSize: number }> {
  const header = await source.read(offset, Math.min(16, source.size - offset));
  if (header.byteLength < 8) throw new Error("MP4 顶层 box 被截断");
  const data = new Bytes(header);
  let size = data.u32(0);
  const type = data.fourCC(4);
  let headerSize = 8;
  if (size === 1) {
    if (header.byteLength < 16) throw new Error("MP4 64 位 box 被截断");
    size = data.u64(8);
    headerSize = 16;
  } else if (size === 0) {
    size = source.size - offset;
  }
  if (size < headerSize || offset + size > source.size) throw new Error("MP4 顶层 box 大小无效");
  return { type, size, headerSize };
}

export async function demuxMp4(source: ByteRangeReader): Promise<DemuxedMedia> {
  let moovBytes: Uint8Array | null = null;
  let offset = 0;
  while (offset < source.size) {
    const header = await readTopLevelHeader(source, offset);
    if (header.type === "moov") {
      if (header.size > 256 * 1024 * 1024) throw new Error("moov 元数据过大");
      moovBytes = await source.read(offset, header.size);
      break;
    }
    offset += header.size;
  }
  if (!moovBytes) throw new Error("视频中没有 moov 元数据");
  const parsed = parseMoov(new Bytes(moovBytes));
  const videoTracks = parsed.tracks.filter((track): track is VideoTrack => track.kind === "video");
  const audioTracks = parsed.tracks.filter((track): track is AudioTrack => track.kind === "audio");
  if (videoTracks.length === 0) {
    const detail = parsed.warnings.length ? `：${parsed.warnings.join("；")}` : "";
    throw new Error(`没有可解码的视频轨道${detail}`);
  }
  const durationSeconds = Math.max(
    ...parsed.tracks.map((track) => track.durationTicks / track.timescale),
    0
  );
  return {
    size: source.size,
    tracks: parsed.tracks,
    videoTracks,
    audioTracks,
    durationSeconds
  };
}

export async function readSampleData(
  source: ByteRangeReader,
  track: MediaTrack,
  sample: Sample
): Promise<Uint8Array> {
  const cached = track.sampleCache.get(sample.decodeIndex);
  if (cached) return cached;
  if (sample.offset + sample.size > source.size) throw new Error("样本超出文件范围");
  const bytes = await source.read(sample.offset, sample.size);
  track.sampleCache.set(sample.decodeIndex, bytes);
  if (track.sampleCache.size > 512) {
    const oldest = track.sampleCache.keys().next().value;
    if (oldest !== undefined) track.sampleCache.delete(oldest);
  }
  return bytes;
}
