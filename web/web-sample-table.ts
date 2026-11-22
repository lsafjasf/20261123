// Browser mirror of the sample-range resolver. No node: imports.
import { type Reader, fourcc, u32 } from '../src/io.ts';
import type { BoxNode } from '../src/types.ts';
import { findBoxes } from '../src/mp4.ts';

export interface SampleRange {
  index: number;
  offset: number;
  size: number;
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

async function readChunkTable(reader: Reader, stbl: BoxNode): Promise<number[]> {
  const stco = stbl.children?.find((n) => n.type === 'stco');
  if (stco) return readU32Table(reader, stco);
  const co64 = stbl.children?.find((n) => n.type === 'co64');
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
    return offsets;
  }
  throw new Error('缺少 stco/co64 块偏移表');
}

async function readSizes(reader: Reader, stbl: BoxNode): Promise<{ uniform: number; sizes: number[]; count: number }> {
  const stsz = stbl.children?.find((n) => n.type === 'stsz');
  if (!stsz) throw new Error('缺少 stsz 采样大小表');
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

async function readStsc(reader: Reader, stbl: BoxNode): Promise<{ firstChunk: number; samplesPerChunk: number }[]> {
  const stsc = stbl.children?.find((n) => n.type === 'stsc');
  if (!stsc) throw new Error('缺少 stsc 采样分块表');
  const count = u32(await reader.read(stsc.contentStart, stsc.contentStart + 4), 0);
  const buf = await reader.read(
    stsc.contentStart + 4,
    stsc.contentStart + 4 + count * 12,
  );
  const rows: { firstChunk: number; samplesPerChunk: number }[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({ firstChunk: u32(buf, i * 12), samplesPerChunk: u32(buf, i * 12 + 4) });
  }
  return rows;
}

export async function resolveSampleRanges(
  reader: Reader,
  stbl: BoxNode,
): Promise<SampleRange[]> {
  const offsets = await readChunkTable(reader, stbl);
  const sizeTable = await readSizes(reader, stbl);
  const rows = await readStsc(reader, stbl);
  const perChunkFor = (chunkIndex: number): number => {
    let current = rows[0]?.samplesPerChunk ?? 1;
    for (const row of rows) {
      if (row.firstChunk <= chunkIndex + 1) current = row.samplesPerChunk;
      else break;
    }
    return current;
  };
  const ranges: SampleRange[] = [];
  let sampleIndex = 0;
  for (let chunk = 0; chunk < offsets.length; chunk++) {
    const perChunk = perChunkFor(chunk);
    let cursor = offsets[chunk] ?? 0;
    for (let j = 0; j < perChunk; j++) {
      const size = sizeTable.uniform !== 0 ? sizeTable.uniform : sizeTable.sizes[sampleIndex] ?? 0;
      if (size <= 0) throw new Error(`采样 ${sampleIndex} 大小非法`);
      ranges.push({ index: sampleIndex, offset: cursor, size });
      cursor += size;
      sampleIndex++;
    }
  }
  return ranges;
}

export async function hashBytesWebCrypto(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export { fourcc, findBoxes };
