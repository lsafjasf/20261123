// 最小 ISO-BMFF(MP4) 解封装器：解析 moov/trak/mdat，
// 输出 WebCodecs 需要的 VideoDecoderConfig 与 EncodedVideoChunk 数据。
// 仅依赖标准 API（DataView），无第三方包。

export interface DemuxedVideo {
  config: VideoDecoderConfig;
  chunks: EncodedVideoChunkInit[];
  durationMicros: number;
}

interface Box {
  type: string;
  start: number;
  size: number;
  dataStart: number;
}

function readBoxes(buf: ArrayBuffer, start: number, end: number): Box[] {
  const view = new DataView(buf);
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = new TextDecoder().decode(new Uint8Array(buf, offset + 4, 4));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    boxes.push({ type, start: offset, size, dataStart: offset + header });
    offset += size;
  }
  return boxes;
}

function findBox(buf: ArrayBuffer, parent: Box, type: string): Box | null {
  for (const box of readBoxes(buf, parent.dataStart, parent.start + parent.size)) {
    if (box.type === type) return box;
  }
  return null;
}

function findPath(buf: ArrayBuffer, root: Box[], path: string[]): Box | null {
  let current: Box | null = null;
  let siblings = root;
  for (const type of path) {
    current = siblings.find((b) => b.type === type) ?? null;
    if (!current) return null;
    siblings = readBoxes(buf, current.dataStart, current.start + current.size);
  }
  return current;
}

export async function demuxMp4(buffer: ArrayBuffer): Promise<DemuxedVideo> {
  const rootBoxes = readBoxes(buffer, 0, buffer.byteLength);
  const moov = rootBoxes.find((b) => b.type === 'moov');
  const mdat = rootBoxes.find((b) => b.type === 'mdat');
  if (!moov) throw new Error('缺少 moov box（仅支持 faststart/已索引 MP4）');
  if (!mdat) throw new Error('缺少 mdat box');

  const trak = findPath(buffer, [moov], ['trak'])!;
  const tkhd = findBox(buffer, trak, 'tkhd')!;
  const mdia = findBox(buffer, trak, 'mdia')!;
  const hdlr = findBox(buffer, mdia, 'hdlr')!;
  const handler = new TextDecoder().decode(new Uint8Array(buffer, hdlr.dataStart + 8, 4));
  if (handler !== 'vide') throw new Error(`非视频轨道 handler: ${handler}`);

  const minf = findBox(buffer, mdia, 'minf')!;
  const stbl = findBox(buffer, minf, 'stbl')!;
  const stsd = findBox(buffer, stbl, 'stsd')!;
  const stts = findBox(buffer, stbl, 'stts')!;
  const stsc = findBox(buffer, stbl, 'stsc')!;
  const stsz = findBox(buffer, stbl, 'stsz')!;
  const stco = findBox(buffer, stbl, 'stco') ?? findBox(buffer, stbl, 'co64');
  if (!stco) throw new Error('缺少 stco/co64');

  const view = new DataView(buffer);
  const trackId = view.getUint32(tkhd.dataStart + (view.getUint8(tkhd.dataStart) === 1 ? 16 : 8));

  // --- 解码器配置：codec 字符串 + 分辨率 + avcC/hevC description ---
  const avc1 = readBoxes(buffer, stsd.dataStart + 8, stsd.start + stsd.size).find((b) => b.type === 'avc1' || b.type === 'hvc1' || b.type === 'hev1');
  if (!avc1) throw new Error('仅支持 AVC/HEVC 采样项');
  const width = view.getUint16(avc1.dataStart + 24);
  const height = view.getUint16(avc1.dataStart + 26);
  const inner = readBoxes(buffer, avc1.dataStart, avc1.start + avc1.size);
  const configBox = inner.find((b) => b.type === 'avcC' || b.type === 'hvcC');
  if (!configBox) throw new Error('缺少 avcC/hvcC');
  const description = new Uint8Array(buffer, configBox.dataStart, configBox.size - (configBox.dataStart - configBox.start));
  const codec = avc1.type === 'avc1'
    ? avcCodecString(buffer, configBox)
    : 'hvc1.1.6.L120.B0';

  // --- 采样表 ---
  const sampleSizes = readSizes(view, stsz);
  const chunkOffsets = readOffsets(view, stco);
  const samplesPerChunk = readStsc(view, stsc);
  const timing = readStts(view, stts);

  const chunks: EncodedVideoChunkInit[] = [];
  let sampleIndex = 0;
  let timestamp = 0;
  for (let chunkIdx = 0; chunkIdx < chunkOffsets.length; chunkIdx++) {
    const count = samplesPerChunk(chunkIdx);
    let offset = chunkOffsets[chunkIdx];
    for (let i = 0; i < count; i++) {
      const size = sampleSizes[sampleIndex];
      const data = new Uint8Array(buffer, offset, size);
      chunks.push({
        type: sampleIndex === 0 ? 'key' : 'delta',
        timestamp,
        duration: timing.deltaPer(sampleIndex),
        data: data.slice(),
      });
      timestamp += timing.deltaPer(sampleIndex);
      offset += size;
      sampleIndex++;
    }
  }

  const config: VideoDecoderConfig = {
    codec,
    codedWidth: width,
    codedHeight: height,
    description: configBox.type === 'avcC' ? description : undefined,
    optimizeForLatency: false,
  };

  return { config, chunks, durationMicros: timestamp };
}

function avcCodecString(buf: ArrayBuffer, box: Box): string {
  const view = new DataView(buf);
  // avcC: [version(1) profile(1) compat(1) level(1)...]
  const profile = view.getUint8(box.dataStart + 1);
  const compat = view.getUint8(box.dataStart + 2);
  const level = view.getUint8(box.dataStart + 3);
  const hex = (v: number): string => v.toString(16).padStart(2, '0');
  return `avc1.${hex(profile)}${hex(compat)}${hex(level)}`;
}

function readSizes(view: DataView, box: Box): number[] {
  const count = view.getUint32(box.dataStart + 8);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) sizes.push(view.getUint32(box.dataStart + 12 + i * 4));
  return sizes;
}

function readOffsets(view: DataView, box: Box): number[] {
  const count = view.getUint32(box.dataStart + 4);
  const offsets: number[] = [];
  if (box.type === 'co64') {
    for (let i = 0; i < count; i++) offsets.push(Number(view.getBigUint64(box.dataStart + 8 + i * 8)));
  } else {
    for (let i = 0; i < count; i++) offsets.push(view.getUint32(box.dataStart + 8 + i * 4));
  }
  return offsets;
}

function readStsc(view: DataView, box: Box): (chunkIndex: number) => number {
  const entryCount = view.getUint32(box.dataStart + 4);
  const entries: { firstChunk: number; samples: number }[] = [];
  for (let i = 0; i < entryCount; i++) {
    entries.push({
      firstChunk: view.getUint32(box.dataStart + 8 + i * 12),
      samples: view.getUint32(box.dataStart + 12 + i * 12),
    });
  }
  return (chunkIndex: number): number => {
    let current = entries[0]?.samples ?? 1;
    for (const entry of entries) {
      if (entry.firstChunk <= chunkIndex) current = entry.samples;
      else break;
    }
    return current;
  };
}

function readStts(view: DataView, box: Box): { deltaPer: (i: number) => number } {
  const entryCount = view.getUint32(box.dataStart + 4);
  const runs: { count: number; delta: number }[] = [];
  for (let i = 0; i < entryCount; i++) {
    runs.push({
      count: view.getUint32(box.dataStart + 8 + i * 8),
      delta: view.getUint32(box.dataStart + 12 + i * 8),
    });
  }
  const table: number[] = [];
  for (const run of runs) for (let i = 0; i < run.count; i++) table.push(run.delta);
  return { deltaPer: (i: number): number => table[Math.min(i, table.length - 1)] };
}
