import type { AudioMetadata } from './types.ts';

export interface ByteSource {
  size: number;
  fileName: string;
  read(offset: number, length: number): Promise<ArrayBuffer>;
  close?(): Promise<void>;
}

export interface WavHeader {
  metadata: AudioMetadata;
  dataOffset: number;
  dataLength: number;
  blockAlign: number;
  frameCount: number;
  encoding: 'pcm' | 'float';
}

export interface WavFrames {
  kind: 'frames';
  channels: Float32Array[];
  frameCount: number;
  startFrame: number;
  readBytes: number;
}

export function blobSource(blob: File): ByteSource {
  return {
    size: blob.size,
    fileName: blob.name,
    async read(offset: number, length: number): Promise<ArrayBuffer> {
      const end = Math.min(blob.size, offset + length);
      return blob.slice(offset, end).arrayBuffer();
    }
  };
}

function readAscii(view: DataView, offset: number, length: number): string {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += String.fromCharCode(view.getUint8(offset + index));
  }
  return result;
}

export async function readWavHeader(source: ByteSource): Promise<WavHeader> {
  const riffBytes = await source.read(0, Math.min(12, source.size));
  if (riffBytes.byteLength < 12) throw new Error('文件过短，不是有效的 WAV');
  const riff = new DataView(riffBytes);
  const riffId = readAscii(riff, 0, 4);
  const waveId = readAscii(riff, 8, 4);
  if ((riffId !== 'RIFF' && riffId !== 'RF64') || waveId !== 'WAVE') {
    throw new Error('仅支持 RIFF/WAVE 文件；其他容器请转为 WAV 或 AAC/ADTS');
  }

  let position = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;
  let formatTag = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (position + 8 <= source.size) {
    const headerBytes = await source.read(position, 8);
    if (headerBytes.byteLength < 8) break;
    const header = new DataView(headerBytes);
    const chunkId = readAscii(header, 0, 4);
    let chunkSize = header.getUint32(4, true);
    const bodyOffset = position + 8;
    if (chunkSize === 0xffffffff) chunkSize = source.size - bodyOffset;

    if (chunkId === 'fmt ') {
      const fmtBytes = await source.read(bodyOffset, Math.min(chunkSize, 64));
      if (fmtBytes.byteLength < 16) throw new Error('WAV fmt 块不完整');
      const fmt = new DataView(fmtBytes);
      formatTag = fmt.getUint16(0, true);
      channels = fmt.getUint16(2, true);
      sampleRate = fmt.getUint32(4, true);
      byteRate = fmt.getUint32(8, true);
      blockAlign = fmt.getUint16(12, true);
      bitsPerSample = fmt.getUint16(14, true);
      if (formatTag === 0xfffe && fmtBytes.byteLength >= 26) {
        formatTag = fmt.getUint16(24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = bodyOffset;
      dataLength = Math.min(chunkSize, source.size - bodyOffset);
      break;
    }
    position = bodyOffset + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0) throw new Error('WAV 缺少 data 块');
  if (!channels || !sampleRate || !blockAlign) throw new Error('WAV fmt 信息不完整');
  const encoding = formatTag === 3 ? 'float' : formatTag === 1 ? 'pcm' : null;
  if (!encoding) throw new Error(`暂不支持 WAV 编码格式 ${formatTag}`);
  if (encoding === 'float' && bitsPerSample !== 32) throw new Error('仅支持 32-bit float WAV');
  if (encoding === 'pcm' && ![8, 16, 24, 32].includes(bitsPerSample)) {
    throw new Error(`暂不支持 ${bitsPerSample}-bit PCM WAV`);
  }

  const frameCount = Math.floor(dataLength / blockAlign);
  const duration = frameCount / sampleRate;
  const metadata: AudioMetadata = {
    fileName: source.fileName,
    fileSize: source.size,
    format: `WAV ${encoding === 'float' ? 'Float32' : `PCM ${bitsPerSample}-bit`}`,
    sampleRate,
    channels,
    bitsPerSample,
    duration,
    decoder: 'wav-stream',
    streaming: true
  };
  void byteRate;
  return { metadata, dataOffset, dataLength, blockAlign, frameCount, encoding };
}

function decodeFrames(
  bytes: ArrayBuffer,
  header: WavHeader,
  startFrame: number
): WavFrames {
  const frameCount = Math.floor(bytes.byteLength / header.blockAlign);
  const view = new DataView(bytes);
  const channels = Array.from({ length: header.metadata.channels }, () => new Float32Array(frameCount));
  const sampleRate = header.metadata.sampleRate;
  void sampleRate;

  if (header.encoding === 'float' && header.metadata.bitsPerSample === 32) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channels.length; channel += 1) {
        channels[channel][frame] = view.getFloat32(frame * header.blockAlign + channel * 4, true);
      }
    }
  } else if (header.metadata.bitsPerSample === 16) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channels.length; channel += 1) {
        channels[channel][frame] = view.getInt16(frame * header.blockAlign + channel * 2, true) / 32768;
      }
    }
  } else if (header.metadata.bitsPerSample === 24) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channels.length; channel += 1) {
        const offset = frame * header.blockAlign + channel * 3;
        let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
        if (value & 0x800000) value -= 0x1000000;
        channels[channel][frame] = value / 8388608;
      }
    }
  } else if (header.metadata.bitsPerSample === 32) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channels.length; channel += 1) {
        channels[channel][frame] = view.getInt32(frame * header.blockAlign + channel * 4, true) / 2147483648;
      }
    }
  } else {
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channels.length; channel += 1) {
        const value = view.getUint8(frame * header.blockAlign + channel);
        channels[channel][frame] = (value - 128) / 128;
      }
    }
  }

  return { kind: 'frames', channels, frameCount, startFrame, readBytes: frameCount * header.blockAlign };
}

export async function* decodeWav(
  source: ByteSource,
  chunkBytes = 512 * 1024
): AsyncGenerator<WavHeader | WavFrames> {
  const header = await readWavHeader(source);
  yield header;
  const alignedChunk = Math.max(header.blockAlign, Math.floor(chunkBytes / header.blockAlign) * header.blockAlign);
  let cursor = header.dataOffset;
  const end = header.dataOffset + header.dataLength;
  let frame = 0;
  while (cursor < end) {
    const length = Math.min(alignedChunk, end - cursor);
    const bytes = await source.read(cursor, length);
    if (bytes.byteLength === 0) break;
    const decoded = decodeFrames(bytes, header, frame);
    yield decoded;
    frame += decoded.frameCount;
    cursor += bytes.byteLength;
  }
}
