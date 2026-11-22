// Parses sample tables (stbl) and computes byte-range hashes of coded samples.
// Only container tables are read; coded sample bytes are hashed, never decoded.

import { createHash } from 'node:crypto';
import { type Reader, fourcc, u32 } from './io.ts';
import type { BoxNode, HashManifest, MdatDigest, SampleDigest } from './types.ts';
import { findFirst, findBoxes } from './mp4.ts';

interface ChunkTable {
  offsets: number[];
}

interface SizeTable {
  uniform: number; // 0 means per-sample sizes
  sizes: number[];
  count: number;
}

interface SampleToChunkRow {
  firstChunk: number;
  samplesPerChunk: number;
}

async function readU32Table(reader: Reader, node: BoxNode): Promise<number[]> {
  const countBuf = await reader.read(node.contentStart, node.contentStart + 4);
  const count = u32(countBuf, 0);
  const dataStart = node.contentStart + 4;
  const buf = await reader.read(dataStart, dataStart + count * 4);
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(u32(buf, i * 4));
  return values;
}

async function readChunkTable(reader: Reader, stbl: BoxNode): Promise<ChunkTable> {
  const stco = findFirst([stbl], (n) => n.type === 'stco');
  if (stco) return { offsets: await readU32Table(reader, stco) };
  const co64 = findFirst([stbl], (n) => n.type === 'co64');
  if (co64) {
    const count = u32(await reader.read(co64.contentStart, co64.contentStart + 4), 0);
    const buf = await reader.read(
      co64.contentStart + 4,
      co64.contentStart + 4 + count * 8,
    );
    const offsets: number[] = [];
    for (let i = 0; i < count; i++) {
      let value = 0;
      for (let j = 0; j < 8; j++) value = value * 256 + (buf[i * 8 + j] ?? 0);
      offsets.push(value);
    }
    return { offsets };
  }
  throw new Error('缺少 stco/co64 块偏移表，无法定位采样数据');
}

async function readSizeTable(reader: Reader, stbl: BoxNode): Promise<SizeTable> {
  const stsz = stbl.children?.find((n) => n.type === 'stsz');
  if (stsz) {
    const head = await reader.read(stsz.contentStart, stsz.contentStart + 8);
    const uniform = u32(head, 0);
    const count = u32(head, 4);
    if (uniform !== 0) return { uniform, sizes: [], count };
    const sizeBuf = await reader.read(
      stsz.contentStart + 8,
      stsz.contentStart + 8 + count * 4,
    );
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) sizes.push(u32(sizeBuf, i * 4));
    return { uniform: 0, sizes, count };
  }
  const stz2 = stbl.children?.find((n) => n.type === 'stz2');
  if (stz2) {
    // Compact sample sizes: field size 4/8/16. Supported for completeness.
    const head = await reader.read(stz2.contentStart, stz2.contentStart + 8);
    const fieldSize = head[3] ?? 0;
    const count = u32(head, 4);
    const body = await reader.read(stz2.contentStart + 8, stz2.end);
    const sizes: number[] = [];
    let bitCursor = 0;
    const readBits = (bits: number): number => {
      let value = 0;
      for (let i = 0; i < bits; i++) {
        const byte = body[bitCursor >> 3] ?? 0;
        const bit = (byte >> (7 - (bitCursor & 7))) & 1;
        value = (value << 1) | bit;
        bitCursor++;
      }
      return value;
    };
    for (let i = 0; i < count; i++) sizes.push(readBits(fieldSize));
    return { uniform: 0, sizes, count };
  }
  throw new Error('缺少 stsz/stz2 采样大小表');
}

async function readSampleToChunk(reader: Reader, stbl: BoxNode): Promise<SampleToChunkRow[]> {
  const stsc = findFirst([stbl], (n) => n.type === 'stsc');
  if (!stsc) throw new Error('缺少 stsc 采样分块表');
  const count = u32(await reader.read(stsc.contentStart, stsc.contentStart + 4), 0);
  const buf = await reader.read(
    stsc.contentStart + 4,
    stsc.contentStart + 4 + count * 12,
  );
  const rows: SampleToChunkRow[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      firstChunk: u32(buf, i * 12),
      samplesPerChunk: u32(buf, i * 12 + 4),
    });
  }
  return rows;
}

function samplesPerChunkFor(rows: SampleToChunkRow[], chunkIndex: number): number {
  if (rows.length === 0) throw new Error('stsc 表为空');
  let current = rows[0]!.samplesPerChunk;
  for (const row of rows) {
    // first_chunk in the spec is 1-based; chunkIndex here is 0-based.
    if (row.firstChunk <= chunkIndex + 1) current = row.samplesPerChunk;
    else break;
  }
  return current;
}

export interface SampleRange {
  index: number;
  offset: number;
  size: number;
}

export async function resolveSampleRanges(
  reader: Reader,
  stbl: BoxNode,
): Promise<SampleRange[]> {
  const { offsets } = await readChunkTable(reader, stbl);
  const sizeTable = await readSizeTable(reader, stbl);
  const rows = await readSampleToChunk(reader, stbl);
  const ranges: SampleRange[] = [];
  let sampleIndex = 0;
  for (let chunk = 0; chunk < offsets.length; chunk++) {
    const perChunk = samplesPerChunkFor(rows, chunk);
    let cursor = offsets[chunk] ?? 0;
    for (let j = 0; j < perChunk; j++) {
      const size = sizeTable.uniform !== 0
        ? sizeTable.uniform
        : sizeTable.sizes[sampleIndex] ?? 0;
      if (size <= 0) throw new Error(`采样 ${sampleIndex} 大小非法`);
      ranges.push({ index: sampleIndex, offset: cursor, size });
      cursor += size;
      sampleIndex++;
    }
  }
  if (sizeTable.uniform === 0 && sampleIndex !== sizeTable.count) {
    throw new Error(`采样数不一致: 解析 ${sampleIndex}，stsz 声明 ${sizeTable.count}`);
  }
  return ranges;
}

async function hashRanges(reader: Reader, ranges: SampleRange[]): Promise<string> {
  const hash = createHash('sha256');
  for (const range of ranges) {
    const data = await reader.read(range.offset, range.offset + range.size);
    hash.update(data);
  }
  return hash.digest('hex');
}

async function trackInfo(
  reader: Reader,
  trak: BoxNode,
): Promise<{ trackId: number; handler: string; codec: string }> {
  const tkhd = findBoxes([trak], (n) => n.type === 'tkhd')[0];
  const hdlr = findBoxes([trak], (n) => n.type === 'hdlr')[0];
  const stsd = findBoxes([trak], (n) => n.type === 'stsd')[0];
  let trackId = 0;
  if (tkhd) {
    // tkhd v0 payload: creation(4)+modification(4)+track_ID(4) -> offset 12;
    // v1 uses 64-bit times (8+8), so track_ID lands at offset 20.
    const offset = tkhd.version === 1 ? 20 : 12;
    trackId = u32(
      await reader.read(tkhd.contentStart + offset, tkhd.contentStart + offset + 4),
      0,
    );
  }
  let handler = 'unknown';
  if (hdlr) {
    // hdlr content: version+flags(4), pre_defined(4), handler_type(4), ...
    handler = fourcc(await reader.read(hdlr.contentStart + 8, hdlr.contentStart + 12), 0);
  }
  // stsd is a FullBox: version+flags then u32 entry_count, then sample entries
  // whose four-char type is the codec. Read bytes directly since sample entries
  // are not modelled as containers.
  let codec = 'unknown';
  if (stsd) {
    // vf(4) + entry_count(4) + first sample entry size(4) -> codec fourcc at +12
    const entryType = await reader.read(stsd.contentStart + 12, stsd.contentStart + 16);
    codec = fourcc(entryType, 0);
  }
  return { trackId, handler, codec };
}

export async function buildManifest(
  reader: Reader,
  root: BoxNode[],
  fileLabel: string,
  withPerSample = false,
): Promise<HashManifest> {
  const tracks: SampleDigest[] = [];
  for (const trak of findBoxes(root, (n) => n.type === 'trak')) {
    const stbl = findBoxes([trak], (n) => n.type === 'stbl')[0];
    if (!stbl) continue;
    const ranges = await resolveSampleRanges(reader, stbl);
    const info = await trackInfo(reader, trak);
    const digest: SampleDigest = {
      trackId: info.trackId,
      handler: info.handler,
      codec: info.codec,
      sampleCount: ranges.length,
      samplesHash: await hashRanges(reader, ranges),
    };
    if (withPerSample) {
      digest.perSample = [];
      for (const range of ranges) {
        const data = await reader.read(range.offset, range.offset + range.size);
        digest.perSample.push({
          index: range.index,
          offset: range.offset,
          size: range.size,
          sha256: createHash('sha256').update(data).digest('hex'),
        });
      }
    }
    tracks.push(digest);
  }

  const mdats: MdatDigest[] = [];
  for (const mdat of findBoxes(root, (n) => n.type === 'mdat')) {
    const hash = createHash('sha256');
    const windowSize = 4 * 1024 * 1024;
    for (let pos = mdat.contentStart; pos < mdat.end; pos += windowSize) {
      const chunk = await reader.read(pos, Math.min(pos + windowSize, mdat.end));
      hash.update(chunk);
    }
    mdats.push({
      start: mdat.contentStart,
      end: mdat.end,
      size: mdat.end - mdat.contentStart,
      payloadHash: hash.digest('hex'),
    });
  }

  const fileHash = createHash('sha256');
  const windowSize = 4 * 1024 * 1024;
  for (let pos = 0; pos < reader.size; pos += windowSize) {
    fileHash.update(await reader.read(pos, Math.min(pos + windowSize, reader.size)));
  }

  return {
    version: 1,
    file: fileLabel,
    fileSize: reader.size,
    sha256At: fileHash.digest('hex'),
    mdats,
    tracks,
  };
}

export function manifestsEquivalent(a: HashManifest, b: HashManifest): boolean {
  if (a.mdats.length !== b.mdats.length) return false;
  for (let i = 0; i < a.mdats.length; i++) {
    if (a.mdats[i]?.payloadHash !== b.mdats[i]?.payloadHash) return false;
  }
  if (a.tracks.length !== b.tracks.length) return false;
  for (let i = 0; i < a.tracks.length; i++) {
    const ta = a.tracks[i];
    const tb = b.tracks[i];
    if (!ta || !tb) return false;
    if (ta.samplesHash !== tb.samplesHash) return false;
    if (ta.sampleCount !== tb.sampleCount) return false;
    if (ta.codec !== tb.codec) return false;
  }
  return true;
}

// Used by the browser verifier where node:crypto is unavailable.
export async function hashBytesWebCrypto(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

